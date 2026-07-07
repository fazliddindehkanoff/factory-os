/** REST routes. Auth on every /api route except login; RBAC checked per action. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { and, desc, eq, inArray, or, ilike, like, gte, lte, count, isNull, type SQL } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { verifyInitData } from '../auth/telegram.js';
import { issueSession } from '../auth/session.js';
import { requireAuth, type AuthedRequest } from './auth.middleware.js';
import { hasPermissionInHolding, getUserPermissionCodes } from '../rbac/rbac.js';
import { getRequestVisibility, getMoneyVisibility } from './request-visibility.js';
import { isTerminalStatus } from '../workflow/step-kinds.js';
import { createRequest, sanitizeCustomFields } from '../services/request.service.js';
import { approveApproval, rejectApproval } from '../services/approval.service.js';
import { performAction, availableActions, statusLabelFor, inboxCandidates, holdingRequiresPin } from '../services/lifecycle.service.js';
import { receiveStock, issueStock } from '../services/warehouse.service.js';
import { hashPin, verifyPin } from '../auth/pin.js';
import { pinLockoutRemaining, recordPinFailure, clearPinFailures } from './rate-limit.js';
import { getDashboard } from '../services/dashboard.service.js';
import type { Notifier } from '../bot/bot.js';
import {
  notifyUser,
  listUserNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from '../services/notification.service.js';
import { approvedStageMessage, approvedFinalMessage, rejectedMessage, needsRevisionMessage, newRequestForApproverMessage, requestMovedToStepMessage, returnedToStepMessage, confirmReceiptMessage, closedMessage } from '../bot/messages.js';
import { stepActorIds } from '../services/step-actors.js';
import { digestIntervalMinutes } from '../services/digest.service.js';
import { buildAdminRouter } from './admin.routes.js';
import { TEST_USERNAMES, TEST_PIN } from '../db/seed-test.js';

type Db = any;

/** Oversight permissions that let a user see requests beyond their own. */
/** A user may see a request per the visibility model (bug #2): own + involved +
 *  role-in-workflow; top roles (audit.view) see all. */
async function userCanSeeRequest(
  db: Db,
  userId: string,
  reqRow: { id: string; requesterId: string; workflowId: string | null },
): Promise<boolean> {
  const vis = await getRequestVisibility(db, userId);
  return vis.canSee({ id: reqRow.id, requesterId: reqRow.requesterId, workflowId: reqRow.workflowId ?? null });
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

/**
 * P2-3: a warehouse operation may only reference a warehouse and request that
 * belong to the actor's holding. Returns the validated ids, or an error string.
 */
async function validateWarehouseScope(
  db: Db, holdingId: string, warehouseIdRaw: unknown, requestIdRaw: unknown,
): Promise<{ warehouseId: string | null; requestId: string | null; error?: string }> {
  let warehouseId: string | null = null;
  let requestId: string | null = null;
  if (warehouseIdRaw != null && String(warehouseIdRaw) !== '') {
    warehouseId = String(warehouseIdRaw);
    const [wh] = await db
      .select({ id: schema.warehouses.id })
      .from(schema.warehouses)
      .where(and(eq(schema.warehouses.id, warehouseId), eq(schema.warehouses.holdingId, holdingId)));
    if (!wh) return { warehouseId, requestId, error: 'Warehouse not found in your holding' };
  }
  if (requestIdRaw != null && String(requestIdRaw) !== '') {
    requestId = String(requestIdRaw);
    const [rq] = await db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(and(eq(schema.requests.id, requestId), eq(schema.requests.holdingId, holdingId)));
    if (!rq) return { warehouseId, requestId, error: 'Request not found in your holding' };
  }
  return { warehouseId, requestId };
}

// P1-6: notifications are PERSISTED first (notification.service), then delivered.
// A failed Telegram send is recorded, not lost. `notify` is the delivery channel.
async function notifyRequester(
  db: Db, notify: Notifier | undefined, requestId: string,
  kind: 'stage_passed' | 'approved_final' | 'rejected' | 'needs_revision' | 'returned_step' | 'closed',
  text: (reqNumber: string) => string,
): Promise<void> {
  try {
    const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, requestId));
    if (!reqRow) return;
    await notifyUser(db, notify, {
      holdingId: reqRow.holdingId,
      recipientUserId: reqRow.requesterId,
      title: `Заявка ${reqRow.requestNumber}`,
      message: text(reqRow.requestNumber),
      kind,
      entityType: 'request',
      entityId: reqRow.id,
    });
  } catch {
    /* notifications are best-effort */
  }
}

/**
 * Notify whoever must act on the current step:
 *  - close-шаг — подтверждает АВТОР (requesterOnly), а не держатели роли шага:
 *    раньше «подтвердите получение» уходило складу, а автор не знал;
 *  - procurement с назначенным исполнителем — только исполнитель (Bug #8):
 *    остальные снабженцы всё равно заперты, их пуш — шум;
 *  - иначе — все активные держатели роли шага.
 * Сам актор действия уведомление не получает (он и так в приложении).
 */
async function notifyStepApprovers(
  db: Db, notify: Notifier | undefined,
  requestId: string, currentStepId: string | null,
  opts: { actorId?: string } = {},
): Promise<void> {
  if (!currentStepId) return;
  try {
    const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, requestId));
    if (!reqRow) return;
    const [step] = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.id, currentStepId));
    if (!step) return;

    // Дайджест-режим холдинга: «Ждёт вас» пишется только in-app, TG-пуш на
    // каждое событие подавлен — раз в интервал уйдёт одна сводка (digest.service).
    const push = (await digestIntervalMinutes(db, reqRow.holdingId)) ? undefined : notify;

    if (step.stepKind === 'close') {
      if (reqRow.requesterId && reqRow.requesterId !== opts.actorId) {
        await notifyUser(db, push, {
          holdingId: reqRow.holdingId,
          recipientUserId: reqRow.requesterId,
          title: `Подтвердите получение — ${reqRow.requestNumber}`,
          message: confirmReceiptMessage(reqRow.requestNumber),
          priority: 'high',
          kind: 'step_pending',
          entityType: 'request',
          entityId: reqRow.id,
        });
      }
      return;
    }

    const userIds = await stepActorIds(db, reqRow, step);
    if (!userIds.length) return;
    const msg = newRequestForApproverMessage(reqRow.requestNumber, reqRow.title ?? '', step.stepName);
    for (const uId of userIds) {
      if (uId === reqRow.requesterId || uId === opts.actorId) continue;
      await notifyUser(db, push, {
        holdingId: reqRow.holdingId,
        recipientUserId: uId,
        title: `Требуется действие — ${reqRow.requestNumber}`,
        message: msg,
        priority: 'high',
        kind: 'step_pending',
        entityType: 'request',
        entityId: reqRow.id,
      });
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

  // ── Dev-only: seeded test users for the role-switcher (docs/TEST_MODE.md).
  // Same stealth-404 contract as /auth/dev; lives under /dev (not /auth) so the
  // panel probe does not eat the tight authLimiter budget. ──
  r.get('/dev/users', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!devAuth) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      // Системные тест-логины + логины кастомных ролей холдинга (<code>_01 из
      // seed:test-logins) — иначе assistant_01 и прочих нет в DEV-панели (№1).
      const rows = await db
        .select({ id: schema.users.id, username: schema.users.telegramId, fullName: schema.users.fullName })
        .from(schema.users)
        .where(or(inArray(schema.users.telegramId, TEST_USERNAMES), like(schema.users.telegramId, '%\\_01')));
      const ids = rows.map((u: { id: string }) => u.id);
      const roleRows = ids.length
        ? await db
            .select({ userId: schema.userRoles.userId, name: schema.roles.name })
            .from(schema.userRoles)
            .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
            .where(and(inArray(schema.userRoles.userId, ids), eq(schema.userRoles.status, 'active')))
        : [];
      const rolesByUser = new Map<string, string[]>();
      for (const rr of roleRows as { userId: string; name: string }[]) {
        rolesByUser.set(rr.userId, [...(rolesByUser.get(rr.userId) ?? []), rr.name]);
      }
      // Keep the seed's order (the request path order) — not DB order; custom-role
      // logins (assistant_01 и т.п.) follow after, alphabetically.
      const byUsername = new Map(rows.map((u: any) => [u.username, u]));
      const users = TEST_USERNAMES.flatMap((username) => {
        const u = byUsername.get(username) as { id: string; username: string; fullName: string } | undefined;
        return u ? [{ username: u.username, fullName: u.fullName, roles: rolesByUser.get(u.id) ?? [] }] : [];
      });
      const extras = (rows as { id: string; username: string; fullName: string }[])
        .filter((u) => !TEST_USERNAMES.includes(u.username))
        .sort((a, b) => a.username.localeCompare(b.username))
        .map((u) => ({ username: u.username, fullName: u.fullName, roles: rolesByUser.get(u.id) ?? [] }));
      res.json({ users: [...users, ...extras], pin: TEST_PIN });
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
        // Users for department-head selection — needed only by the create-request
        // form, so don't hand the full employee directory to roles that can't
        // create requests (L8).
        if (await hasPermissionInHolding(db, u.id, 'requests.create', u.holdingId)) {
          const userRows = await db
            .select({ id: schema.users.id, fullName: schema.users.fullName })
            .from(schema.users)
            .where(and(eq(schema.users.holdingId, u.holdingId), eq(schema.users.status, 'active')));
          users = userRows.map((u0: { id: string; fullName: string }) => ({ id: u0.id, fullName: u0.fullName, departmentId: null }));
        }
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
          needs_revision: 'На доработке',
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
      if (!(await hasPermissionInHolding(db, u.id, 'requests.view', u.holdingId))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      // Pagination: accept both limit/offset and page/page_size (page is 1-based).
      const q = req.query;
      const limit = Math.min(Math.max(Number(q.page_size ?? q.limit) || 30, 1), 100);
      const offset =
        q.page !== undefined
          ? Math.max((Number(q.page) || 1) - 1, 0) * limit
          : Math.max(Number(q.offset) || 0, 0);

      // Visibility (bug #2): own + involved + role-is-a-step-in-the-workflow; top
      // roles (audit.view) see the whole holding.
      const vis = await getRequestVisibility(db, u.id);

      // P1-7: all filtering happens in the DB, not on the current page, so search
      // finds matching requests anywhere in the holding and totals are accurate.
      const conds: (SQL | undefined)[] = [eq(schema.requests.holdingId, u.holdingId)];
      if (vis.scope) conds.push(vis.scope);

      const search = String(q.search ?? '').trim();
      if (search) {
        const like = `%${search.replace(/[%_]/g, (m) => '\\' + m)}%`;
        conds.push(or(ilike(schema.requests.requestNumber, like), ilike(schema.requests.title, like)));
      }
      const status = String(q.status ?? '').trim();
      if (status) conds.push(eq(schema.requests.status, status));
      const priority = String(q.priority ?? '').trim();
      if (priority) conds.push(eq(schema.requests.priority, priority as any));
      if (q.factory_id) conds.push(eq(schema.requests.factoryId, String(q.factory_id)));
      if (q.department_id) conds.push(eq(schema.requests.departmentId, String(q.department_id)));
      if (q.requester_id) conds.push(eq(schema.requests.requesterId, String(q.requester_id)));
      // №13: «Только мои» — заявки, созданные текущим пользователем.
      if (String(q.mine ?? '') === '1') conds.push(eq(schema.requests.requesterId, u.id));
      if (q.responsible_user_id) conds.push(eq(schema.requests.responsibleUserId, String(q.responsible_user_id)));
      const dateFrom = q.date_from ? new Date(String(q.date_from)) : null;
      if (dateFrom && !isNaN(dateFrom.getTime())) conds.push(gte(schema.requests.createdAt, dateFrom));
      const dateTo = q.date_to ? new Date(String(q.date_to)) : null;
      if (dateTo && !isNaN(dateTo.getTime())) conds.push(lte(schema.requests.createdAt, dateTo));

      const where = and(...conds.filter(Boolean) as SQL[]);
      const rows = await db
        .select()
        .from(schema.requests)
        .where(where)
        .orderBy(desc(schema.requests.createdAt))
        .limit(limit + 1) // fetch one extra to detect "has more"
        .offset(offset);
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const [{ total }] = await db.select({ total: count() }).from(schema.requests).where(where);
      // Money gate (bug #9): суммы — денежным правам и согласующим от шага
      // закупки и дальше; ранние роли (рук. отдела, склад) их не видят.
      const listMoney = await getMoneyVisibility(db, u.id);
      const items = rows.map((r: any) => (listMoney.canSee(r) ? r : { ...r, estimatedAmount: null }));
      res.json({ items, hasMore, offset, limit, total });
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
      if (!(await hasPermissionInHolding(db, u.id, 'requests.create', u.holdingId))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const body = req.body ?? {};
      if (body.factoryId) {
        const [f] = await db.select().from(schema.factories).where(and(eq(schema.factories.id, body.factoryId), eq(schema.factories.holdingId, u.holdingId)));
        if (!f) { res.status(400).json({ error: 'Factory not found in your holding' }); return; }
      }
      if (body.departmentId) {
        const [d] = await db.select().from(schema.departments).where(and(eq(schema.departments.id, body.departmentId), eq(schema.departments.holdingId, u.holdingId)));
        if (!d) { res.status(400).json({ error: 'Department not found in your holding' }); return; }
      }
      const PRIORITIES = ['low', 'normal', 'high', 'urgent', 'critical'];
      let neededDate: Date | null = null;
      if (body.neededDate) {
        const d = new Date(body.neededDate);
        if (isNaN(d.getTime())) { res.status(400).json({ error: 'Invalid neededDate' }); return; }
        // №5: «нужно к дате» не бывает в прошлом — минимум сегодня (по началу дня,
        // чтобы «сегодня» в любом часовом поясе клиента проходило).
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (d.getTime() < today.getTime()) {
          res.status(400).json({ error: 'Дата «необходимо к» не может быть в прошлом' });
          return;
        }
        neededDate = d;
      }
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
        neededDate,
        customFields,
        items: Array.isArray(body.items) ? body.items : [],
      });
      // Notify approvers of the first step
      notifyStepApprovers(db, notify, result.id, result.currentStepId, { actorId: u.id }).catch(() => {});
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

      // Кандидаты отбираются В SQL до какого-либо лимита (фикс LIMIT-100: раньше
      // грузились 100 новейших открытых заявок и фильтровались после — при >100
      // заявок в работе инбокс согласующего пустел). Общий с KPI дашборда хелпер.
      const all = await inboxCandidates(db, u.id, u.holdingId);

      // Пагинация: ?limit (1..200, по умолчанию 100) и ?offset — применяются к
      // УЖЕ отфильтрованному списку, поэтому «дальние» заявки не теряются.
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      const offset = Math.max(0, Number(req.query.offset) || 0);

      // availableActions — финальная проверка прав на каждом кандидате.
      // №10: элемент инбокса несёт основные теги решения — автор, отдел,
      // срочность, возраст, число позиций; сумма только тем, кому можно (bug #9).
      const inboxMoney = await getMoneyVisibility(db, u.id);
      const inbox: any[] = [];
      let matched = 0;
      for (const r0 of all) {
        const actions = await availableActions(db, r0, u.id);
        if (actions.length === 0) continue;
        matched++;
        if (matched <= offset) continue;
        const raw = r0 as any;
        inbox.push({
          id: r0.id,
          requestNumber: r0.requestNumber,
          title: r0.title,
          status: r0.status,
          statusLabel: await statusLabelFor(db, r0),
          estimatedAmount: inboxMoney.canSee(r0) ? r0.estimatedAmount : null,
          priority: raw.priority ?? null,
          createdAt: raw.createdAt ?? null,
          requesterId: r0.requesterId,
          departmentId: r0.departmentId,
          actions,
        });
        if (inbox.length >= limit) break;
      }
      // Обогащение страницы (не всего множества): имена авторов, отделы, позиции.
      if (inbox.length) {
        const reqIds = inbox.map((i) => i.id);
        const userIds = [...new Set(inbox.map((i) => i.requesterId).filter(Boolean))] as string[];
        const deptIds = [...new Set(inbox.map((i) => i.departmentId).filter(Boolean))] as string[];
        const [userRows, deptRows, itemRows] = await Promise.all([
          userIds.length ? db.select({ id: schema.users.id, fullName: schema.users.fullName }).from(schema.users).where(inArray(schema.users.id, userIds)) : [],
          deptIds.length ? db.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(inArray(schema.departments.id, deptIds)) : [],
          db.select({ requestId: schema.requestItems.requestId, n: count() }).from(schema.requestItems).where(inArray(schema.requestItems.requestId, reqIds)).groupBy(schema.requestItems.requestId),
        ]);
        const userBy = new Map((userRows as any[]).map((x) => [x.id, x.fullName]));
        const deptBy = new Map((deptRows as any[]).map((x) => [x.id, x.name]));
        const itemsBy = new Map((itemRows as any[]).map((x) => [x.requestId, Number(x.n)]));
        for (const i of inbox) {
          i.requesterName = userBy.get(i.requesterId) ?? null;
          i.departmentName = deptBy.get(i.departmentId) ?? null;
          i.itemsCount = itemsBy.get(i.id) ?? 0;
          delete i.requesterId;
          delete i.departmentId;
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
      // Visibility (bug #2): own + involved + role-in-workflow; top roles see all.
      // 404 (not 403) so a foreign id doesn't reveal existence. (H3)
      const detailVis = await getRequestVisibility(db, u.id);
      if (!detailVis.canSee(reqRow)) {
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
      // Covers both status-history changers and approval actors (for per-step who/when).
      const actorIds = [...new Set([
        ...statusHistory.map((h: { changedBy: string | null }) => h.changedBy),
        ...approvals.map((a: { approverUserId: string | null }) => a.approverUserId),
      ].filter(Boolean))] as string[];
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
      // КП are commercially sensitive: expose them only to roles that work with
      // money/procurement OR approve at/after the procurement step — the single
      // getMoneyVisibility gate, enforced server-side. (M3b, bug цены 2026-07-07)
      const viewerCodes = await getUserPermissionCodes(db, u.id);
      const detailMoney = await getMoneyVisibility(db, u.id);
      const canSeeQuotes = detailMoney.canSee(reqRow);
      const quotations = canSeeQuotes
        ? await db
            .select()
            .from(schema.quotations)
            .where(eq(schema.quotations.requestId, reqRow.id))
            .orderBy(schema.quotations.createdAt)
        : [];
      const actions = await availableActions(db, reqRow, u.id);
      // Build workflow timeline with per-step state + WHO/WHEN acted (bugs #4, #7, #10).
      type TLState = 'completed' | 'current' | 'future' | 'rejected';
      let workflowTimeline: {
        stepId: string; stepName: string; stepKind: string; state: TLState;
        actorName: string | null; actorRole: string | null; at: unknown; action: string | null;
      }[] = [];
      if (reqRow.workflowId) {
        const allSteps = await db
          .select()
          .from(schema.workflowSteps)
          .where(eq(schema.workflowSteps.workflowId, reqRow.workflowId));
        const sorted = allSteps
          .filter((s: { enabled: boolean }) => s.enabled !== false)
          .sort((a: { stepOrder: number }, b: { stepOrder: number }) => a.stepOrder - b.stepOrder);

        // Resolved action per step (approved / rejected) from the approvals rows.
        const stepAction = new Map<string, { action: string; at: unknown; actorId: string | null }>();
        for (const a of approvals as { workflowStepId: string | null; status: string; approvedAt: unknown; approverUserId: string | null }[]) {
          if (a.workflowStepId && (a.status === 'approved' || a.status === 'rejected')) {
            stepAction.set(a.workflowStepId, { action: a.status, at: a.approvedAt, actorId: a.approverUserId });
          }
        }
        // Rejected request → the step where it was rejected splits the timeline. (#4)
        const rejectedStep = sorted.find((s: { id: string }) => stepAction.get(s.id)?.action === 'rejected');
        const rejectedOrder = rejectedStep ? (rejectedStep as { stepOrder: number }).stepOrder : null;

        let foundCurrent = false;
        for (const s of sorted) {
          let state: TLState;
          if (rejectedOrder != null) {
            // A rejected chain: steps before are done, the rejection step is red,
            // everything after was never reached.
            if ((s as { stepOrder: number }).stepOrder < rejectedOrder) state = 'completed';
            else if ((s as { stepOrder: number }).stepOrder === rejectedOrder) state = 'rejected';
            else state = 'future';
          } else if (reqRow.currentStepId === s.id) {
            state = 'current';
            foundCurrent = true;
          } else if (reqRow.currentStepId && !foundCurrent) {
            state = 'completed';
          } else if (!reqRow.currentStepId) {
            state = 'completed'; // approved/closed terminal — all done
          } else {
            state = 'future';
          }
          const act = stepAction.get(s.id);
          const actor = act?.actorId ? actorMap.get(act.actorId) : undefined;
          workflowTimeline.push({
            stepId: s.id,
            stepName: s.stepName,
            stepKind: s.stepKind,
            state,
            action: act?.action ?? null,
            at: act?.at ?? null,
            actorName: actor?.name ?? null,
            actorRole: actor?.role ?? null,
          });
        }
      }

      // Resolve human names for the full info card (bug #9).
      const [requesterRow] = reqRow.requesterId
        ? await db.select({ name: schema.users.fullName }).from(schema.users).where(eq(schema.users.id, reqRow.requesterId))
        : [];
      const [respRow] = reqRow.responsibleUserId
        ? await db.select({ name: schema.users.fullName }).from(schema.users).where(eq(schema.users.id, reqRow.responsibleUserId))
        : [];
      const [facRow] = reqRow.factoryId
        ? await db.select({ name: schema.factories.name }).from(schema.factories).where(eq(schema.factories.id, reqRow.factoryId))
        : [];
      const [depRow] = reqRow.departmentId
        ? await db.select({ name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.id, reqRow.departmentId))
        : [];

      // Progress starts with the REQUESTER (who created it), then the approval steps.
      workflowTimeline.unshift({
        stepId: 'created',
        stepName: 'Заявка создана',
        stepKind: 'created',
        state: 'completed',
        action: 'created',
        at: reqRow.createdAt,
        actorName: requesterRow?.name ?? null,
        actorRole: 'Заявитель',
      });

      // Money is visible to the procurement manager and everyone above (bug #9):
      // same gate as КП. Others get null money fields instead of the values.
      const canSeeMoney = canSeeQuotes;
      const itemsOut = items.map((it: any) =>
        canSeeMoney ? it : { ...it, estimatedPrice: null, totalAmount: null },
      );

      // №12в: «История действий» — только ролям с audit.view, зато МАКСИМАЛЬНО
      // подробная: история статусов + полный аудит-трейл заявки. Остальным ходом
      // заявки служит workflowTimeline.
      const canSeeHistory = viewerCodes.includes('audit.view');
      let auditTrail: unknown[] = [];
      if (canSeeHistory) {
        const trail = await db
          .select()
          .from(schema.auditLogs)
          .where(and(eq(schema.auditLogs.entityType, 'request'), eq(schema.auditLogs.entityId, reqRow.id)))
          .orderBy(schema.auditLogs.createdAt);
        const trailUserIds = [...new Set(trail.map((t: { userId: string | null }) => t.userId).filter(Boolean))] as string[];
        const trailUsers = trailUserIds.length
          ? await db.select({ id: schema.users.id, fullName: schema.users.fullName }).from(schema.users).where(inArray(schema.users.id, trailUserIds))
          : [];
        const trailNameBy = new Map((trailUsers as { id: string; fullName: string }[]).map((x) => [x.id, x.fullName]));
        auditTrail = trail.map((t: any) => ({
          id: t.id,
          action: t.action,
          module: t.module,
          userId: t.userId,
          userName: t.userId ? trailNameBy.get(t.userId) ?? null : null,
          oldValue: t.oldValue,
          newValue: t.newValue,
          source: t.source,
          createdAt: t.createdAt,
        }));
      }

      res.json({
        ...reqRow,
        estimatedAmount: canSeeMoney ? reqRow.estimatedAmount : null,
        requesterName: requesterRow?.name ?? null,
        responsibleName: respRow?.name ?? null,
        factoryName: facRow?.name ?? null,
        departmentNameResolved: depRow?.name ?? reqRow.departmentName ?? null,
        statusLabel: await statusLabelFor(db, reqRow),
        items: itemsOut,
        approvals,
        statusHistory: canSeeHistory ? statusHistoryOut : [],
        auditTrail,
        canSeeHistory,
        quotations,
        canSeeMoney,
        actions,
        workflowTimeline,
      });
    } catch (e) {
      next(e);
    }
  });

  // Lifecycle transition — guarded by status × permission × scope × PIN/comment,
  // writes status history + DNA audit log atomically.
  // Bug #5: the AUTHOR may cancel their own request while no one has approved it yet.
  // Soft cancel (status='cancelled') — the row and full history are kept (who/when/why).
  r.post('/requests/:id/cancel', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
      if (!reqRow || reqRow.holdingId !== u.holdingId) { res.status(404).json({ error: 'Not found' }); return; }
      if (reqRow.requesterId !== u.id) { res.status(403).json({ error: 'Отменить заявку может только её автор' }); return; }
      if (isTerminalStatus(reqRow.status)) { res.status(409).json({ error: 'Заявка уже завершена' }); return; }
      // Only before ANY human approval (auto-skips do not count).
      const approved = await db
        .select({ id: schema.approvals.id })
        .from(schema.approvals)
        .where(and(eq(schema.approvals.requestId, reqRow.id), eq(schema.approvals.status, 'approved')));
      if (approved.length) { res.status(409).json({ error: 'Заявку уже начали согласовывать — отменить нельзя' }); return; }
      const reason = String((req.body ?? {}).reason ?? '').trim();
      await db.transaction(async (tx: Db) => {
        await tx.update(schema.requests)
          .set({ status: 'cancelled', currentStepId: null, closedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.requests.id, reqRow.id));
        await tx.update(schema.approvals)
          .set({ status: 'cancelled' })
          .where(and(eq(schema.approvals.requestId, reqRow.id), eq(schema.approvals.status, 'pending')));
        await tx.insert(schema.requestStatusHistory).values({
          requestId: reqRow.id, oldStatus: reqRow.status, newStatus: 'cancelled',
          changedBy: u.id, source: 'cancel', comment: reason || 'Отменена автором',
        });
        await tx.insert(schema.auditLogs).values({
          holdingId: reqRow.holdingId, factoryId: reqRow.factoryId, userId: u.id,
          action: 'request.cancelled', module: 'requests', entityType: 'request', entityId: reqRow.id,
          oldValue: { status: reqRow.status, requestNumber: reqRow.requestNumber, title: reqRow.title },
          newValue: { status: 'cancelled', reason: reason || null },
          source: 'api',
        });
      });
      res.json({ ok: true, status: 'cancelled' });
    } catch (e) {
      next(e);
    }
  });

  // Bug #3: configurable rejection-reason presets for the current step's role.
  r.get('/requests/:id/reject-reasons', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
      if (!reqRow || reqRow.holdingId !== u.holdingId) { res.json({ reasons: [] }); return; }
      let roleCode: string | null = null;
      if (reqRow.currentStepId) {
        const [step] = await db.select({ rid: schema.workflowSteps.approverRoleId }).from(schema.workflowSteps).where(eq(schema.workflowSteps.id, reqRow.currentStepId));
        if (step?.rid) {
          const [role] = await db.select({ code: schema.roles.code }).from(schema.roles).where(eq(schema.roles.id, step.rid));
          roleCode = role?.code ?? null;
        }
      }
      const rows = await db
        .select()
        .from(schema.rejectionReasons)
        .where(
          and(
            eq(schema.rejectionReasons.isActive, true),
            or(isNull(schema.rejectionReasons.holdingId), eq(schema.rejectionReasons.holdingId, u.holdingId as string)),
            or(isNull(schema.rejectionReasons.roleCode), roleCode ? eq(schema.rejectionReasons.roleCode, roleCode) : isNull(schema.rejectionReasons.roleCode)),
          ),
        )
        .orderBy(schema.rejectionReasons.sortOrder);
      const seen = new Set<string>();
      const reasons = rows
        .map((r: { text: string }) => r.text)
        .filter((t: string) => (seen.has(t) ? false : (seen.add(t), true)));
      res.json({ reasons });
    } catch (e) {
      next(e);
    }
  });

  // Bug #8: procurement people the head can assign a request to (active users with
  // a procurement permission in the holding).
  r.get('/procurement/assignees', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId) { res.json({ users: [] }); return; }
      const users = await db
        .select({ id: schema.users.id, fullName: schema.users.fullName })
        .from(schema.users)
        .where(and(eq(schema.users.holdingId, u.holdingId), eq(schema.users.status, 'active')));
      const out: { id: string; fullName: string | null }[] = [];
      for (const usr of users) {
        const codes = await getUserPermissionCodes(db, usr.id);
        if (['procurement.quote', 'procurement.select_supplier', 'procurement.view'].some((p) => codes.includes(p))) out.push(usr);
      }
      res.json({ users: out });
    } catch (e) {
      next(e);
    }
  });

  r.post('/requests/:id/action', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const body = req.body ?? {};
      // Capture status + step before the action so we can detect real transitions
      const [beforeReq] = await db
        .select({ status: schema.requests.status, currentStepId: schema.requests.currentStepId })
        .from(schema.requests)
        .where(eq(schema.requests.id, req.params.id as string));
      const fromStatus = beforeReq?.status;
      const fromStepId = beforeReq?.currentStepId ?? null;
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
        assigneeId: body.assigneeId,
      });
      const stepLabel = await statusLabelFor(db, result);
      // Ответственные следующего шага — ТОЛЬКО когда шаг реально сменился.
      // Раньше пуш «требуется согласование» уходил на КАЖДОЕ действие (в т.ч.
      // «Добавить КП», не двигающее заявку) — согласующих заваливало дублями.
      const stepChanged = (result.currentStepId ?? null) !== fromStepId;
      if (result.currentStepId && stepChanged) {
        notifyStepApprovers(db, notify, result.id, result.currentStepId, { actorId: u.id }).catch(() => {});
      }
      // Автору — о ходе ЕГО заявки, но не о его же собственных действиях
      // (resubmit/close: автор — актор, пуш самому себе — шум).
      if (result.requesterId !== u.id) {
        const comment = String(body.comment ?? '').trim();
        if (result.status === 'approved') {
          notifyRequester(db, notify, result.id, 'approved_final', (rn) => approvedFinalMessage(rn));
        } else if (result.status === 'closed' && fromStatus !== 'closed') {
          notifyRequester(db, notify, result.id, 'closed', (rn) => closedMessage(rn));
        } else if (result.status === 'rejected') {
          notifyRequester(db, notify, result.id, 'rejected', (rn) => rejectedMessage(rn, comment));
        } else if (result.status === 'needs_revision' && result.status !== fromStatus) {
          // Ветка «вернуть на доработку»: автор должен узнать сразу, не заходя в приложение.
          notifyRequester(db, notify, result.id, 'needs_revision', (rn) => needsRevisionMessage(rn, comment));
        } else if (String(body.action) === 'reject' && stepChanged && result.currentStepId) {
          // Политика return_step: отклонение вернуло заявку на более ранний шаг.
          // Раньше автор получал «✅ согласована на этапе» — ровно наоборот.
          notifyRequester(db, notify, result.id, 'returned_step', (rn) => returnedToStepMessage(rn, stepLabel, comment));
        } else if (result.currentStepId && stepChanged && result.status !== fromStatus) {
          notifyRequester(db, notify, result.id, 'stage_passed', (rn) => requestMovedToStepMessage(rn, stepLabel));
        }
      }
      res.json({ ...result, statusLabel: stepLabel });
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
      const body = req.body ?? {};
      const pin = String(body.pin ?? '').trim();
      if (!/^\d{4,8}$/.test(pin)) {
        res.status(400).json({ error: 'PIN — 4–8 цифр' });
        return;
      }
      const [full] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
      // P2-2: changing an EXISTING PIN requires the current PIN (with lockout).
      // A stolen 7-day session must not be enough to reset the signing PIN.
      if (full?.pinHash) {
        if (pinLockoutRemaining(u.id) > 0) {
          res.status(429).json({ error: 'Слишком много попыток PIN — попробуйте позже' });
          return;
        }
        const oldPin = String(body.oldPin ?? '');
        if (!verifyPin(oldPin, full.pinHash)) {
          recordPinFailure(u.id);
          res.status(403).json({ error: 'Неверный текущий PIN' });
          return;
        }
        clearPinFailures(u.id);
      }
      await db.update(schema.users).set({ pinHash: hashPin(pin) }).where(eq(schema.users.id, u.id));
      // Never log the PIN itself — only that it changed.
      await db.insert(schema.auditLogs).values({
        holdingId: u.holdingId ?? null,
        userId: u.id,
        action: full?.pinHash ? 'pin.changed' : 'pin.set',
        module: 'auth',
        entityType: 'user',
        entityId: u.id,
        source: 'api',
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ── Notification center (P1-6): a user's own persisted notifications ──────────
  r.get('/me/notifications', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const unreadOnly = String((req.query.unread ?? '')) === '1';
      const items = await listUserNotifications(db, u.id, { unreadOnly });
      res.json({ items, unread: await unreadCount(db, u.id) });
    } catch (e) {
      next(e);
    }
  });

  r.get('/me/notifications/unread-count', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      res.json({ unread: await unreadCount(db, u.id) });
    } catch (e) {
      next(e);
    }
  });

  r.post('/me/notifications/:id/read', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const ok = await markRead(db, u.id, String(req.params.id));
      if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.post('/me/notifications/read-all', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const count = await markAllRead(db, u.id);
      res.json({ ok: true, count });
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
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'approvals.approve', u.holdingId))) {
        res.status(403).json({ error: 'Недостаточно прав для согласования' });
        return;
      }
      // №15: PIN как подпись — только если холдинг не переключился на простое
      // подтверждение (settings.require_pin = '0').
      if (await holdingRequiresPin(db, u.holdingId)) {
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
      }
      const result = await approveApproval(db, {
        approvalId: (req.params.id as string),
        actorUserId: u.id,
        comment: body.comment,
      });
      await notifyRequester(
        db, notify, result.requestId,
        result.status === 'approved' ? 'approved_final' : 'stage_passed',
        (rn) => (result.status === 'approved' ? approvedFinalMessage(rn) : approvedStageMessage(rn)),
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
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'approvals.reject', u.holdingId))) {
        res.status(403).json({ error: 'Недостаточно прав для отклонения' });
        return;
      }
      const result = await rejectApproval(db, {
        approvalId: (req.params.id as string),
        actorUserId: u.id,
        comment: body.comment ?? '',
      });
      await notifyRequester(db, notify, result.requestId, 'rejected', (rn) =>
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
      if (!isAuthor && !(await hasPermissionInHolding(db, u.id, 'requests.edit', u.holdingId))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      // Only editable in early stages — плюс «на доработке»: возврат автору
      // затем и существует, чтобы он поправил заявку перед повторной отправкой.
      const EDITABLE = ['draft', 'pending_approval', 'needs_revision'];
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
      if (body.neededDate !== undefined) {
        // №5: и при редактировании дата «необходимо к» не может быть в прошлом.
        if (body.neededDate) {
          const nd = new Date(body.neededDate);
          if (isNaN(nd.getTime())) { res.status(400).json({ error: 'Invalid neededDate' }); return; }
          const today0 = new Date();
          today0.setHours(0, 0, 0, 0);
          if (nd.getTime() < today0.getTime()) {
            res.status(400).json({ error: 'Дата «необходимо к» не может быть в прошлом' });
            return;
          }
          patch.neededDate = nd;
        } else {
          patch.neededDate = null;
        }
      }
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
      if (!(await hasPermissionInHolding(db, u.id, 'warehouse.view', u.holdingId))) {
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
        // P2-3: joins are holding-scoped too (defense in depth) so a cross-holding
        // material/warehouse name can never leak through the join.
        .innerJoin(
          schema.materials,
          and(eq(schema.materials.id, schema.stockBalances.materialId), eq(schema.materials.holdingId, u.holdingId)),
        )
        .leftJoin(
          schema.warehouses,
          and(eq(schema.warehouses.id, schema.stockBalances.warehouseId), eq(schema.warehouses.holdingId, u.holdingId)),
        )
        .where(eq(schema.stockBalances.holdingId, u.holdingId));
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  r.post('/warehouse/receive', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'warehouse.receive', u.holdingId))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const body = req.body ?? {};
      const quantity = Number(body.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        res.status(400).json({ error: 'Quantity must be a positive number' }); return;
      }
      const materialId = String(body.materialId ?? '');
      const [mat] = await db.select().from(schema.materials).where(and(eq(schema.materials.id, materialId), eq(schema.materials.holdingId, u.holdingId!)));
      if (!mat) { res.status(400).json({ error: 'Material not found in your holding' }); return; }
      const scoped = await validateWarehouseScope(db, u.holdingId!, body.warehouseId, body.requestId);
      if (scoped.error) { res.status(400).json({ error: scoped.error }); return; }
      const result = await receiveStock(db, {
        holdingId: u.holdingId,
        materialId,
        warehouseId: scoped.warehouseId,
        quantity,
        performedBy: u.id,
        requestId: scoped.requestId,
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
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'warehouse.issue', u.holdingId))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const body = req.body ?? {};
      const quantity = Number(body.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        res.status(400).json({ error: 'Quantity must be a positive number' }); return;
      }
      const materialId = String(body.materialId ?? '');
      const [mat] = await db.select().from(schema.materials).where(and(eq(schema.materials.id, materialId), eq(schema.materials.holdingId, u.holdingId!)));
      if (!mat) { res.status(400).json({ error: 'Material not found in your holding' }); return; }
      const scoped = await validateWarehouseScope(db, u.holdingId!, body.warehouseId, body.requestId);
      if (scoped.error) { res.status(400).json({ error: scoped.error }); return; }
      const result = await issueStock(db, {
        holdingId: u.holdingId,
        materialId,
        warehouseId: scoped.warehouseId,
        quantity,
        performedBy: u.id,
        requestId: scoped.requestId,
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
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'warehouse.view', u.holdingId))) {
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
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'suppliers.view', u.holdingId))) {
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
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'suppliers.manage', u.holdingId))) {
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
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'suppliers.manage', u.holdingId))) {
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
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'suppliers.manage', u.holdingId))) {
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
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'procurement.view', u.holdingId))) {
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
      if (reqRow.requesterId !== u.id && !(await hasPermissionInHolding(db, u.id, 'requests.upload_attachment', u.holdingId))) {
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
      if (att.uploaderId !== u.id && !(await hasPermissionInHolding(db, u.id, 'requests.edit', u.holdingId))) {
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
