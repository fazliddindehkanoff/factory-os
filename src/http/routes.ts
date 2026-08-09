/** REST routes. Auth on every /api route except login; RBAC checked per action. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { and, desc, eq, inArray, or, ilike, like, gte, lte, count, isNull, ne, type SQL } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { verifyInitData } from '../auth/telegram.js';
import { issueSession } from '../auth/session.js';
import { normalizePhone } from '../auth/phone.js';
import { requireAuth, type AuthedRequest } from './auth.middleware.js';
import { hasPermissionInHolding, getUserPermissionCodes } from '../rbac/rbac.js';
import { getRequestVisibility, getMoneyVisibility } from './request-visibility.js';
import { isTerminalStatus, statusForStep } from '../workflow/step-kinds.js';
import { createRequest, sanitizeCustomFields, MAX_ITEM_QUANTITY, MAX_ITEM_PRICE } from '../services/request.service.js';
import { performAction, availableActions, statusLabelFor, inboxCandidates, markItemStock } from '../services/lifecycle.service.js';
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
import { approvedFinalMessage, rejectedMessage, needsRevisionMessage, newRequestForApproverMessage, requestMovedToStepMessage, returnedToStepMessage, confirmReceiptMessage, closedMessage } from '../bot/messages.js';
import { stepActorIds } from '../services/step-actors.js';
import { digestIntervalMinutes } from '../services/digest.service.js';
import { buildAdminRouter } from './admin.routes.js';
import { TEST_USERNAMES, TEST_PIN } from '../db/seed-test.js';
import { ValidationError } from '../services/errors.js';

type Db = any;

/** Правка заявки разрешена на ранних этапах — плюс «на доработке»: возврат
 *  автору затем и существует, чтобы он поправил заявку перед resubmit.
 *  Единый список для PUT /requests/:id и флага canEdit в деталях. */
const EDITABLE_STATUSES = ['draft', 'pending_approval', 'needs_revision'];

/** Resolved department name(s), all three languages — the viewer's client picks
 *  which to show (see `currentLang()`/`localizedName()` client-side), since the
 *  server has no visibility into the viewer's language preference (it's stored
 *  in localStorage only, never sent with the request). Never bake a single
 *  language in server-side or switching the UI language can't update it. */
function deptNameFields(dep: { name: string; nameUz: string | null; nameTr: string | null } | undefined, fallback: string | null): {
  departmentNameResolved: string | null;
  departmentNameUz: string | null;
  departmentNameTr: string | null;
} {
  return {
    departmentNameResolved: dep?.name ?? fallback,
    departmentNameUz: dep?.nameUz ?? null,
    departmentNameTr: dep?.nameTr ?? null,
  };
}

function canEditRequestRow(
  reqRow: { status: string; requesterId: string | null },
  userId: string,
  permissions: string[],
  approvals: { status: string }[],
): boolean {
  if (isTerminalStatus(reqRow.status)) return false;
  const hasRealApproval = approvals.some((a) => a.status === 'approved');
  const authorMayEdit = reqRow.requesterId === userId && (EDITABLE_STATUSES.includes(reqRow.status) || !hasRealApproval);
  const privilegedMayEdit = permissions.includes('requests.edit') && EDITABLE_STATUSES.includes(reqRow.status);
  return authorMayEdit || privilegedMayEdit;
}

/** Oversight permissions that let a user see requests beyond their own. */
/** A user may see a request per the visibility model (bug #2): own + involved +
 *  role-in-workflow; top roles (audit.view) see all. */
async function userCanSeeRequest(
  db: Db,
  userId: string,
  reqRow: { id: string; requesterId: string; workflowId: string | null; responsibleUserId?: string | null; companyId?: string | null; factoryId?: string | null; departmentId?: string | null },
): Promise<boolean> {
  if ((reqRow as { status?: string }).status === 'deleted') return false;
  const vis = await getRequestVisibility(db, userId);
  return vis.canSee(reqRow);
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
    if (!userIds.length) {
      const [role] = step.approverRoleId
        ? await db.select({ code: schema.roles.code }).from(schema.roles).where(eq(schema.roles.id, step.approverRoleId))
        : [];
      if (role?.code === 'dept_head' && reqRow.departmentId) {
        const [department] = await db.select({ name: schema.departments.name })
          .from(schema.departments).where(eq(schema.departments.id, reqRow.departmentId));
        const recipientUserId = opts.actorId ?? reqRow.requesterId;
        if (recipientUserId) {
          await notifyUser(db, push, {
            holdingId: reqRow.holdingId,
            recipientUserId,
            title: `Не назначен руководитель отдела — ${reqRow.requestNumber}`,
            message: `Для отдела «${department?.name ?? 'выбранный отдел'}» не назначен ответственный руководитель отдела. Назначьте руководителя в настройках сотрудников, чтобы заявка попала ответственному.`,
            priority: 'high',
            kind: 'configuration',
            entityType: 'request',
            entityId: reqRow.id,
          });
        }
      }
      return;
    }
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

async function notifyDeptHeadAfterReceiving(
  db: Db,
  notify: Notifier | undefined,
  requestId: string,
  opts: { actorId?: string } = {},
): Promise<void> {
  try {
    const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, requestId));
    if (!reqRow) return;
    const [role] = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, 'dept_head')));
    if (!role) return;
    const userIds = await stepActorIds(db, reqRow, { stepKind: 'approval', approverRoleId: role.id });
    if (!userIds.length) return;
    const push = (await digestIntervalMinutes(db, reqRow.holdingId)) ? undefined : notify;
    for (const uId of userIds) {
      if (uId === opts.actorId) continue;
      await notifyUser(db, push, {
        holdingId: reqRow.holdingId,
        recipientUserId: uId,
        title: `Склад принял заявку — ${reqRow.requestNumber}`,
        message: `Заявка ${reqRow.requestNumber} принята складом и закрыта.`,
        priority: 'high',
        kind: 'closed',
        entityType: 'request',
        entityId: reqRow.id,
      });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * FIXES 2026-07-20 (2): ветка «есть в наличии» руководителя отдела НЕ спрашивает —
 * он получает только уведомление о том, что заявка закрывается со склада
 * (согласующий шаг ветки удалён миграцией 0038).
 */
async function notifyDeptHeadInStock(
  db: Db,
  notify: Notifier | undefined,
  requestId: string,
  opts: { actorId?: string } = {},
): Promise<void> {
  try {
    const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, requestId));
    if (!reqRow) return;
    const [role] = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, 'dept_head')));
    if (!role) return;
    const userIds = await stepActorIds(db, reqRow, { stepKind: 'approval', approverRoleId: role.id });
    if (!userIds.length) return;
    const push = (await digestIntervalMinutes(db, reqRow.holdingId)) ? undefined : notify;
    for (const uId of userIds) {
      if (uId === opts.actorId) continue;
      await notifyUser(db, push, {
        holdingId: reqRow.holdingId,
        recipientUserId: uId,
        title: `Товар в наличии — ${reqRow.requestNumber}`,
        message: `По заявке ${reqRow.requestNumber} всё есть на складе — будет выдано в отдел без закупки. Действий не требуется.`,
        kind: 'stage_passed',
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
      // Fail-closed: an admin must have already provisioned this person (by phone,
      // via the bot's /start contact-share flow, or directly) before they can open
      // the Mini App — no more silent self-registration on first open.
      const [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, tgUser.id));
      if (!u) {
        res.status(403).json({ error: 'Not registered. Share your phone number with the bot first.' });
        return;
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
      const body = req.body ?? {};
      const identifier = String(body.login ?? body.phone ?? body.telegramId ?? '').trim();
      if (!identifier) {
        res.status(400).json({ error: 'login required' });
        return;
      }
      // Prefer the historical telegramId/dev-login lookup, then resolve the same
      // existing account by normalized phone. This lets test URLs contain either
      // `sklad_01`, `+998 90 ...`, or a digits-only phone without duplicating users.
      let [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, identifier));
      if (!u) {
        const phone = normalizePhone(identifier);
        if (phone) [u] = await db.select().from(schema.users).where(eq(schema.users.phone, phone));
      }
      if (!u) {
        // Keep the legacy test helper contract: callers explicitly posting a
        // telegramId may create an ad-hoc dev user. New web/query-param login is
        // lookup-only, so a typo cannot silently create a roleless account.
        if (body.telegramId === undefined || body.login !== undefined || body.phone !== undefined) {
          res.status(404).json({ error: 'Test user not found' });
          return;
        }
        [u] = await db
          .insert(schema.users)
          .values({ telegramId: identifier, fullName: 'Dev User', status: 'active' })
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
        .select({ id: schema.users.id, username: schema.users.telegramId, phone: schema.users.phone, fullName: schema.users.fullName })
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
        const u = byUsername.get(username) as { id: string; username: string; phone: string | null; fullName: string } | undefined;
        return u ? [{ username: u.username, phone: u.phone, fullName: u.fullName, roles: rolesByUser.get(u.id) ?? [] }] : [];
      });
      const extras = (rows as { id: string; username: string; phone: string | null; fullName: string }[])
        // Dev auth can create ad-hoc users. Do not advertise roleless/orphan
        // accounts in the role switcher just because their id ends in `_01`;
        // custom-role QA accounts are useful only after a role is assigned.
        .filter((u) => !TEST_USERNAMES.includes(u.username) && (rolesByUser.get(u.id)?.length ?? 0) > 0)
        .sort((a, b) => a.username.localeCompare(b.username))
        .map((u) => ({ username: u.username, phone: u.phone, fullName: u.fullName, roles: rolesByUser.get(u.id) ?? [] }));
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
      let roleCodes: string[] = [];
      if (u.holdingId) {
        const roleRows = await db
          .select({ code: schema.roles.code, name: schema.roles.name })
          .from(schema.userRoles)
          .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
          .where(and(eq(schema.userRoles.userId, u.id), eq(schema.userRoles.status, 'active')));
        if (roleRows.length) roleName = roleRows.map((r0: { name: string }) => r0.name).join(', ');
        roleCodes = roleRows.map((r0: { code: string }) => r0.code);
      }
      const user = {
        ...u,
        phone: full?.phone ?? null,
        email: full?.email ?? null,
        position: full?.position ?? null,
        roleName,
        roleCodes,
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
      let departments: { id: string; name: string; nameUz: string | null; nameTr: string | null }[] = [];
      let users: {
        id: string;
        fullName: string;
        departmentId: string | null;
        departments: { id: string; name: string; nameUz: string | null; nameTr: string | null }[];
      }[] = [];
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
          .map((d: { id: string; name: string; nameUz: string | null; nameTr: string | null }) => ({
            id: d.id,
            name: d.name,
            nameUz: d.nameUz,
            nameTr: d.nameTr,
          }));
        const canCreateRequests = await hasPermissionInHolding(db, u.id, 'requests.create', u.holdingId);
        // Non-creators only need their own scoped departments. Request creators
        // must see every active department because they may submit on behalf of
        // any active employee, including someone assigned to another department.
        const explicitAssignedDepts = await db
          .select({ departmentId: schema.userDepartments.departmentId })
          .from(schema.userDepartments)
          .where(eq(schema.userDepartments.userId, u.id));
        const scopedAssignedDepts = await db
          .select({ departmentId: schema.userRoles.departmentId })
          .from(schema.userRoles)
          .where(and(eq(schema.userRoles.userId, u.id), eq(schema.userRoles.status, 'active')));
        const assignedIds = new Set(
          [
            ...explicitAssignedDepts.map((d: { departmentId: string }) => d.departmentId),
            ...scopedAssignedDepts.map((d: { departmentId: string | null }) => d.departmentId).filter(Boolean),
          ] as string[],
        );
        if (assignedIds.size > 0 && !canCreateRequests) {
          departments = departments.filter((d: { id: string }) => assignedIds.has(d.id));
        }
        // Users for department-head selection — needed only by the create-request
        // form, so don't hand the full employee directory to roles that can't
        // create requests (L8).
        if (canCreateRequests) {
          const userRows = await db
            .select({ id: schema.users.id, fullName: schema.users.fullName })
            .from(schema.users)
            .where(and(eq(schema.users.holdingId, u.holdingId), eq(schema.users.status, 'active')));
          const userIds = userRows.map((u0: { id: string }) => u0.id);
          const explicitDeptRows = userIds.length
            ? await db
                .select({
                  userId: schema.userDepartments.userId,
                  id: schema.departments.id,
                  name: schema.departments.name,
                  nameUz: schema.departments.nameUz,
                  nameTr: schema.departments.nameTr,
                })
                .from(schema.userDepartments)
                .innerJoin(schema.departments, eq(schema.departments.id, schema.userDepartments.departmentId))
                .where(inArray(schema.userDepartments.userId, userIds))
            : [];
          const scopedDeptRows = userIds.length
            ? await db
                .select({
                  userId: schema.userRoles.userId,
                  id: schema.departments.id,
                  name: schema.departments.name,
                  nameUz: schema.departments.nameUz,
                  nameTr: schema.departments.nameTr,
                })
                .from(schema.userRoles)
                .innerJoin(schema.departments, eq(schema.departments.id, schema.userRoles.departmentId))
                .where(and(inArray(schema.userRoles.userId, userIds), eq(schema.userRoles.status, 'active')))
            : [];
          const deptsByUser = new Map<string, { id: string; name: string; nameUz: string | null; nameTr: string | null }[]>();
          for (const d of [...explicitDeptRows, ...scopedDeptRows] as { userId: string; id: string; name: string; nameUz: string | null; nameTr: string | null }[]) {
            const existing = deptsByUser.get(d.userId) ?? [];
            if (!existing.some((x) => x.id === d.id)) {
              deptsByUser.set(d.userId, [...existing, { id: d.id, name: d.name, nameUz: d.nameUz, nameTr: d.nameTr }]);
            }
          }
          users = userRows.map((u0: { id: string; fullName: string }) => {
            const userDepts = deptsByUser.get(u0.id) ?? [];
            return { id: u0.id, fullName: u0.fullName, departmentId: userDepts[0]?.id ?? null, departments: userDepts };
          });
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
          needs_revision: 'Возвращено на доработку',
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

  // Unit types for the create-request wizard's "Ед. изм." field — read-only, any
  // authenticated tenant member (managed from /api/admin/unit-types by an admin).
  r.get('/unit-types', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId) {
        res.json([]);
        return;
      }
      const rows = await db
        .select()
        .from(schema.unitTypes)
        .where(and(eq(schema.unitTypes.holdingId, u.holdingId), eq(schema.unitTypes.status, 'active')))
        .orderBy(schema.unitTypes.orderIndex);
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // Active nomenclature for request-item autocomplete. Request creators may
  // search by either SKU or any localized product title; catalog management
  // remains behind the separate admin permissions.
  r.get('/materials', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'requests.create', u.holdingId))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const search = String(req.query.search ?? '').trim();
      const where = search
        ? and(
            eq(schema.materials.holdingId, u.holdingId),
            eq(schema.materials.status, 'active'),
            or(
              ilike(schema.materials.sku, `%${search}%`),
              ilike(schema.materials.name, `%${search}%`),
              ilike(schema.materials.nameUz, `%${search}%`),
              ilike(schema.materials.nameTr, `%${search}%`),
            ),
          )
        : and(eq(schema.materials.holdingId, u.holdingId), eq(schema.materials.status, 'active'));
      const rows = await db
        .select({
          id: schema.materials.id,
          sku: schema.materials.sku,
          name: schema.materials.name,
          nameUz: schema.materials.nameUz,
          nameTr: schema.materials.nameTr,
          defaultUnit: schema.materials.defaultUnit,
        })
        .from(schema.materials)
        .where(where)
        .orderBy(schema.materials.name)
        .limit(5000);
      res.json(rows);
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
      const canViewRequests =
        (await hasPermissionInHolding(db, u.id, 'requests.view', u.holdingId)) ||
        (await hasPermissionInHolding(db, u.id, 'requests.view_own', u.holdingId));
      if (!canViewRequests) {
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
      const conds: (SQL | undefined)[] = [
        eq(schema.requests.holdingId, u.holdingId),
        ne(schema.requests.status, 'deleted'),
      ];
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
        // FIXES 2026-07-17 (лист C): заявки везде идут от первой созданной вниз.
        .orderBy(schema.requests.createdAt)
        .limit(limit + 1) // fetch one extra to detect "has more"
        .offset(offset);
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const [{ total }] = await db.select({ total: count() }).from(schema.requests).where(where);
      // Money gate (bug #9): суммы — денежным правам и согласующим от шага
      // закупки и дальше; ранние роли (рук. отдела, склад) их не видят.
      const listMoney = await getMoneyVisibility(db, u.id);
      // Лист Excel №5: карточки списка показывают «Отдел снабжения» — резолвим
      // имя отдела по departmentId (заявка адресуется отделу по id, имя не хранится).
      const listDeptIds = [...new Set(rows.map((r: any) => r.departmentId).filter(Boolean))] as string[];
      const listDept = new Map<string, { name: string; nameUz: string | null; nameTr: string | null }>();
      if (listDeptIds.length) {
        const deps = await db
          .select({ id: schema.departments.id, name: schema.departments.name, nameUz: schema.departments.nameUz, nameTr: schema.departments.nameTr })
          .from(schema.departments)
          .where(inArray(schema.departments.id, listDeptIds));
        for (const d of deps as { id: string; name: string; nameUz: string | null; nameTr: string | null }[]) listDept.set(d.id, d);
      }
      const items = rows.map((r: any) => {
        const base = { ...r, ...deptNameFields(r.departmentId ? listDept.get(r.departmentId) : undefined, r.departmentName ?? null) };
        return listMoney.canSee(r) ? base : { ...base, estimatedAmount: null };
      });
      res.json({ items, hasMore, offset, limit, total });
    } catch (e) {
      next(e);
    }
  });

  // Экспорт списка заявок в CSV (Excel открывает напрямую; чат «Снабжение» 19.06).
  // Та же видимость и денежный гейт, что и у списка. Только reports.view.
  // Объявлен до /requests/:id, чтобы «export» не читался как id.
  r.get('/requests/export', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'reports.view', u.holdingId))) {
        res.status(403).json({ error: 'Недостаточно прав для экспорта' });
        return;
      }
      const q = req.query;
      const vis = await getRequestVisibility(db, u.id);
      const conds: (SQL | undefined)[] = [
        eq(schema.requests.holdingId, u.holdingId),
        ne(schema.requests.status, 'deleted'),
      ];
      if (vis.scope) conds.push(vis.scope);
      const status = String(q.status ?? '').trim();
      if (status) conds.push(eq(schema.requests.status, status));
      if (String(q.mine ?? '') === '1') conds.push(eq(schema.requests.requesterId, u.id));
      const rows = await db
        .select()
        .from(schema.requests)
        .where(and(...conds.filter(Boolean) as SQL[]))
        // FIXES 2026-07-17 (лист C): от первой созданной вниз.
        .orderBy(schema.requests.createdAt)
        .limit(2000);

      const userIds = [...new Set(rows.map((r: any) => r.requesterId).filter(Boolean))] as string[];
      const users = userIds.length
        ? await db.select({ id: schema.users.id, fullName: schema.users.fullName }).from(schema.users).where(inArray(schema.users.id, userIds))
        : [];
      const nameBy = new Map((users as { id: string; fullName: string }[]).map((x) => [x.id, x.fullName]));
      const depts = await db.select().from(schema.departments).where(eq(schema.departments.holdingId, u.holdingId));
      const deptBy = new Map((depts as { id: string; name: string }[]).map((d) => [d.id, d.name]));
      const facs = await db.select().from(schema.factories).where(eq(schema.factories.holdingId, u.holdingId));
      const facBy = new Map((facs as { id: string; name: string }[]).map((f) => [f.id, f.name]));
      const exportMoney = await getMoneyVisibility(db, u.id);

      const esc = (v: unknown): string => {
        const t = v == null ? '' : String(v);
        return /[";\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      };
      const dateStr = (d: unknown): string => (d ? new Date(d as string).toISOString().slice(0, 10) : '');
      const header = ['Номер', 'Название', 'Статус', 'Приоритет', 'Тип', 'Отдел', 'Завод', 'Автор', 'Создана', 'Нужно к', 'Сумма', 'Валюта'];
      const lines = [header.join(';')];
      for (const r0 of rows as any[]) {
        lines.push([
          esc(r0.requestNumber),
          esc(r0.title),
          esc(await statusLabelFor(db, r0)),
          esc(r0.priority),
          esc(r0.requestType),
          esc(r0.departmentId ? deptBy.get(r0.departmentId) ?? '' : r0.departmentName ?? ''),
          esc(r0.factoryId ? facBy.get(r0.factoryId) ?? '' : ''),
          esc(r0.requesterId ? nameBy.get(r0.requesterId) ?? '' : ''),
          dateStr(r0.createdAt),
          dateStr(r0.neededDate),
          exportMoney.canSee(r0) && r0.estimatedAmount != null ? String(r0.estimatedAmount) : '',
          esc(r0.currency ?? 'UZS'),
        ].join(';'));
      }
      // BOM — чтобы Excel корректно открыл UTF-8 (кириллицу) без импорта.
      const csv = '\ufeff' + lines.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="requests-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
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
      const requesterId = String(body.requesterId ?? u.id).trim() || u.id;
      const [requester] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(
          eq(schema.users.id, requesterId),
          eq(schema.users.holdingId, u.holdingId),
          eq(schema.users.status, 'active'),
        ))
        .limit(1);
      if (!requester) {
        res.status(400).json({ error: 'Выбранный заявитель не найден среди активных сотрудников' });
        return;
      }
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
        requesterId,
        creatorId: u.id,
        factoryId: body.factoryId ?? null,
        departmentId: body.departmentId ?? null,
        requestType: body.requestType,
        priority: PRIORITIES.includes(body.priority) ? body.priority : undefined,
        warehouseId: body.warehouseId ?? null,
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
          // Лист Excel №5: карточка несёт «Объект» и «Нужно к» наравне с прочими полями.
          neededDate: raw.neededDate ?? null,
          obyekt: raw.customFields && typeof raw.customFields === 'object' ? ((raw.customFields as Record<string, unknown>).obyekt ?? null) : null,
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
      if (!reqRow || reqRow.status === 'deleted') {
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
        .where(eq(schema.requestItems.requestId, reqRow.id))
        .orderBy(schema.requestItems.sortOrder, schema.requestItems.id);
      const approvals = await db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.requestId, reqRow.id))
        .orderBy(schema.approvals.createdAt);
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
      // FIXES 2026-07-20: ВСЕ предложения видит только отдел снабжения; остальным
      // (директор, исп. дир, финансы, аудит) отдаётся только ВЫБРАННОЕ КП —
      // конкурирующие цены за пределы снабжения не выходят.
      const isProcurementViewer = ['procurement.view', 'procurement.quote', 'procurement.select_supplier']
        .some((p) => viewerCodes.includes(p));
      const allQuotes = canSeeQuotes
        ? await db
            .select()
            .from(schema.quotations)
            .where(eq(schema.quotations.requestId, reqRow.id))
            .orderBy(schema.quotations.createdAt)
        : [];
      const quotations = isProcurementViewer ? allQuotes : allQuotes.filter((q: { selected: boolean }) => q.selected);
      const actions = await availableActions(db, reqRow, u.id);
      // Build workflow timeline with per-step state + WHO/WHEN acted (bugs #4, #7, #10).
      type TLState = 'completed' | 'current' | 'future' | 'rejected' | 'cancelled' | 'returned';
      // FIXES 2026-07-17 (лист E): возврат на доработку показывается ЧЕСТНО —
      // пройденные шаги остаются зелёными, шаг, вернувший заявку, помечается
      // «Возвращено на доработку» (с автором и комментарием), дальше — серые
      // будущие шаги. Раньше весь маршрут красился «Отменено».
      const returnedToAuthor = reqRow.status === 'needs_revision';
      const returnEvent = returnedToAuthor
        ? [...(statusHistory as { oldStatus: string | null; newStatus: string; changedBy: string | null; createdAt: unknown; comment: string | null }[])]
            .reverse()
            .find((h) => h.newStatus === 'needs_revision' && h.oldStatus && h.oldStatus !== 'needs_revision')
        : undefined;
      // Approval steps all share `pending_approval`, so oldStatus alone cannot
      // identify which approval returned the request. The cancelled/rejected
      // approval row carries the exact workflowStepId and the same actor/comment.
      const returnApproval = returnEvent
        ? [...(approvals as {
            workflowStepId: string | null; status: string; approverUserId: string | null;
            comment: string | null; approvedAt: unknown; createdAt: unknown;
          }[])]
            .reverse()
            .find((a) =>
              a.workflowStepId != null
              && (a.status === 'cancelled' || a.status === 'rejected')
              && (!returnEvent.changedBy || a.approverUserId === returnEvent.changedBy)
              && (!returnEvent.comment || !a.comment || a.comment === returnEvent.comment),
            )
        : undefined;
      let workflowTimeline: {
        stepId: string; stepName: string; stepKind: string; state: TLState;
        actorName: string | null; actorRole: string | null; at: unknown; action: string | null;
        comment: string | null;
      }[] = [];
      if (reqRow.workflowId) {
        const allSteps = await db
          .select()
          .from(schema.workflowSteps)
          .where(eq(schema.workflowSteps.workflowId, reqRow.workflowId));
        // A user may hold several roles. The role displayed beneath a completed
        // timeline stage must be the role assigned to that workflow step, not an
        // arbitrary first role from the actor's account.
        const timelineRoleIds = [...new Set<string>(
          (allSteps as { approverRoleId: string | null }[])
            .flatMap((s) => (s.approverRoleId ? [s.approverRoleId] : [])),
        )];
        const timelineRoleNames = new Map<string, string>();
        if (timelineRoleIds.length) {
          const timelineRoles = await db
            .select({ id: schema.roles.id, name: schema.roles.name })
            .from(schema.roles)
            .where(inArray(schema.roles.id, timelineRoleIds));
          for (const role of timelineRoles) timelineRoleNames.set(role.id, role.name);
        }
        // FIXES 2026-07-17 (лист B): авто-пропущенные шаги (автор — единственный
        // согласующий своего шага, напр. начальник отдела создал заявку сам)
        // в «Процессе согласования» не показываем вовсе.
        const skippedStepNames = new Set(
          (statusHistory as { source: string | null; comment: string | null }[])
            .filter((h) => h.source === 'auto_skip')
            .map((h) => /«(.+)»/.exec(h.comment ?? '')?.[1])
            .filter((n): n is string => Boolean(n)),
        );
        const sorted = allSteps
          .filter((s: { enabled: boolean }) => s.enabled !== false)
          .filter((s: { stepName: string }) => !skippedStepNames.has(s.stepName))
          .sort((a: { stepOrder: number }, b: { stepOrder: number }) => a.stepOrder - b.stepOrder);

        // Resolved action per step (approved / rejected) from the approvals rows.
        // Non-approval steps do not have approval rows, so below we fall back to
        // lifecycle status history: the actor who moved out of that step.
        const stepAction = new Map<string, { action: string; at: unknown; actorId: string | null; comment: string | null }>();
        for (const a of approvals as { workflowStepId: string | null; status: string; approvedAt: unknown; createdAt: unknown; approverUserId: string | null; comment: string | null }[]) {
          if (a.workflowStepId && (a.status === 'approved' || a.status === 'rejected')) {
            stepAction.set(a.workflowStepId, { action: a.status, at: a.approvedAt ?? a.createdAt, actorId: a.approverUserId, comment: a.comment ?? null });
          }
        }
        type TimelineHistory = {
          oldStatus: string | null;
          newStatus: string;
          changedBy: string | null;
          createdAt: unknown;
          source: string | null;
        };
        const historyByOldStatus = new Map<string, TimelineHistory[]>();
        for (const h of statusHistoryOut as TimelineHistory[]) {
          if (!h.changedBy || h.source === 'auto_skip' || !h.oldStatus) continue;
          const bucket = historyByOldStatus.get(h.oldStatus) ?? [];
          bucket.push(h);
          historyByOldStatus.set(h.oldStatus, bucket);
        }
        const usedHistoryByStatus = new Map<string, number>();
        const historyForStep = (
          s: { stepKind: string },
          state: TLState,
        ): { action: string; at: unknown; actorId: string | null } | null => {
          const stepStatus = statusForStep(s);
          const events = historyByOldStatus.get(stepStatus) ?? [];
          if (!events.length) return null;
          const used = usedHistoryByStatus.get(stepStatus) ?? 0;
          const firstUnusedAdvance = events.findIndex((e, idx) => idx >= used && e.oldStatus !== e.newStatus);
          if (state === 'completed' || state === 'rejected' || state === 'cancelled') {
            const index = firstUnusedAdvance >= 0 ? firstUnusedAdvance : used;
            const event = events[index];
            if (!event) return null;
            usedHistoryByStatus.set(stepStatus, index + 1);
            return { action: state === 'rejected' ? 'rejected' : 'completed', at: event.createdAt, actorId: event.changedBy };
          }
          if (state === 'current') {
            const sameStep = [...events].reverse().find((e) => e.oldStatus === e.newStatus);
            return sameStep ? { action: 'updated', at: sameStep.createdAt, actorId: sameStep.changedBy } : null;
          }
          return null;
        };
        // Rejected request → the step where it was rejected splits the timeline. (#4)
        const rejectedStep = sorted.find((s: { id: string }) => stepAction.get(s.id)?.action === 'rejected');
        const rejectedOrder = rejectedStep ? (rejectedStep as { stepOrder: number }).stepOrder : null;

        // Шаг, вернувший заявку автору: его статус = oldStatus события возврата.
        const returnStepIndex = returnEvent
          ? returnApproval?.workflowStepId
            ? (sorted as { id: string }[]).findIndex((s) => s.id === returnApproval.workflowStepId)
            : (sorted as { stepKind: string }[]).findIndex((s) => statusForStep(s as any) === returnEvent.oldStatus)
          : -1;

        let foundCurrent = false;
        for (const [stepIdx, s] of (sorted as any[]).entries()) {
          let state: TLState;
          if (returnedToAuthor) {
            // FIXES 2026-07-17 (лист E): до вернувшего шага — пройдено, сам шаг —
            // «Возвращено на доработку», дальше — будущие.
            if (returnStepIndex >= 0) {
              state = stepIdx < returnStepIndex ? 'completed' : stepIdx === returnStepIndex ? 'returned' : 'future';
            } else {
              state = 'cancelled';
            }
          } else if (rejectedOrder != null) {
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
          // Вернувший шаг несёт автора/время/комментарий события возврата (лист E).
          const act = state === 'returned' && returnEvent
            ? { action: 'returned', at: returnEvent.createdAt, actorId: returnEvent.changedBy, comment: returnEvent.comment ?? null }
            : stepAction.get(s.id) ?? historyForStep(s, state);
          const actor = act?.actorId ? actorMap.get(act.actorId) : undefined;
          workflowTimeline.push({
            stepId: s.id,
            stepName: s.stepName,
            stepKind: s.stepKind,
            state,
            action: act?.action ?? null,
            at: act?.at ?? null,
            actorName: actor?.name ?? null,
            actorRole: s.approverRoleId
              ? timelineRoleNames.get(s.approverRoleId) ?? actor?.role ?? null
              : actor?.role ?? null,
            comment: (act as { comment?: string | null } | null)?.comment ?? null,
          });
        }
      }

      // Resolve human names for the full info card (bug #9).
      const [requesterRow] = reqRow.requesterId
        ? await db.select({ name: schema.users.fullName }).from(schema.users).where(eq(schema.users.id, reqRow.requesterId))
        : [];
      const requesterRoleRows = reqRow.requesterId
        ? await db
            .select({ code: schema.roles.code, name: schema.roles.name, assignedAt: schema.userRoles.assignedAt })
            .from(schema.userRoles)
            .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
            .where(and(eq(schema.userRoles.userId, reqRow.requesterId), eq(schema.userRoles.status, 'active')))
            .orderBy(schema.userRoles.assignedAt)
        : [];
      // Prefer the requester's business role over the generic Assistant role.
      // This fixes requests created directly by a department head (and similar
      // roles) while retaining Assistant for ordinary requesters.
      const requesterRole = requesterRoleRows.find((r: { code: string }) => r.code !== 'requester')
        ?? requesterRoleRows[0];
      const [respRow] = reqRow.responsibleUserId
        ? await db.select({ name: schema.users.fullName }).from(schema.users).where(eq(schema.users.id, reqRow.responsibleUserId))
        : [];
      const [facRow] = reqRow.factoryId
        ? await db.select({ name: schema.factories.name }).from(schema.factories).where(eq(schema.factories.id, reqRow.factoryId))
        : [];
      const [depRow] = reqRow.departmentId
        ? await db
            .select({ name: schema.departments.name, nameUz: schema.departments.nameUz, nameTr: schema.departments.nameTr })
            .from(schema.departments)
            .where(eq(schema.departments.id, reqRow.departmentId))
        : [];

      // Progress starts with the REQUESTER (who created it), then the approval steps.
      workflowTimeline.unshift({
        stepId: 'created',
        stepName: 'Создание заявки',
        stepKind: 'created',
        state: 'completed',
        action: 'created',
        at: reqRow.createdAt,
        actorName: requesterRow?.name ?? null,
        actorRole: requesterRole?.name === 'Заместитель директора'
          ? 'Главный инженер'
          : requesterRole?.name ?? 'Assistant',
        comment: null,
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

      // Кастомные поля: сырые ключи/коды («purpose: repair») резолвим в подписи
      // конструктора формы («Назначение / цель: Ремонт оборудования») — фронт
      // не должен знать конфиг формы (сервер — источник истины).
      let customInfo: { label: string; value: string }[] = [];
      const cfEntries = reqRow.customFields && typeof reqRow.customFields === 'object'
        ? Object.entries(reqRow.customFields as Record<string, unknown>)
        : [];
      if (cfEntries.length) {
        const ff = await db
          .select()
          .from(schema.formFields)
          .where(and(eq(schema.formFields.holdingId, reqRow.holdingId), eq(schema.formFields.screen, 'request_create')));
        const fieldByKey = new Map((ff as any[]).map((f) => [f.fieldKey, f]));
        for (const [k, v] of cfEntries) {
          if (v == null || String(v).trim() === '' || v === false) continue;
          const f = fieldByKey.get(k);
          let value = v === true ? 'Да' : String(v);
          const opts = f?.options as { value: string; label: string }[] | null;
          if (Array.isArray(opts)) {
            const o = opts.find((x) => x.value === value);
            if (o) value = o.label;
          }
          customInfo.push({ label: f?.label ?? k, value });
        }
      }

      // Кнопки/поля на фронте — только из ответа сервера: canEdit повторяет
      // ровно ту проверку, которой PUT /requests/:id пропускает правку.
      const canEdit = canEditRequestRow(reqRow, u.id, viewerCodes, approvals);

      res.json({
        ...reqRow,
        estimatedAmount: canSeeMoney ? reqRow.estimatedAmount : null,
        requesterName: requesterRow?.name ?? null,
        responsibleName: respRow?.name ?? null,
        factoryName: facRow?.name ?? null,
        ...deptNameFields(depRow, reqRow.departmentName ?? null),
        statusLabel: await statusLabelFor(db, reqRow),
        items: itemsOut,
        approvals,
        quotations,
        canSeeMoney,
        actions,
        canEdit,
        statusHistory: canSeeHistory ? statusHistoryOut : [],
        auditTrail,
        customInfo,
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
      // FIXES 2026-07-17 (лист G): у «Пересмотреть цену» (return_research) свой
      // список причин (псевдо-роль price_review), без общих и ролевых.
      const actionParam = String(req.query.action ?? '').trim();
      if (actionParam === 'return_research') {
        const priceRows = await db
          .select()
          .from(schema.rejectionReasons)
          .where(
            and(
              eq(schema.rejectionReasons.isActive, true),
              or(isNull(schema.rejectionReasons.holdingId), eq(schema.rejectionReasons.holdingId, u.holdingId as string)),
              eq(schema.rejectionReasons.roleCode, 'price_review'),
            ),
          )
          .orderBy(schema.rejectionReasons.sortOrder);
        const uniq = new Set<string>();
        res.json({ reasons: priceRows.map((r: { text: string }) => r.text).filter((t: string) => (uniq.has(t) ? false : (uniq.add(t), true))) });
        return;
      }
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
            // Псевдо-роль price_review сюда не попадает: roleCode шага — реальная
            // роль, а строки без роли фильтр ниже пропускает только по isNull.
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
        const assignedRoles = await db
          .select({ code: schema.roles.code, name: schema.roles.name })
          .from(schema.userRoles)
          .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
          .where(and(eq(schema.userRoles.userId, usr.id), eq(schema.userRoles.status, 'active')));
        if (assignedRoles.some((r: { code: string; name: string }) => ['owner', 'procurement_head'].includes(r.code) || ['Учредитель', 'Руководитель снабжения'].includes(r.name))) continue;
        const codes = await getUserPermissionCodes(db, usr.id);
        if (['procurement.quote', 'procurement.select_supplier', 'procurement.view'].some((p) => codes.includes(p))) out.push(usr);
      }
      res.json({ users: out });
    } catch (e) {
      next(e);
    }
  });

  r.get('/procurement/settings', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      if (!u.holdingId) { res.json({ paymentTypes: [] }); return; }
      const codes = await getUserPermissionCodes(db, u.id);
      if (!['procurement.view', 'procurement.quote', 'procurement.select_supplier'].some((p) => codes.includes(p))) {
        res.status(403).json({ error: 'Недостаточно прав' });
        return;
      }
      const [row] = await db
        .select({ value: schema.settings.value })
        .from(schema.settings)
        .where(and(eq(schema.settings.holdingId, u.holdingId), eq(schema.settings.key, 'payment_types')));
      const raw = String(row?.value ?? 'Перечисление,Наличные');
      const paymentTypes = raw.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
      res.json({ paymentTypes });
    } catch (e) {
      next(e);
    }
  });

  // #3 Пер-позиционная отметка наличия на шаге склада (кнопки в карточке позиции).
  r.post('/requests/:id/items/:itemId/stock', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const out = await markItemStock(db, {
        requestId: req.params.id as string,
        itemId: req.params.itemId as string,
        inStock: (req.body ?? {}).inStock === true,
        actor: { id: u.id, holdingId: u.holdingId },
      });
      res.json(out);
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
      const [fromStep] = fromStepId
        ? await db.select({ stepKind: schema.workflowSteps.stepKind }).from(schema.workflowSteps).where(eq(schema.workflowSteps.id, fromStepId))
        : [];
      const result = await performAction(db, {
        requestId: req.params.id as string,
        action: String(body.action ?? ''),
        actor: { id: u.id, holdingId: u.holdingId },
        pin: body.pin,
        comment: body.comment,
        amount: body.amount,
        supplierName: body.supplierName,
        supplierId: body.supplierId,
        supplierPhone: body.supplierPhone,
        ndsIncluded: body.ndsIncluded,
        paymentType: body.paymentType,
        quoteItems: Array.isArray(body.quoteItems) ? body.quoteItems : undefined,
        leadTime: body.leadTime,
        quotationId: body.quotationId,
        assigneeId: body.assigneeId,
        receipts: Array.isArray(body.receipts) ? body.receipts : undefined,
      });
      const stepLabel = await statusLabelFor(db, result);
      // Ответственные следующего шага — ТОЛЬКО когда шаг реально сменился.
      // Раньше пуш «требуется согласование» уходил на КАЖДОЕ действие (в т.ч.
      // «Добавить КП», не двигающее заявку) — согласующих заваливало дублями.
      const stepChanged = (result.currentStepId ?? null) !== fromStepId;
      if (result.currentStepId && stepChanged) {
        notifyStepApprovers(db, notify, result.id, result.currentStepId, { actorId: u.id }).catch(() => {});
      }
      if (!result.currentStepId && result.status === 'closed' && fromStep?.stepKind === 'receiving') {
        notifyDeptHeadAfterReceiving(db, notify, result.id, { actorId: u.id }).catch(() => {});
      }
      // Ветка «есть в наличии»: руководителю отдела — только уведомление (без
      // согласования); заявка уходит на выдачу со склада (FIXES 2026-07-20).
      if (['wh_in_stock', 'wh_partial'].includes(String(body.action)) && result.inStock === true) {
        notifyDeptHeadInStock(db, notify, result.id, { actorId: u.id }).catch(() => {});
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

  // FIXES 2026-07-20 (тест): override учредителя жил только в compat-слое,
  // который на стендах не смонтирован — право approvals.override (owner,
  // директор) было мёртвым, при том что эскалация L2 сигналит именно его
  // держателям. Портировано в основной API: PIN + обязательная причина,
  // разрешение/отклонение мимо оставшихся шагов, полная история + аудит.
  r.post('/requests/:id/override', auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedRequest).user!;
      const b = req.body ?? {};
      if (!u.holdingId || !(await hasPermissionInHolding(db, u.id, 'approvals.override', u.holdingId))) {
        res.status(403).json({ error: 'Нужно право approvals.override' });
        return;
      }
      if (!['approve', 'cancel'].includes(String(b.action))) {
        res.status(400).json({ error: 'action: approve | cancel' });
        return;
      }
      const reason = String(b.reason ?? b.comment ?? '').trim();
      if (!reason) {
        res.status(400).json({ error: 'Причина обязательна' });
        return;
      }
      const [usr] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
      if (!usr?.pinHash) {
        res.status(403).json({ error: 'PIN не задан — задайте PIN в настройках' });
        return;
      }
      const lockMs = pinLockoutRemaining(u.id);
      if (lockMs > 0) {
        res.status(403).json({ error: `PIN заблокирован, повторите через ${Math.ceil(lockMs / 60000)} мин` });
        return;
      }
      if (!verifyPin(String(b.pin ?? ''), usr.pinHash)) {
        const locked = recordPinFailure(u.id);
        res.status(403).json({ error: locked ? 'Слишком много попыток — блокировка 15 мин' : 'Неверный PIN' });
        return;
      }
      clearPinFailures(u.id);
      const [rq] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
      if (!rq || rq.holdingId !== u.holdingId) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (isTerminalStatus(rq.status)) {
        res.status(400).json({ error: 'Заявка уже завершена' });
        return;
      }
      const newStatus = b.action === 'approve' ? 'approved' : 'rejected';
      await db.transaction(async (tx: Db) => {
        await tx
          .update(schema.approvals)
          .set({
            status: b.action === 'approve' ? 'approved' : 'rejected',
            approverUserId: u.id,
            comment: 'OWNER OVERRIDE: ' + reason,
            approvedAt: new Date(),
          })
          .where(and(eq(schema.approvals.requestId, rq.id), eq(schema.approvals.status, 'pending')));
        await tx
          .update(schema.requests)
          .set({ status: newStatus, currentStepId: null, updatedAt: new Date(), closedAt: new Date() })
          .where(eq(schema.requests.id, rq.id));
        await tx.insert(schema.requestStatusHistory).values({
          requestId: rq.id,
          oldStatus: rq.status,
          newStatus,
          changedBy: u.id,
          comment: 'OWNER OVERRIDE: ' + reason,
          source: 'api',
        });
        await tx.insert(schema.auditLogs).values({
          holdingId: rq.holdingId,
          userId: u.id,
          action: 'OWNER_OVERRIDE',
          module: 'approvals',
          entityType: 'request',
          entityId: rq.id,
          newValue: { action: String(b.action), reason },
          source: 'api',
        });
      });
      if (rq.requesterId !== u.id) {
        if (newStatus === 'approved') notifyRequester(db, notify, rq.id, 'approved_final', (rn) => approvedFinalMessage(rn));
        else notifyRequester(db, notify, rq.id, 'rejected', (rn) => rejectedMessage(rn, reason));
      }
      res.json({ ok: true, status: newStatus });
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

  // POST /approvals/:id/approve|reject удалены из канонического API: мини-апп
  // согласует только через lifecycle (POST /requests/:id/action), а второй
  // работающий путь записи — риск рассинхрона с движком (класс C1). Легаси-дизайн
  // (SERVE_DESIGN=1) обслуживает свой экземпляр в compat.routes.ts.

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
      const requestApprovals = await db
        .select({ status: schema.approvals.status })
        .from(schema.approvals)
        .where(eq(schema.approvals.requestId, reqRow.id));
      const editPermissions = await getUserPermissionCodes(db, u.id);
      // Only the author OR someone with requests.edit can update
      const isAuthor = reqRow.requesterId === u.id;
      const hasEditPermission = editPermissions.includes('requests.edit');
      if (!isAuthor && !hasEditPermission) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      if (!canEditRequestRow(reqRow, u.id, editPermissions, requestApprovals)) {
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
      // Лист Excel №1: автор может править всю заявку (не только название/описание/
      // приоритет/склад). Тип, отдел и настраиваемые поля (объект, место закупа).
      if (body.requestType !== undefined && String(body.requestType).trim()) patch.requestType = String(body.requestType).trim();
      if (body.departmentId !== undefined) patch.departmentId = body.departmentId ? String(body.departmentId) : null;
      if (body.customFields !== undefined && body.customFields && typeof body.customFields === 'object') {
        // Мержим, чтобы правка одного поля не стирала прочие настраиваемые значения.
        const existingCf = (reqRow.customFields && typeof reqRow.customFields === 'object') ? reqRow.customFields as Record<string, unknown> : {};
        const incoming = body.customFields as Record<string, unknown>;
        const merged: Record<string, unknown> = { ...existingCf };
        for (const [k, v] of Object.entries(incoming)) {
          if (v === '' || v == null) delete merged[k];
          else merged[k] = v;
        }
        patch.customFields = merged;
      }
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
      const itemEdits = Array.isArray(body.items) ? body.items : null;
      const [updated] = await db.transaction(async (tx: Db) => {
        let oldItems: unknown[] | undefined;
        let newItems: unknown[] | undefined;
        if (itemEdits) {
          const existingItems = await tx
            .select()
            .from(schema.requestItems)
            .where(eq(schema.requestItems.requestId, reqRow.id));
          oldItems = existingItems.map((it: any) => ({
            id: it.id,
            name: it.name,
            quantity: Number(it.quantity),
            unit: it.unit,
            description: it.description,
            estimatedPrice: it.estimatedPrice,
            totalAmount: it.totalAmount,
          }));
          const existingById = new Map<string, any>(existingItems.map((it: any) => [it.id, it]));
          const cleaned = itemEdits
            .map((raw: any) => {
              const id = raw?.id ? String(raw.id) : null;
              const prev = id ? existingById.get(id) : null;
              const name = String(raw?.name ?? '').trim();
              const quantity = Number(raw?.quantity);
              const suppliedUnitPrice = raw?.unitPrice !== undefined && raw?.unitPrice !== null && raw?.unitPrice !== '';
              const unitPrice = suppliedUnitPrice ? Number(raw.unitPrice) : Number(prev?.estimatedPrice ?? 0);
              return {
                id,
                name,
                quantity,
                unit: raw?.unit == null || String(raw.unit).trim() === '' ? null : String(raw.unit).trim(),
                description: raw?.description == null || String(raw.description).trim() === '' ? null : String(raw.description).trim(),
                unitPrice,
              };
            })
            .filter((it: any) => it.name);
          if (cleaned.length === 0) {
            throw new ValidationError('Добавьте хотя бы один продукт');
          }
          for (const it of cleaned) {
            if (!Number.isFinite(it.quantity) || it.quantity <= 0) {
              throw new ValidationError('Количество продукта должно быть больше нуля');
            }
            // FIXES 2026-07-20 (тест): верхние границы — как при создании заявки.
            if (it.quantity > MAX_ITEM_QUANTITY) {
              throw new ValidationError('Количество слишком велико (максимум 1 млрд)');
            }
            if (!Number.isFinite(it.unitPrice) || it.unitPrice < 0) {
              throw new ValidationError('Цена продукта должна быть неотрицательным числом');
            }
            if (it.unitPrice > MAX_ITEM_PRICE) {
              throw new ValidationError('Цена за единицу слишком велика');
            }
          }
          patch.estimatedAmount = Math.round(cleaned.reduce((sum: number, it: any) => sum + it.quantity * it.unitPrice, 0));
          await tx.delete(schema.requestItems).where(eq(schema.requestItems.requestId, reqRow.id));
          for (const [index, it] of cleaned.entries()) {
            await tx.insert(schema.requestItems).values({
              requestId: reqRow.id,
              name: it.name,
              description: it.description,
              quantity: String(it.quantity),
              unit: it.unit,
              estimatedPrice: Math.round(it.unitPrice),
              totalAmount: Math.round(it.quantity * it.unitPrice),
              sortOrder: index,
            });
          }
          newItems = cleaned.map((it: any) => ({
            name: it.name,
            quantity: it.quantity,
            unit: it.unit,
            description: it.description,
            estimatedPrice: Math.round(it.unitPrice),
            totalAmount: Math.round(it.quantity * it.unitPrice),
          }));
        }
        const [row] = await tx
          .update(schema.requests)
          .set(patch)
          .where(eq(schema.requests.id, reqRow.id))
          .returning();
        await tx.insert(schema.auditLogs).values({
          holdingId: reqRow.holdingId,
          userId: u.id,
          action: 'request.edited',
          module: 'requests',
          entityType: 'request',
          entityId: reqRow.id,
          oldValue: { title: reqRow.title, description: reqRow.description, items: oldItems },
          newValue: { ...patch, items: newItems },
          source: 'api',
        });
        return [row];
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
      const phone = clean(body.phone);
      const normalizedPhone = phone ? normalizePhone(phone) : null;
      if (normalizedPhone) {
        const [samePhone] = await db.select({ id: schema.suppliers.id }).from(schema.suppliers).where(and(
          eq(schema.suppliers.holdingId, u.holdingId), eq(schema.suppliers.normalizedPhone, normalizedPhone),
        )).limit(1);
        if (samePhone) { res.status(409).json({ error: 'Поставщик с таким номером уже существует' }); return; }
      }
      const [row] = await db
        .insert(schema.suppliers)
        .values({
          holdingId: u.holdingId,
          name,
          inn: clean(body.inn),
          phone: normalizedPhone,
          normalizedPhone,
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
      for (const f of ['name', 'inn', 'email', 'contactPerson', 'category', 'note'] as const) {
        if (body[f] !== undefined) patch[f] = body[f] == null ? null : String(body[f]).trim();
      }
      if (body.phone !== undefined) {
        const normalizedPhone = body.phone == null || String(body.phone).trim() === '' ? null : normalizePhone(String(body.phone));
        if (normalizedPhone) {
          const [samePhone] = await db.select({ id: schema.suppliers.id }).from(schema.suppliers).where(and(
            eq(schema.suppliers.holdingId, u.holdingId), eq(schema.suppliers.normalizedPhone, normalizedPhone), ne(schema.suppliers.id, id),
          )).limit(1);
          if (samePhone) { res.status(409).json({ error: 'Поставщик с таким номером уже существует' }); return; }
        }
        patch.phone = normalizedPhone;
        patch.normalizedPhone = normalizedPhone;
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
        // FIXES 2026-07-17 (лист C): от первой созданной вниз.
        .orderBy(schema.requests.createdAt);
      // Лист Excel №5: карточка очереди показывает «Отдел снабжения» — резолвим имя.
      const pqDeptIds = [...new Set(rows.map((r: any) => r.departmentId).filter(Boolean))] as string[];
      const pqDept = new Map<string, { name: string; nameUz: string | null; nameTr: string | null }>();
      if (pqDeptIds.length) {
        const deps = await db
          .select({ id: schema.departments.id, name: schema.departments.name, nameUz: schema.departments.nameUz, nameTr: schema.departments.nameTr })
          .from(schema.departments)
          .where(inArray(schema.departments.id, pqDeptIds));
        for (const d of deps as { id: string; name: string; nameUz: string | null; nameTr: string | null }[]) pqDept.set(d.id, d);
      }
      res.json(rows.map((r: any) => ({
        ...r,
        ...deptNameFields(r.departmentId ? pqDept.get(r.departmentId) : undefined, r.departmentName ?? null),
      })));
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
  r.use('/admin', buildAdminRouter(db, auth, sessionSecret));

  return r;
}
