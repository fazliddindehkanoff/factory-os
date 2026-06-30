/** REST routes. Auth on every /api route except login; RBAC checked per action. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { verifyInitData } from '../auth/telegram.js';
import { issueSession } from '../auth/session.js';
import { requireAuth, type AuthedRequest } from './auth.middleware.js';
import { hasPermission, getUserPermissionCodes } from '../rbac/rbac.js';
import { createRequest, sanitizeCustomFields } from '../services/request.service.js';
import { approveApproval, rejectApproval } from '../services/approval.service.js';
import { performAction, availableActions, statusLabelFor } from '../services/lifecycle.service.js';
import { receiveStock, issueStock } from '../services/warehouse.service.js';
import { hashPin, verifyPin } from '../auth/pin.js';
import { pinLockoutRemaining, recordPinFailure, clearPinFailures } from './rate-limit.js';
import { getDashboard } from '../services/dashboard.service.js';
import type { Notifier } from '../bot/bot.js';
import { approvedStageMessage, approvedFinalMessage, rejectedMessage, newRequestForApproverMessage } from '../bot/messages.js';
import { buildAdminRouter } from './admin.routes.js';

type Db = any;

/** Oversight permissions that let a user see requests beyond their own. */
const OVERSIGHT_PERMS = ['requests.edit', 'approvals.view', 'warehouse.view', 'procurement.view', 'finance.view', 'audit.view'];
/** A user may see a request if they own it or hold any oversight permission (H3/H4). */
async function userCanSeeRequest(db: Db, userId: string, reqRow: { requesterId: string }): Promise<boolean> {
  if (reqRow.requesterId === userId) return true;
  const codes = await getUserPermissionCodes(db, userId);
  return OVERSIGHT_PERMS.some((p) => codes.includes(p));
}

export interface RouterDeps {
  db: Db;
  botToken: string;
  sessionSecret: string;
  /** Local-preview login without Telegram. Must be false in production. */
  devAuth?: boolean;
  /** Optional Telegram notifier (set when a bot is configured). */
  notify?: Notifier;
  /** Serve the bundled design (public/) via the compat API instead of the React app. */
  serveDesign?: boolean;
  /** Rate limiting on /api (default on). Tests pass false to skip the auth/api limiters. */
  rateLimit?: boolean;
}

async function notifyRequester(db: Db, notify: Notifier | undefined, requestId: string, text: (reqNumber: string) => string): Promise<void> {
  if (!notify) return;
  try {
    const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, requestId));
    if (!reqRow) return;
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, reqRow.requesterId));
    if (u?.telegramId) notify(u.telegramId, text(reqRow.requestNumber));
  } catch {
    /* notifications are best-effort */
  }
}

/** Notify all users who hold the approver role of the current step. */
async function notifyStepApprovers(
  db: Db, notify: Notifier | undefined,
  requestId: string, currentStepId: string | null,
): Promise<void> {
  if (!notify || !currentStepId) return;
  try {
    const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, requestId));
    if (!reqRow) return;
    const [step] = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.id, currentStepId));
    if (!step?.approverRoleId) return;
    // Find all active user-role assignments for this role in this holding
    const assigns = await db
      .select({ userId: schema.userRoles.userId })
      .from(schema.userRoles)
      .where(and(
        eq(schema.userRoles.roleId, step.approverRoleId),
        eq(schema.userRoles.status, 'active'),
        eq(schema.userRoles.holdingId, reqRow.holdingId),
      ));
    const userIds = [...new Set(assigns.map((a: { userId: string }) => a.userId))] as string[];
    if (!userIds.length) return;
    const users = await db.select().from(schema.users).where(inArray(schema.users.id, userIds));
    const msg = newRequestForApproverMessage(reqRow.requestNumber, reqRow.title ?? '', step.stepName);
    for (const u of users) {
      if (u.telegramId && u.id !== reqRow.requesterId) notify(u.telegramId, msg);
    }
  } catch {
    /* best-effort */
  }
}

export function buildRouter(deps: RouterDeps): Router {
  const { db, botToken, sessionSecret, devAuth, notify } = deps;
  const r = Router();
  const auth = requireAuth(db, sessionSecret);

  // ── Login: verify Telegram initData → upsert user → issue session token ──
  r.post('/auth/telegram', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const initData = (req.body ?? {}).initData;
      const tgUser = typeof initData === 'string' ? verifyInitData(initData, botToken) : null;
      if (!tgUser) {
        res.status(401).json({ error: 'Invalid initData' });
        return;
      }
      let [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, tgUser.id));
      if (!u) {
        const fullName =
          [tgUser.firstName, tgUser.lastName].filter(Boolean).join(' ') || tgUser.username || 'User';
        [u] = await db
          .insert(schema.users)
          .values({ telegramId: tgUser.id, fullName, status: 'pending' })
          .returning();
      }
      const token = issueSession(u.id, sessionSecret, 7 * 24 * 3600);
      res.json({ token, user: { id: u.id, fullName: u.fullName, holdingId: u.holdingId } });
    } catch (e) {
      next(e);
    }
  });

  // ── Dev login (LOCAL ONLY): issue a session for a telegram id, no initData ──
  r.post('/auth/dev', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!devAuth) {
        // Stealth 404 (not 403) so the dev-only endpoint is invisible in prod.
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const telegramId = String((req.body ?? {}).telegramId ?? '').trim();
      if (!telegramId) {
        res.status(400).json({ error: 'telegramId required' });
        return;
      }
      let [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, telegramId));
      if (!u) {
        [u] = await db
          .insert(schema.users)
          .values({ telegramId, fullName: 'Dev User', status: 'active' })
          .returning();
      }
      const token = issueSession(u.id, sessionSecret, 7 * 24 * 3600);
      res.json({ token, user: { id: u.id, fullName: u.fullName, holdingId: u.holdingId } });
    } catch (e) {
      next(e);
    }
  });

  r.get('/me', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const permissions = u.holdingId ? await getUserPermissionCodes(db, u.id) : [];
      // Fetch full profile fields (phone, email, position) not carried in the session
      const [full] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
      // Fetch the user's active role name(s) for display
      let roleName: string | null = null;
      if (u.holdingId) {
        const roleRows = await db
          .select({ name: schema.roles.name })
          .from(schema.userRoles)
          .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
          .where(and(eq(schema.userRoles.userId, u.id), eq(schema.userRoles.status, 'active')));
        if (roleRows.length) roleName = roleRows.map((r0: { name: string }) => r0.name).join(', ');
      }
      const user = {
        ...u,
        phone: full?.phone ?? null,
        email: full?.email ?? null,
        position: full?.position ?? null,
        roleName,
      };
      res.json({ user, permissions });
    } catch (e) {
      next(e);
    }
  });

  // Tenant UI config — what the admin panel makes configurable. The Mini App reads
  // this to render labels/stages/theme from data instead of hardcoding them.
  r.get('/config', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      let settingsMap: Record<string, string> = {};
      let stages: { id: string; label: string; order: number }[] = [];
      let warehouses: { id: string; name: string }[] = [];
      let departments: { id: string; name: string }[] = [];
      let users: { id: string; fullName: string; departmentId: string | null }[] = [];
      if (u.holdingId) {
        const settingsRows = await db
          .select()
          .from(schema.settings)
          .where(eq(schema.settings.holdingId, u.holdingId));
        settingsMap = Object.fromEntries(
          settingsRows.map((s: { key: string; value: string | null }) => [s.key, s.value ?? '']),
        );
        const [wf] = await db
          .select()
          .from(schema.workflows)
          .where(and(eq(schema.workflows.holdingId, u.holdingId), eq(schema.workflows.isActive, true)));
        if (wf) {
          const steps = await db
            .select()
            .from(schema.workflowSteps)
            .where(eq(schema.workflowSteps.workflowId, wf.id));
          stages = steps
            .sort((a: { stepOrder: number }, b: { stepOrder: number }) => a.stepOrder - b.stepOrder)
            .map((s: { id: string; stepName: string; stepOrder: number }) => ({
              id: s.id,
              label: s.stepName,
              order: s.stepOrder,
            }));
        }
        warehouses = (
          await db.select().from(schema.warehouses).where(eq(schema.warehouses.holdingId, u.holdingId))
        )
          .filter((w: { status: string | null }) => w.status !== 'inactive')
          .map((w: { id: string; name: string }) => ({ id: w.id, name: w.name }));
        departments = (
          await db.select().from(schema.departments).where(eq(schema.departments.holdingId, u.holdingId))
        )
          .filter((d: { status: string | null }) => d.status !== 'inactive')
          .map((d: { id: string; name: string }) => ({ id: d.id, name: d.name }));
        // Users for department-head selection
        const userRows = await db
          .select({ id: schema.users.id, fullName: schema.users.fullName })
          .from(schema.users)
          .where(and(eq(schema.users.holdingId, u.holdingId), eq(schema.users.status, 'active')));
        users = userRows.map((u0: { id: string; fullName: string }) => ({ id: u0.id, fullName: u0.fullName, departmentId: null }));
      }
      res.json({
        factoryName: settingsMap.factory_name || 'Factory OS',
        currency: settingsMap.currency || 'UZS',
        theme: settingsMap.theme || 'dark',
        warehouses,
        departments,
        users,
        requestTypes: [
          { code: 'material_request', label: 'Материалы' },
          { code: 'repair_request', label: 'Ремонт' },
          { code: 'service_request', label: 'Услуги' },
        ],
        urgencies: [
          { code: 'standard', label: 'Стандарт' },
          { code: 'express', label: 'Экспресс' },
          { code: 'urgent', label: 'Срочно' },
        ],
        statuses: {
          draft: 'Черновик',
          pending_approval: 'На согласовании',
          approved: 'Согласована',
          rejected: 'Отклонена',
        },
        stages,
      });
    } catch (e) {
      next(e);
    }
  });

  r.get('/dashboard', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      res.json(await getDashboard(db, u.id, u.holdingId));
    } catch (e) {
      next(e);
    }
  });

  // Form schema for a screen (e.g. 'request_create') — the Mini App renders the
  // form from this instead of hardcoding fields. Admin-editable via /api/admin/form-fields.
  r.get('/form/:screen', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId) {
        res.json({ screen: req.params.screen, fields: [] });
        return;
      }
      const rows = await db
        .select()
        .from(schema.formFields)
        .where(and(eq(schema.formFields.holdingId, u.holdingId), eq(schema.formFields.screen, req.params.screen as string)));
      const fields = rows
        .filter((f: { enabled: boolean }) => f.enabled)
        .sort(
          (a: { stepGroup: number; orderIndex: number }, b: { stepGroup: number; orderIndex: number }) =>
            a.stepGroup - b.stepGroup || a.orderIndex - b.orderIndex,
        )
        .map(
          (f: {
            fieldKey: string;
            label: string;
            fieldType: string;
            system: boolean;
            required: boolean;
            placeholder: string | null;
            options: unknown;
            stepGroup: number;
          }) => ({
            key: f.fieldKey,
            label: f.label,
            type: f.fieldType,
            system: f.system,
            required: f.required,
            placeholder: f.placeholder,
            options: f.options ?? [],
            step: f.stepGroup,
          }),
        );
      res.json({ screen: req.params.screen, fields });
    } catch (e) {
      next(e);
    }
  });

  r.get('/requests', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId) {
        res.json([]);
        return;
      }
      if (!(await hasPermission(db, u.id, 'requests.view', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      // Visibility: a pure requester/observer (no oversight permission) sees only
      // their OWN requests; oversight roles see the whole holding.
      const codes = await getUserPermissionCodes(db, u.id);
      const seeAll = ['requests.edit', 'approvals.view', 'warehouse.view', 'procurement.view', 'finance.view', 'audit.view'].some(
        (p) => codes.includes(p),
      );
      const visScope = seeAll
        ? eq(schema.requests.holdingId, u.holdingId)
        : and(eq(schema.requests.holdingId, u.holdingId), eq(schema.requests.requesterId, u.id));
      const rows = await db
        .select()
        .from(schema.requests)
        .where(visScope)
        .orderBy(desc(schema.requests.createdAt))
        .limit(limit + 1) // fetch one extra to detect "has more"
        .offset(offset);
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      res.json({ items: rows, hasMore, offset, limit });
    } catch (e) {
      next(e);
    }
  });

  r.post('/requests', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId) {
        res.status(400).json({ error: 'Пользователь не привязан к организации' });
        return;
      }
      if (!(await hasPermission(db, u.id, 'requests.create', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const body = req.body ?? {};
      const PRIORITIES = ['low', 'normal', 'high', 'urgent', 'critical'];
      const customFields = await sanitizeCustomFields(db, u.holdingId, 'request_create', body.customFields);
      const result = await createRequest(db, {
        holdingId: u.holdingId,
        requesterId: u.id,
        factoryId: body.factoryId ?? null,
        departmentId: body.departmentId ?? null,
        requestType: body.requestType,
        priority: PRIORITIES.includes(body.priority) ? body.priority : undefined,
        warehouseName: body.warehouseName ?? null,
        title: body.title,
        description: body.description,
        neededDate: body.neededDate ? new Date(body.neededDate) : null,
        customFields,
        items: Array.isArray(body.items) ? body.items : [],
      });
      // Notify approvers of the first step
      notifyStepApprovers(db, notify, result.id, result.currentStepId).catch(() => {});
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  // Inbox: requests awaiting THIS user — i.e. where they have ≥1 available lifecycle
  // action right now (the same status × permission × scope guard the detail uses).
  // Declared before '/requests/:id' so 'inbox' is not captured as an id.
  //
  // Optimized: pre-filter requests by currentStepId matching the user's roles,
  // so we only compute availableActions for candidates (not all 100 requests).
  r.get('/requests/inbox', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId) {
        res.json([]);
        return;
      }

      // 1. Find user's active role IDs
      const roleRows = await db
        .select({ roleId: schema.userRoles.roleId })
        .from(schema.userRoles)
        .where(and(eq(schema.userRoles.userId, u.id), eq(schema.userRoles.status, 'active')));
      const roleIds = roleRows.map((r0: { roleId: string }) => r0.roleId);
      if (!roleIds.length) {
        res.json([]);
        return;
      }

      // 2. Find workflow steps these roles can act on
      // 3. Load only in-flight requests in this holding with a currentStepId
      const rows = await db
        .select()
        .from(schema.requests)
        .where(
          and(
            eq(schema.requests.holdingId, u.holdingId),
            notInArray(schema.requests.status, ['closed', 'rejected', 'draft', 'approved']),
          ),
        )
        .orderBy(desc(schema.requests.createdAt))
        .limit(100);

      // 4. Only check availableActions for requests on a step this user might handle
      const inbox: unknown[] = [];
      for (const r0 of rows) {
        if (!r0.currentStepId) continue;
        // Quick pre-check: the step must exist (role-based or permission-based)
        const actions = await availableActions(db, r0, u.id);
        if (actions.length > 0) {
          inbox.push({
            id: r0.id,
            requestNumber: r0.requestNumber,
            title: r0.title,
            status: r0.status,
            statusLabel: await statusLabelFor(db, r0),
            estimatedAmount: r0.estimatedAmount,
            actions,
          });
        }
      }
      res.json(inbox);
    } catch (e) {
      next(e);
    }
  });

  r.get('/requests/:id', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const [reqRow] = await db
        .select()
        .from(schema.requests)
        .where(eq(schema.requests.id, (req.params.id as string)));
      if (!reqRow) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (reqRow.holdingId !== u.holdingId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      // Visibility: own-or-oversight; 404 (not 403) so a foreign id doesn't reveal existence. (H3)
      if (!(await userCanSeeRequest(db, u.id, reqRow))) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const items = await db
        .select()
        .from(schema.requestItems)
        .where(eq(schema.requestItems.requestId, reqRow.id));
      const approvals = await db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.requestId, reqRow.id));
      const statusHistory = await db
        .select()
        .from(schema.requestStatusHistory)
        .where(eq(schema.requestStatusHistory.requestId, reqRow.id))
        .orderBy(schema.requestStatusHistory.createdAt);
      // Enrich each history row with WHO acted (name + their role) for the timeline.
      const actorIds = [...new Set(statusHistory.map((h: { changedBy: string | null }) => h.changedBy).filter(Boolean))] as string[];
      const actorMap = new Map<string, { name: string; role: string | null }>();
      if (actorIds.length) {
        const us = await db
          .select({ id: schema.users.id, fullName: schema.users.fullName })
          .from(schema.users)
          .where(inArray(schema.users.id, actorIds));
        const urs = await db
          .select({ userId: schema.userRoles.userId, roleName: schema.roles.name })
          .from(schema.userRoles)
          .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
          .where(and(inArray(schema.userRoles.userId, actorIds), eq(schema.userRoles.status, 'active')));
        const roleByUser = new Map<string, string>();
        for (const r of urs) if (!roleByUser.has(r.userId)) roleByUser.set(r.userId, r.roleName);
        for (const u of us) actorMap.set(u.id, { name: u.fullName, role: roleByUser.get(u.id) ?? null });
      }
      const statusHistoryOut = statusHistory.map((h: { changedBy: string | null }) => ({
        ...h,
        changedByName: h.changedBy ? actorMap.get(h.changedBy)?.name ?? null : null,
        changedByRole: h.changedBy ? actorMap.get(h.changedBy)?.role ?? null : null,
      }));
      const quotations = await db
        .select()
        .from(schema.quotations)
        .where(eq(schema.quotations.requestId, reqRow.id))
        .orderBy(schema.quotations.createdAt);
      const actions = await availableActions(db, reqRow, u.id);
      // Build workflow timeline: all steps with completed/current/future state
      let workflowTimeline: { stepName: string; stepKind: string; state: 'completed' | 'current' | 'future' }[] = [];
      if (reqRow.workflowId) {
        const allSteps = await db
          .select()
          .from(schema.workflowSteps)
          .where(eq(schema.workflowSteps.workflowId, reqRow.workflowId));
        const sorted = allSteps
          .filter((s: { enabled: boolean }) => s.enabled !== false)
          .sort((a: { stepOrder: number }, b: { stepOrder: number }) => a.stepOrder - b.stepOrder);
        let foundCurrent = false;
        for (const s of sorted) {
          let state: 'completed' | 'current' | 'future';
          if (reqRow.currentStepId === s.id) {
            state = 'current';
            foundCurrent = true;
          } else if (!foundCurrent && reqRow.currentStepId) {
            state = 'completed';
          } else if (!reqRow.currentStepId) {
            // Terminal state (approved/rejected/closed) — all steps are completed
            state = 'completed';
          } else {
            state = 'future';
          }
          workflowTimeline.push({ stepName: s.stepName, stepKind: s.stepKind, state });
        }
      }
      res.json({
        ...reqRow,
        statusLabel: await statusLabelFor(db, reqRow),
        items,
        approvals,
        statusHistory: statusHistoryOut,
        quotations,
        actions,
        workflowTimeline,
      });
    } catch (e) {
      next(e);
    }
  });

  // Lifecycle transition — guarded by status × permission × scope × PIN/comment,
  // writes status history + DNA audit log atomically.
  r.post('/requests/:id/action', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const body = req.body ?? {};
      const result = await performAction(db, {
        requestId: req.params.id as string,
        action: String(body.action ?? ''),
        actor: { id: u.id, holdingId: u.holdingId },
        pin: body.pin,
        comment: body.comment,
        amount: body.amount,
        supplierName: body.supplierName,
        supplierId: body.supplierId,
        leadTime: body.leadTime,
        quotationId: body.quotationId,
      });
      // Notify next step's approvers + notify requester about progress
      if (result.currentStepId) {
        notifyStepApprovers(db, notify, result.id, result.currentStepId).catch(() => {});
      }
      if (result.status === 'approved') {
        notifyRequester(db, notify, result.id, (rn) => approvedFinalMessage(rn));
      } else if (result.status === 'rejected') {
        notifyRequester(db, notify, result.id, (rn) => rejectedMessage(rn, String(body.comment ?? '').trim()));
      } else {
        notifyRequester(db, notify, result.id, (rn) => approvedStageMessage(rn));
      }
      res.json({ ...result, statusLabel: await statusLabelFor(db, result) });
    } catch (e) {
      next(e);
    }
  });

  // Set / change the current user's sign-off PIN.
  r.put('/me/profile', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const body = req.body ?? {};
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.fullName !== undefined) {
        const name = String(body.fullName).trim();
        if (!name) { res.status(400).json({ error: 'Имя не может быть пустым' }); return; }
        patch.fullName = name;
      }
      if (body.phone !== undefined) patch.phone = String(body.phone).trim().slice(0, 20) || null;
      if (body.email !== undefined) patch.email = String(body.email).trim().slice(0, 100) || null;
      if (body.position !== undefined) patch.position = String(body.position).trim().slice(0, 100) || null;
      const [updated] = await db.update(schema.users).set(patch).where(eq(schema.users.id, u.id)).returning();
      res.json({ id: updated.id, fullName: updated.fullName, phone: updated.phone, email: updated.email, position: updated.position });
    } catch (e) {
      next(e);
    }
  });

  r.post('/me/pin', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const pin = String((req.body ?? {}).pin ?? '').trim();
      if (!/^\d{4,8}$/.test(pin)) {
        res.status(400).json({ error: 'PIN — 4–8 цифр' });
        return;
      }
      await db.update(schema.users).set({ pinHash: hashPin(pin) }).where(eq(schema.users.id, u.id));
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.post('/approvals/:id/approve', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const body = req.body ?? {};
      // Approval is a sensitive sign-off: require the permission AND a valid PIN before
      // anything is written (the signature is only inserted after this passes). (C1 fix)
      if (!u.holdingId || !(await hasPermission(db, u.id, 'approvals.approve', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Недостаточно прав для согласования' });
        return;
      }
      if (pinLockoutRemaining(u.id) > 0) {
        res.status(429).json({ error: 'Слишком много попыток PIN — попробуйте позже' });
        return;
      }
      const [full] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
      if (!full?.pinHash) {
        res.status(403).json({ error: 'PIN не задан — установите его в профиле' });
        return;
      }
      if (!verifyPin(String(body.pin ?? ''), full.pinHash)) {
        recordPinFailure(u.id);
        res.status(403).json({ error: 'Неверный PIN' });
        return;
      }
      clearPinFailures(u.id);
      const result = await approveApproval(db, {
        approvalId: (req.params.id as string),
        actorUserId: u.id,
        comment: body.comment,
        inStock: body.inStock,
      });
      await notifyRequester(db, notify, result.requestId, (rn) =>
        result.status === 'approved' ? approvedFinalMessage(rn) : approvedStageMessage(rn),
      );
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  r.post('/approvals/:id/reject', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const body = req.body ?? {};
      if (!u.holdingId || !(await hasPermission(db, u.id, 'approvals.reject', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Недостаточно прав для отклонения' });
        return;
      }
      const result = await rejectApproval(db, {
        approvalId: (req.params.id as string),
        actorUserId: u.id,
        comment: body.comment ?? '',
      });
      await notifyRequester(db, notify, result.requestId, (rn) =>
        rejectedMessage(rn, String(body.comment ?? '').trim()),
      );
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // ── Edit request (6.1.3: requests.edit) ──────────────────────────────────
  r.put('/requests/:id', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const [reqRow] = await db
        .select()
        .from(schema.requests)
        .where(eq(schema.requests.id, (req.params.id as string)));
      if (!reqRow) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (reqRow.holdingId !== u.holdingId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      // Only the author OR someone with requests.edit can update
      const isAuthor = reqRow.requesterId === u.id;
      if (!isAuthor && !(await hasPermission(db, u.id, 'requests.edit', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      // Only editable in early stages
      const EDITABLE = ['draft', 'pending_approval'];
      if (!EDITABLE.includes(reqRow.status)) {
        res.status(409).json({ error: 'Заявку нельзя редактировать на этом этапе' });
        return;
      }
      const body = req.body ?? {};
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.title !== undefined) patch.title = String(body.title).trim() || null;
      if (body.description !== undefined) patch.description = String(body.description).trim() || null;
      if (body.priority !== undefined) {
        const PRIORITIES = ['low', 'normal', 'high', 'urgent', 'critical'];
        if (PRIORITIES.includes(body.priority)) patch.priority = body.priority;
      }
      if (body.warehouseName !== undefined) patch.warehouseName = String(body.warehouseName).trim() || null;
      if (body.neededDate !== undefined) patch.neededDate = body.neededDate ? new Date(body.neededDate) : null;
      const [updated] = await db
        .update(schema.requests)
        .set(patch)
        .where(eq(schema.requests.id, reqRow.id))
        .returning();
      await db.insert(schema.auditLogs).values({
        holdingId: reqRow.holdingId,
        userId: u.id,
        action: 'request.edited',
        module: 'requests',
        entityType: 'request',
        entityId: reqRow.id,
        oldValue: { title: reqRow.title, description: reqRow.description },
        newValue: patch,
        source: 'api',
      });
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  // ── Warehouse API (6.1.9) ──────────────────────────────────────────────
  r.get('/warehouse/balances', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId) {
        res.json([]);
        return;
      }
      if (!(await hasPermission(db, u.id, 'warehouse.view', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const rows = await db
        .select({
          id: schema.stockBalances.id,
          materialId: schema.stockBalances.materialId,
          warehouseId: schema.stockBalances.warehouseId,
          availableQty: schema.stockBalances.availableQty,
          reservedQty: schema.stockBalances.reservedQty,
          minQty: schema.stockBalances.minQty,
          materialName: schema.materials.name,
          materialUnit: schema.materials.defaultUnit,
          warehouseName: schema.warehouses.name,
        })
        .from(schema.stockBalances)
        .innerJoin(schema.materials, eq(schema.materials.id, schema.stockBalances.materialId))
        .leftJoin(schema.warehouses, eq(schema.warehouses.id, schema.stockBalances.warehouseId))
        .where(eq(schema.stockBalances.holdingId, u.holdingId));
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  r.post('/warehouse/receive', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermission(db, u.id, 'warehouse.receive', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const body = req.body ?? {};
      const result = await receiveStock(db, {
        holdingId: u.holdingId,
        materialId: String(body.materialId ?? ''),
        warehouseId: body.warehouseId ?? null,
        quantity: Number(body.quantity) || 0,
        performedBy: u.id,
        requestId: body.requestId ?? null,
        reason: body.reason ?? null,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  r.post('/warehouse/issue', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermission(db, u.id, 'warehouse.issue', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const body = req.body ?? {};
      const result = await issueStock(db, {
        holdingId: u.holdingId,
        materialId: String(body.materialId ?? ''),
        warehouseId: body.warehouseId ?? null,
        quantity: Number(body.quantity) || 0,
        performedBy: u.id,
        requestId: body.requestId ?? null,
        reason: body.reason ?? null,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  r.get('/warehouse/movements', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermission(db, u.id, 'warehouse.view', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const rows = await db
        .select({
          id: schema.stockMovements.id,
          holdingId: schema.stockMovements.holdingId,
          warehouseId: schema.stockMovements.warehouseId,
          materialId: schema.stockMovements.materialId,
          movementType: schema.stockMovements.movementType,
          quantity: schema.stockMovements.quantity,
          requestId: schema.stockMovements.requestId,
          performedBy: schema.stockMovements.performedBy,
          reason: schema.stockMovements.reason,
          source: schema.stockMovements.source,
          createdAt: schema.stockMovements.createdAt,
          materialName: schema.materials.name,
          materialUnit: schema.materials.defaultUnit,
        })
        .from(schema.stockMovements)
        .leftJoin(schema.materials, eq(schema.materials.id, schema.stockMovements.materialId))
        .where(eq(schema.stockMovements.holdingId, u.holdingId))
        .orderBy(desc(schema.stockMovements.createdAt))
        .limit(100);
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // ── Attachments API (6.1.10) ────────────────────────────────────────────
  const MAX_ATTACH_SIZE = 2 * 1024 * 1024; // 2 MB

  r.get('/requests/:id/attachments', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, (req.params.id as string)));
      if (!reqRow || reqRow.holdingId !== u.holdingId) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (!(await userCanSeeRequest(db, u.id, reqRow))) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const rows = await db.select({
        id: schema.attachments.id,
        filename: schema.attachments.filename,
        mime: schema.attachments.mime,
        size: schema.attachments.size,
        createdAt: schema.attachments.createdAt,
      }).from(schema.attachments).where(eq(schema.attachments.requestId, reqRow.id));
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // ── Suppliers (procurement directory, holding-scoped) ─────────────────────
  r.get('/suppliers', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermission(db, u.id, 'suppliers.view', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const rows = await db
        .select()
        .from(schema.suppliers)
        .where(and(eq(schema.suppliers.holdingId, u.holdingId), eq(schema.suppliers.status, 'active')))
        .orderBy(desc(schema.suppliers.createdAt));
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  r.post('/suppliers', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermission(db, u.id, 'suppliers.manage', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const body = req.body ?? {};
      const name = String(body.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Название поставщика обязательно' });
        return;
      }
      const clean = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
      const [row] = await db
        .insert(schema.suppliers)
        .values({
          holdingId: u.holdingId,
          name,
          inn: clean(body.inn),
          phone: clean(body.phone),
          email: clean(body.email),
          contactPerson: clean(body.contactPerson),
          category: clean(body.category),
          note: clean(body.note),
        })
        .returning();
      await db.insert(schema.auditLogs).values({
        holdingId: u.holdingId,
        userId: u.id,
        action: 'supplier.created',
        module: 'procurement',
        entityType: 'supplier',
        entityId: row.id,
        newValue: { name },
        source: 'api',
      });
      res.status(201).json(row);
    } catch (e) {
      next(e);
    }
  });

  r.patch('/suppliers/:id', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermission(db, u.id, 'suppliers.manage', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const id = req.params.id as string;
      const [existing] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
      if (!existing || existing.holdingId !== u.holdingId) {
        res.status(404).json({ error: 'Поставщик не найден' });
        return;
      }
      const body = req.body ?? {};
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const f of ['name', 'inn', 'phone', 'email', 'contactPerson', 'category', 'note'] as const) {
        if (body[f] !== undefined) patch[f] = body[f] == null ? null : String(body[f]).trim();
      }
      if (patch.name === '') {
        res.status(400).json({ error: 'Название поставщика не может быть пустым' });
        return;
      }
      const [row] = await db.update(schema.suppliers).set(patch).where(eq(schema.suppliers.id, id)).returning();
      await db.insert(schema.auditLogs).values({
        holdingId: u.holdingId,
        userId: u.id,
        action: 'supplier.updated',
        module: 'procurement',
        entityType: 'supplier',
        entityId: id,
        newValue: patch,
        source: 'api',
      });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  r.delete('/suppliers/:id', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermission(db, u.id, 'suppliers.manage', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const id = req.params.id as string;
      const [existing] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
      if (!existing || existing.holdingId !== u.holdingId) {
        res.status(404).json({ error: 'Поставщик не найден' });
        return;
      }
      // Archive, never hard-delete — quotations may reference this supplier.
      await db.update(schema.suppliers).set({ status: 'archived', updatedAt: new Date() }).where(eq(schema.suppliers.id, id));
      await db.insert(schema.auditLogs).values({
        holdingId: u.holdingId,
        userId: u.id,
        action: 'supplier.archived',
        module: 'procurement',
        entityType: 'supplier',
        entityId: id,
        oldValue: { status: existing.status },
        newValue: { status: 'archived' },
        source: 'api',
      });
      res.json({ ok: true, archived: true });
    } catch (e) {
      next(e);
    }
  });

  // ── Procurement queue: requests currently sitting on a procurement step ───
  r.get('/procurement/queue', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermission(db, u.id, 'procurement.view', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const rows = await db
        .select()
        .from(schema.requests)
        .where(and(eq(schema.requests.holdingId, u.holdingId), eq(schema.requests.status, 'procurement')))
        .orderBy(desc(schema.requests.createdAt));
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  r.post('/requests/:id/attachments', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId) {
        res.status(400).json({ error: 'Нет организации' });
        return;
      }
      const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, (req.params.id as string)));
      if (!reqRow || reqRow.holdingId !== u.holdingId) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      // Visibility + upload authority: must see the request, and own it OR hold the upload perm. (H4)
      if (!(await userCanSeeRequest(db, u.id, reqRow))) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (reqRow.requesterId !== u.id && !(await hasPermission(db, u.id, 'requests.upload_attachment', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Недостаточно прав для загрузки вложения' });
        return;
      }
      const body = req.body ?? {};
      if (!body.filename || !body.dataBase64) {
        res.status(400).json({ error: 'filename и dataBase64 обязательны' });
        return;
      }
      const buf = Buffer.from(String(body.dataBase64), 'base64');
      if (!buf.length) {
        res.status(400).json({ error: 'Пустой файл' });
        return;
      }
      if (buf.length > MAX_ATTACH_SIZE) {
        res.status(413).json({ error: 'Файл больше 2 МБ' });
        return;
      }
      const [att] = await db
        .insert(schema.attachments)
        .values({
          holdingId: u.holdingId,
          requestId: reqRow.id,
          uploaderId: u.id,
          filename: String(body.filename).slice(0, 200),
          mime: body.mime || 'application/octet-stream',
          size: buf.length,
          dataBase64: String(body.dataBase64),
        })
        .returning();
      await db.insert(schema.auditLogs).values({
        holdingId: u.holdingId,
        factoryId: reqRow.factoryId,
        userId: u.id,
        action: 'attachment.uploaded',
        module: 'requests',
        entityType: 'attachment',
        entityId: att.id,
        newValue: { filename: att.filename, size: att.size },
        source: 'api',
      });
      res.status(201).json({ id: att.id, filename: att.filename, size: att.size });
    } catch (e) {
      next(e);
    }
  });

  r.get('/attachments/:id', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const [att] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, (req.params.id as string)));
      if (!att || att.holdingId !== u.holdingId) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const [attReq] = await db.select().from(schema.requests).where(eq(schema.requests.id, att.requestId));
      if (!attReq || !(await userCanSeeRequest(db, u.id, attReq))) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const buf = Buffer.from(att.dataBase64 || '', 'base64');
      const SAFE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      const inlineOk = SAFE.includes(att.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', inlineOk ? att.mime : 'application/octet-stream');
      res.setHeader('Content-Disposition', `${inlineOk ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.filename)}"`);
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  r.delete('/attachments/:id', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const [att] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, (req.params.id as string)));
      if (!att || att.holdingId !== u.holdingId) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      // Only uploader or someone with requests.edit can delete
      if (att.uploaderId !== u.id && !(await hasPermission(db, u.id, 'requests.edit', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      await db.delete(schema.attachments).where(eq(schema.attachments.id, att.id));
      await db.insert(schema.auditLogs).values({
        holdingId: u.holdingId,
        factoryId: null,
        userId: u.id,
        action: 'attachment.deleted',
        module: 'requests',
        entityType: 'attachment',
        entityId: att.id,
        oldValue: { filename: att.filename },
        source: 'api',
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Constructor / admin API.
  r.use('/admin', buildAdminRouter(db, auth));

  return r;
}
