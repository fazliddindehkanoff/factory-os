/** REST routes. Auth on every /api route except login; RBAC checked per action. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { verifyInitData } from '../auth/telegram.js';
import { issueSession } from '../auth/session.js';
import { requireAuth, type AuthedRequest } from './auth.middleware.js';
import { hasPermission, getUserPermissionCodes } from '../rbac/rbac.js';
import { createRequest, sanitizeCustomFields } from '../services/request.service.js';
import { approveApproval, rejectApproval } from '../services/approval.service.js';
import { performAction, availableActions } from '../services/lifecycle.service.js';
import { STATUS_LABELS } from '../workflow/lifecycle.js';
import { hashPin } from '../auth/pin.js';
import { getDashboard } from '../services/dashboard.service.js';
import type { Notifier } from '../bot/bot.js';
import { approvedStageMessage, approvedFinalMessage, rejectedMessage } from '../bot/messages.js';
import { buildAdminRouter } from './admin.routes.js';

type Db = any;

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
          .values({ telegramId: tgUser.id, fullName, status: 'active' })
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
        res.status(403).json({ error: 'Disabled' });
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
      res.json({ user: u, permissions });
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
      }
      res.json({
        factoryName: settingsMap.factory_name || 'Factory OS',
        currency: settingsMap.currency || 'UZS',
        theme: settingsMap.theme || 'dark',
        warehouses,
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
      const rows = await db
        .select()
        .from(schema.requests)
        .where(eq(schema.requests.holdingId, u.holdingId))
        .orderBy(desc(schema.requests.createdAt))
        .limit(50);
      res.json(rows);
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
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  // Inbox: requests awaiting THIS user — i.e. where they have ≥1 available lifecycle
  // action right now (the same status × permission × scope guard the detail uses).
  // Declared before '/requests/:id' so 'inbox' is not captured as an id.
  r.get('/requests/inbox', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId) {
        res.json([]);
        return;
      }
      const rows = await db
        .select()
        .from(schema.requests)
        .where(eq(schema.requests.holdingId, u.holdingId))
        .orderBy(desc(schema.requests.createdAt))
        .limit(100);
      const inbox: unknown[] = [];
      for (const r0 of rows) {
        if (r0.status === 'closed' || r0.status === 'rejected' || r0.status === 'draft') continue;
        const actions = await availableActions(db, r0, u.id);
        if (actions.length > 0) {
          inbox.push({
            id: r0.id,
            requestNumber: r0.requestNumber,
            title: r0.title,
            status: r0.status,
            statusLabel: STATUS_LABELS[r0.status] ?? r0.status,
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
      const quotations = await db
        .select()
        .from(schema.quotations)
        .where(eq(schema.quotations.requestId, reqRow.id))
        .orderBy(schema.quotations.createdAt);
      const actions = await availableActions(db, reqRow, u.id);
      res.json({
        ...reqRow,
        statusLabel: STATUS_LABELS[reqRow.status] ?? reqRow.status,
        items,
        approvals,
        statusHistory,
        quotations,
        actions,
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
        leadTime: body.leadTime,
        quotationId: body.quotationId,
      });
      res.json({ ...result, statusLabel: STATUS_LABELS[result.status] ?? result.status });
    } catch (e) {
      next(e);
    }
  });

  // Set / change the current user's sign-off PIN.
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

  // Constructor / admin API.
  r.use('/admin', buildAdminRouter(db, auth));

  return r;
}
