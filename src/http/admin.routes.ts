/**
 * Constructor / Admin API — lets an authorized user configure the tenant from the
 * admin UI: company structure (factories → departments → warehouses), people,
 * roles & permissions, and the approval workflow. Everything is scoped to the
 * actor's HOLDING (the tenancy boundary; there is no company-level admin). Guarded
 * against privilege escalation: you can never grant a permission (directly or via a
 * role) that you do not hold yourself, and you can never touch another holding's data.
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { hasPermission, type Scope } from '../rbac/rbac.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { STEP_KINDS, TERMINAL_STATUSES, ON_REJECT_POLICIES, type OnRejectPolicy } from '../workflow/step-kinds.js';
import { ValidationError, NotFoundError, ConflictError, ForbiddenError } from '../services/errors.js';
import { notifyUser } from '../services/notification.service.js';
import type { AuthedRequest, AuthedUser } from './auth.middleware.js';

// db handle is intentionally loose so the same code runs over node-postgres and pglite.
// This is the same typing seam used across the data layer; domain types below stay strict.
type Db = any;

/**
 * Statuses that are NOT live: every terminal state (approved/closed/rejected/
 * cancelled/archived) plus draft (no approval row yet). Used for BOTH the dashboard
 * "active" count and the workflow in-flight guard, so the two notions of "live"
 * never disagree. (P2-1: 'closed'/'archived' were previously missing, which pinned
 * workflowHasInFlight() to true forever after the first closed request.)
 */
const INACTIVE_REQUEST_STATUSES = [...TERMINAL_STATUSES, 'draft'];

function actor(req: Request): AuthedUser {
  return (req as AuthedRequest).user!;
}

function str(v: unknown): string {
  return String(v ?? '').trim();
}

interface AuditEntry {
  holdingId: string;
  userId: string;
  action: string;
  module: string;
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

/** Append an immutable audit record for a critical admin action. Accepts a tx handle. */
async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.insert(schema.auditLogs).values({
    holdingId: e.holdingId,
    userId: e.userId,
    action: e.action,
    module: e.module,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    oldValue: e.oldValue ?? null,
    newValue: e.newValue ?? null,
    source: 'admin',
  });
}

interface HoldingScopedRow {
  id: string;
  holdingId: string | null;
  status: string;
  name: string;
  fullName?: string; // present on the users table (which has no `name` column)
  factoryId?: string | null;
}

/** Field types the form builder supports. */
const ALLOWED_FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'date', 'checkbox', 'file'];

/** Coerce select options into a clean [{value,label,meta?}] array (or null). */
const MAX_OPTIONS = 100;
const cap = (s: string) => s.slice(0, 200);

function normalizeOptions(input: unknown): { value: string; label: string; meta?: string }[] | null {
  if (!Array.isArray(input)) return null;
  const out: { value: string; label: string; meta?: string }[] = [];
  for (const o of input) {
    if (out.length >= MAX_OPTIONS) break;
    if (typeof o === 'string') {
      const v = cap(o.trim());
      if (v) out.push({ value: v, label: v });
    } else if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      const label = cap(String(rec.label ?? rec.value ?? '').trim());
      // Empty value falls back to the label (a new option only carries a label).
      const value = cap(String(rec.value ?? '').trim()) || label;
      if (value && label) {
        const meta = cap(String(rec.meta ?? '').trim());
        out.push(meta ? { value, label, meta } : { value, label });
      }
    }
  }
  return out;
}

/** Shape a form_fields row for the API (stable keys, never leak holdingId etc.). */
function mapFormField(f: {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: string;
  system: boolean;
  required: boolean;
  enabled: boolean;
  placeholder: string | null;
  options: unknown;
  stepGroup: number;
  orderIndex: number;
}) {
  return {
    id: f.id,
    key: f.fieldKey,
    label: f.label,
    type: f.fieldType,
    system: f.system,
    required: f.required,
    enabled: f.enabled,
    placeholder: f.placeholder,
    options: f.options ?? [],
    step: f.stepGroup,
    orderIndex: f.orderIndex,
  };
}

/** Load a holding-scoped row by id, failing closed (404) if it belongs elsewhere. */
async function loadHoldingRow(db: Db, table: Db, id: string, holdingId: string): Promise<HoldingScopedRow> {
  const [row] = await db.select().from(table).where(eq(table.id, id));
  if (!row || row.holdingId !== holdingId) throw new NotFoundError('Не найдено');
  return row as HoldingScopedRow;
}

/** True if any request bound to this workflow has not reached a terminal state. */
async function workflowHasInFlight(db: Db, workflowId: string): Promise<boolean> {
  const rows: { status: string }[] = await db
    .select({ status: schema.requests.status })
    .from(schema.requests)
    .where(eq(schema.requests.workflowId, workflowId));
  return rows.some((r) => !INACTIVE_REQUEST_STATUSES.includes(r.status));
}

/** A role is usable inside a holding if it is a system role (holdingId null) or owned by it. */
async function assertRoleVisible(db: Db, roleId: string, holdingId: string): Promise<void> {
  const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
  if (!role || (role.holdingId !== null && role.holdingId !== holdingId)) {
    throw new ValidationError('Неизвестная роль');
  }
}

/**
 * Anti-escalation, scope-aware: returns the codes the actor does NOT hold at (or
 * broader than) `scope`. `getUserPermissionCodes` is scope-blind ("holds anywhere")
 * and documented as UI-gating only — using it as a security gate lets a
 * factory/department-scoped admin grant power at a wider scope than they own.
 */
async function actorMissingCodes(db: Db, userId: string, codes: string[], scope: Scope): Promise<string[]> {
  const missing: string[] = [];
  for (const code of codes) {
    if (!(await hasPermission(db, userId, code, scope))) missing.push(code);
  }
  return missing;
}

/**
 * H1: financial-control ordering. Routing only moves FORWARD through stepOrder, so
 * an amount-gated approval step (thresholdAmount / conditionRule.amountGte) placed
 * BEFORE a procurement step never re-fires after the КП raises the amount — the
 * threshold approval is silently skipped. Reject such configurations up-front.
 * Runs inside the mutation's transaction: an invalid layout rolls back.
 */
async function assertThresholdsAfterProcurement(tx: Db, workflowId: string): Promise<void> {
  const steps: {
    stepName: string;
    stepKind: string;
    stepOrder: number;
    enabled: boolean;
    thresholdAmount: number | null;
    conditionRule: Record<string, unknown> | null;
  }[] = await tx.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, workflowId));
  const enabled = steps.filter((s) => s.enabled !== false);
  const procurementOrders = enabled.filter((s) => s.stepKind === 'procurement').map((s) => s.stepOrder);
  if (!procurementOrders.length) return;
  const lastProcurement = Math.max(...procurementOrders);
  const bad = enabled.find(
    (s) =>
      s.stepKind === 'approval' &&
      s.stepOrder < lastProcurement &&
      (s.thresholdAmount != null || (s.conditionRule as { amountGte?: unknown } | null)?.amountGte != null),
  );
  if (bad) {
    throw new ValidationError(
      `Шаг согласования с порогом суммы («${bad.stepName}») должен стоять ПОСЛЕ шага закупки — иначе рост суммы при выборе КП обойдёт финконтроль`,
    );
  }
}

/**
 * P1-1: an amount-gated approval step must be preceded by a procurement step that
 * verifies the amount (via a selected КП). Otherwise the threshold is evaluated
 * against the requester's self-declared amount (which the create form sends as 0),
 * so a high-value approval can be skipped entirely. Enforced at ACTIVATION so a
 * workflow can still be built step-by-step, but cannot go live while broken.
 */
async function assertThresholdsHaveProcurement(tx: Db, workflowId: string): Promise<void> {
  const steps: {
    stepName: string;
    stepKind: string;
    stepOrder: number;
    enabled: boolean;
    thresholdAmount: number | null;
    conditionRule: Record<string, unknown> | null;
  }[] = await tx.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, workflowId));
  const enabled = steps.filter((s) => s.enabled !== false);
  const procurementOrders = enabled.filter((s) => s.stepKind === 'procurement').map((s) => s.stepOrder);
  const amountGated = enabled.filter(
    (s) =>
      s.stepKind === 'approval' &&
      (s.thresholdAmount != null || (s.conditionRule as { amountGte?: unknown } | null)?.amountGte != null),
  );
  const orphan = amountGated.find((s) => !procurementOrders.some((o) => o < s.stepOrder));
  if (orphan) {
    throw new ValidationError(
      `Нельзя активировать: шаг согласования с порогом суммы («${orphan.stepName}») требует шага закупки ПЕРЕД ним — ` +
        `иначе порог проверяется по самодекларированной сумме и высокобюджетное согласование можно обойти`,
    );
  }
}

/**
 * NEW-2: invariants to run after ANY step mutation. The ordering rule always
 * applies. The stronger existence rule (a threshold approval must have procurement
 * before it) is enforced whenever the workflow is ALREADY ACTIVE — otherwise a
 * step add/reorder/delete on a live workflow could reintroduce the P1-1 bypass
 * (threshold-without-procurement) without going through activation.
 */
async function assertStepMutationInvariants(tx: Db, workflowId: string): Promise<void> {
  await assertThresholdsAfterProcurement(tx, workflowId);
  const [wf] = await tx.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId));
  if (wf?.isActive) {
    await assertThresholdsHaveProcurement(tx, workflowId);
  }
}

export function buildAdminRouter(db: Db, auth: RequestHandler): Router {
  const r = Router();
  r.use(auth); // every admin route requires an authenticated user

  const requirePerm =
    (code: string): RequestHandler =>
    async (req, res, next) => {
      try {
        const u = actor(req);
        if (!u.holdingId || !(await hasPermission(db, u.id, code, { holdingId: u.holdingId }))) {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }
        next();
      } catch (e) {
        next(e);
      }
    };

  /** Admin section is reachable if the user holds ANY of the manage permissions. */
  const requireAnyPerm =
    (codes: string[]): RequestHandler =>
    async (req, res, next) => {
      try {
        const u = actor(req);
        if (u.holdingId) {
          for (const c of codes) {
            if (await hasPermission(db, u.id, c, { holdingId: u.holdingId })) {
              next();
              return;
            }
          }
        }
        res.status(403).json({ error: 'Forbidden' });
      } catch (e) {
        next(e);
      }
    };

  const ANY_ADMIN = ['roles.manage', 'users.manage', 'workflows.manage', 'settings.manage'];

  async function rolePermissionCodes(roleId: string): Promise<string[]> {
    const rows = await db
      .select({ code: schema.permissions.code })
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
      .where(eq(schema.rolePermissions.roleId, roleId));
    return rows.map((x: { code: string }) => x.code);
  }

  /**
   * R6: anti-escalation must also cover REVOCATION. You may archive a user or strip
   * their roles only if you yourself hold (at holding scope) every permission their
   * active roles confer — otherwise a users.manage holder could "behead" the owner.
   */
  async function assertActorOutranks(actorId: string, actorHoldingId: string, targetUserId: string): Promise<void> {
    const assigns: { roleId: string }[] = await db
      .select({ roleId: schema.userRoles.roleId })
      .from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, targetUserId), eq(schema.userRoles.status, 'active')));
    const codes = new Set<string>();
    for (const a of assigns) for (const c of await rolePermissionCodes(a.roleId)) codes.add(c);
    const missing = await actorMissingCodes(db, actorId, [...codes], { holdingId: actorHoldingId });
    if (missing.length) {
      throw new ForbiddenError('Нельзя администрировать пользователя с более широкими правами, чем ваши');
    }
  }

  /** Count active user-role assignments scoped to each department. */
  async function departmentUserCounts(holdingId: string): Promise<Map<string, number>> {
    const rows: { departmentId: string | null }[] = await db
      .select({ departmentId: schema.userRoles.departmentId })
      .from(schema.userRoles)
      .where(and(eq(schema.userRoles.holdingId, holdingId), eq(schema.userRoles.status, 'active')));
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!row.departmentId) continue;
      counts.set(row.departmentId, (counts.get(row.departmentId) ?? 0) + 1);
    }
    return counts;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Block A — Company structure
  // ─────────────────────────────────────────────────────────────────────────

  /** Dashboard counts for /admin home. Visible to any admin-capable user. */
  r.get('/overview', requireAnyPerm(ANY_ADMIN), async (req, res, next) => {
    try {
      const u = actor(req);
      const hid = u.holdingId as string;
      const [factories, departments, warehouses, users, roles, requests] = await Promise.all([
        db.select().from(schema.factories).where(eq(schema.factories.holdingId, hid)),
        db.select().from(schema.departments).where(eq(schema.departments.holdingId, hid)),
        db.select().from(schema.warehouses).where(eq(schema.warehouses.holdingId, hid)),
        db.select().from(schema.users).where(eq(schema.users.holdingId, hid)),
        db.select().from(schema.roles),
        db.select({ status: schema.requests.status }).from(schema.requests).where(eq(schema.requests.holdingId, hid)),
      ]);
      const isActive = (x: { status: string }) => x.status === 'active';
      res.json({
        factories: factories.filter(isActive).length,
        departments: departments.filter(isActive).length,
        warehouses: warehouses.filter(isActive).length,
        users: users.filter((x: { status: string }) => x.status !== 'disabled' && x.status !== 'archived').length,
        roles: roles.filter((x: { holdingId: string | null }) => x.holdingId === null || x.holdingId === hid).length,
        activeRequests: requests.filter((x: { status: string }) => !INACTIVE_REQUEST_STATUSES.includes(x.status)).length,
      });
    } catch (e) {
      next(e);
    }
  });

  /** Tree: holding → factories → (departments[+userCount], warehouses). Soft-deleted hidden. */
  r.get('/structure', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const hid = u.holdingId as string;
      const [holding] = await db.select().from(schema.holdings).where(eq(schema.holdings.id, hid));
      const factories = (await db.select().from(schema.factories).where(eq(schema.factories.holdingId, hid))).filter(
        (f: { status: string }) => f.status === 'active',
      );
      const departments = (
        await db.select().from(schema.departments).where(eq(schema.departments.holdingId, hid))
      ).filter((d: { status: string }) => d.status === 'active');
      const warehouses = (
        await db.select().from(schema.warehouses).where(eq(schema.warehouses.holdingId, hid))
      ).filter((w: { status: string }) => w.status === 'active');
      const userCounts = await departmentUserCounts(hid);

      type Node = { id: string; name: string; status: string };
      const deptNode = (d: { id: string; name: string; status: string }) => ({
        ...d,
        userCount: userCounts.get(d.id) ?? 0,
      });
      const factoryNodes = factories.map((f: Node) => ({
        id: f.id,
        name: f.name,
        status: f.status,
        departments: departments.filter((d: { factoryId: string | null }) => d.factoryId === f.id).map(deptNode),
        warehouses: warehouses.filter((w: { factoryId: string | null }) => w.factoryId === f.id),
      }));
      res.json({
        holding: holding ? { id: holding.id, name: holding.name } : null,
        factories: factoryNodes,
        // Holding-level (no factory) items, e.g. the default warehouse.
        unassigned: {
          departments: departments.filter((d: { factoryId: string | null }) => d.factoryId == null).map(deptNode),
          warehouses: warehouses.filter((w: { factoryId: string | null }) => w.factoryId == null),
        },
      });
    } catch (e) {
      next(e);
    }
  });

  r.post('/factories', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      if (!name) throw new ValidationError('name обязателен');
      const [fac] = await db
        .insert(schema.factories)
        .values({ holdingId: u.holdingId, name, type: str(body.type) || null, address: str(body.address) || null })
        .returning();
      await writeAudit(db, {
        holdingId: u.holdingId as string,
        userId: u.id,
        action: 'factory.created',
        module: 'admin',
        entityType: 'factory',
        entityId: fac.id,
        newValue: { name },
      });
      res.status(201).json(fac);
    } catch (e) {
      next(e);
    }
  });

  r.put('/factories/:id', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      if (!name) throw new ValidationError('name обязателен');
      await loadHoldingRow(db, schema.factories, req.params.id as string, u.holdingId as string);
      const patch: Record<string, unknown> = { name };
      if (body.type !== undefined) patch.type = str(body.type) || null;
      if (body.address !== undefined) patch.address = str(body.address) || null;
      const [updated] = await db
        .update(schema.factories)
        .set(patch)
        .where(eq(schema.factories.id, req.params.id as string))
        .returning();
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  r.delete('/factories/:id', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const fac = await loadHoldingRow(db, schema.factories, id, u.holdingId as string);
      await db.transaction(async (tx: Db) => {
        await tx.update(schema.factories).set({ status: 'inactive' }).where(eq(schema.factories.id, id));
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'factory.deleted',
          module: 'admin',
          entityType: 'factory',
          entityId: id,
          oldValue: { name: fac.name },
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.post('/departments', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      const factoryId = str(body.factory_id) || null;
      if (!name) throw new ValidationError('name обязателен');
      if (factoryId) await loadHoldingRow(db, schema.factories, factoryId, u.holdingId as string);
      const [dept] = await db
        .insert(schema.departments)
        .values({ holdingId: u.holdingId, factoryId, name })
        .returning();
      res.status(201).json(dept);
    } catch (e) {
      next(e);
    }
  });

  r.put('/departments/:id', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      if (!name) throw new ValidationError('name обязателен');
      await loadHoldingRow(db, schema.departments, req.params.id as string, u.holdingId as string);
      const [updated] = await db
        .update(schema.departments)
        .set({ name })
        .where(eq(schema.departments.id, req.params.id as string))
        .returning();
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  // BUG 5 FIX: DELETE /departments/:id now revokes active userRoles scoped to the department
  r.delete('/departments/:id', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const dept = await loadHoldingRow(db, schema.departments, id, u.holdingId as string);
      await db.transaction(async (tx: Db) => {
        await tx.update(schema.departments).set({ status: 'inactive' }).where(eq(schema.departments.id, id));
        // Revoke all active userRole assignments scoped to this department
        await tx
          .update(schema.userRoles)
          .set({ status: 'revoked' })
          .where(
            and(
              eq(schema.userRoles.departmentId, id),
              eq(schema.userRoles.status, 'active'),
            ),
          );
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'department.deleted',
          module: 'admin',
          entityType: 'department',
          entityId: id,
          oldValue: { name: dept.name },
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // BUG 3 FIX: GET /departments/:id/users now filters userRoles by holdingId
  r.get('/departments/:id/users', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const hid = u.holdingId as string;
      await loadHoldingRow(db, schema.departments, id, hid);
      const assigns: { userId: string; roleId: string }[] = await db
        .select({ userId: schema.userRoles.userId, roleId: schema.userRoles.roleId })
        .from(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.departmentId, id),
            eq(schema.userRoles.holdingId, hid),
            eq(schema.userRoles.status, 'active'),
          ),
        );
      const userIds = [...new Set(assigns.map((a) => a.userId))];
      if (userIds.length === 0) {
        res.json([]);
        return;
      }
      const users = await db.select().from(schema.users).where(inArray(schema.users.id, userIds));
      const roles = await db.select().from(schema.roles);
      const roleCodeById = new Map<string, string>(roles.map((rr: { id: string; code: string }) => [rr.id, rr.code]));
      const out = users.map((usr: { id: string; fullName: string; telegramId: string | null; status: string }) => ({
        id: usr.id,
        fullName: usr.fullName,
        telegramId: usr.telegramId,
        status: usr.status,
        roles: assigns
          .filter((a) => a.userId === usr.id)
          .map((a) => roleCodeById.get(a.roleId))
          .filter(Boolean),
      }));
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.post('/warehouses', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      const factoryId = str(body.factory_id) || null;
      if (!name) throw new ValidationError('name обязателен');
      if (factoryId) await loadHoldingRow(db, schema.factories, factoryId, u.holdingId as string);
      const [wh] = await db
        .insert(schema.warehouses)
        .values({ holdingId: u.holdingId, factoryId, name })
        .returning();
      res.status(201).json(wh);
    } catch (e) {
      next(e);
    }
  });

  r.put('/warehouses/:id', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      if (!name) throw new ValidationError('name обязателен');
      await loadHoldingRow(db, schema.warehouses, req.params.id as string, u.holdingId as string);
      const [updated] = await db
        .update(schema.warehouses)
        .set({ name })
        .where(eq(schema.warehouses.id, req.params.id as string))
        .returning();
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  r.delete('/warehouses/:id', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const wh = await loadHoldingRow(db, schema.warehouses, id, u.holdingId as string);
      await db.transaction(async (tx: Db) => {
        await tx.update(schema.warehouses).set({ status: 'inactive' }).where(eq(schema.warehouses.id, id));
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'warehouse.deleted',
          module: 'admin',
          entityType: 'warehouse',
          entityId: id,
          oldValue: { name: wh.name },
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Block B — People
  // ─────────────────────────────────────────────────────────────────────────

  // BUG 1 FIX: GET /users now filters userRoles by holdingId to prevent cross-tenant leak
  // R10: reading the list is allowed to users.view holders (read-only: director);
  // users.manage still qualifies so a manage-only custom role keeps working.
  r.get('/users', requireAnyPerm(['users.view', 'users.manage']), async (req, res, next) => {
    try {
      const u = actor(req);
      const hid = u.holdingId as string;
      const allUsers = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.holdingId, hid));
      // Archived users (soft-deleted) are excluded from the active management list.
      const users = allUsers.filter((usr: { status: string }) => usr.status !== 'archived');
      const assigns = await db
        .select()
        .from(schema.userRoles)
        .where(eq(schema.userRoles.holdingId, hid));
      const roles = await db.select().from(schema.roles);
      const roleById = new Map<string, { code: string }>(roles.map((rr: { id: string; code: string }) => [rr.id, rr]));
      const out = users.map((usr: { id: string; fullName: string; telegramId: string | null; status: string }) => ({
        id: usr.id,
        fullName: usr.fullName,
        telegramId: usr.telegramId,
        status: usr.status,
        roles: assigns
          .filter((a: { userId: string; status: string }) => a.userId === usr.id && a.status === 'active')
          .map((a: { id: string; roleId: string; factoryId: string | null; departmentId: string | null }) => ({
            assignmentId: a.id,
            roleId: a.roleId,
            roleCode: roleById.get(a.roleId)?.code,
            factoryId: a.factoryId,
            departmentId: a.departmentId,
          })),
      }));
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  /** Invite a person by Telegram id. Attaches/reactivates existing or creates new. */
  r.post('/users/invite', requirePerm('users.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const telegramId = str(body.telegram_id);
      const name = str(body.name);
      if (!telegramId) throw new ValidationError('telegram_id обязателен');
      if (!name) throw new ValidationError('name обязателен');

      const [existing] = await db.select().from(schema.users).where(eq(schema.users.telegramId, telegramId));
      if (existing) {
        if (existing.holdingId && existing.holdingId !== u.holdingId) {
          throw new ConflictError('Пользователь уже принадлежит другой организации');
        }
        const updated = await db.transaction(async (tx: Db) => {
          const [row] = await tx
            .update(schema.users)
            // The admin-entered name wins: a person who self-registered keeps a Telegram
            // display name until an admin sets it here — so reactivation must update it too.
            .set({ holdingId: u.holdingId, status: 'active', fullName: name, updatedAt: new Date() })
            .where(eq(schema.users.id, existing.id))
            .returning();
          await writeAudit(tx, {
            holdingId: u.holdingId as string,
            userId: u.id,
            action: 'user.reactivated',
            module: 'admin',
            entityType: 'user',
            entityId: existing.id,
            oldValue: { holdingId: existing.holdingId, status: existing.status },
            newValue: { holdingId: u.holdingId, status: 'active' },
          });
          return row;
        });
        res.status(200).json(updated);
        return;
      }
      const created = await db.transaction(async (tx: Db) => {
        const [row] = await tx
          .insert(schema.users)
          .values({ telegramId, fullName: name, holdingId: u.holdingId, status: 'active' })
          .returning();
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'user.invited',
          module: 'admin',
          entityType: 'user',
          entityId: row.id,
          newValue: { telegramId, fullName: name },
        });
        return row;
      });
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  });

  /** "Delete" a user = ARCHIVE, never hard-delete (Factory OS is an accountability
   *  system, so people are never physically removed): keep the row for audit/history,
   *  set status='archived', revoke active role assignments, and write a user.archived
   *  audit event. Archived users are excluded from the active list and — since auth is
   *  fail-closed on status==='active' — cannot authenticate. */
  r.delete('/users/:id', requirePerm('users.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      if (id === u.id) throw new ValidationError('Нельзя удалить самого себя');
      const target = await loadHoldingRow(db, schema.users, id, u.holdingId as string);
      await assertActorOutranks(u.id, u.holdingId as string, id); // R6

      await db.transaction(async (tx: Db) => {
        await tx.update(schema.users).set({ status: 'archived', updatedAt: new Date() }).where(eq(schema.users.id, id));
        await tx
          .update(schema.userRoles)
          .set({ status: 'revoked' })
          .where(and(eq(schema.userRoles.userId, id), eq(schema.userRoles.status, 'active')));
      });

      await writeAudit(db, {
        holdingId: u.holdingId as string,
        userId: u.id,
        action: 'user.archived',
        module: 'admin',
        entityType: 'user',
        entityId: id,
        oldValue: { fullName: target.fullName, status: target.status },
        newValue: { status: 'archived' },
      });
      res.json({ ok: true, archived: true });
    } catch (e) {
      next(e);
    }
  });

  /** P2-2: admin PIN reset. Requires users.manage + a reason, outranks the target,
   *  CLEARS the PIN (forcing the user to set a fresh one), writes an audit event and
   *  a persisted notification to the affected user. Never sets a PIN on their behalf. */
  r.post('/users/:id/reset-pin', requirePerm('users.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const reason = String((req.body ?? {}).reason ?? '').trim();
      if (!reason) throw new ValidationError('Требуется причина сброса PIN');
      const target = await loadHoldingRow(db, schema.users, id, u.holdingId as string);
      await assertActorOutranks(u.id, u.holdingId as string, id);

      await db.transaction(async (tx: Db) => {
        await tx.update(schema.users).set({ pinHash: null, updatedAt: new Date() }).where(eq(schema.users.id, id));
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'pin.reset_by_admin',
          module: 'admin',
          entityType: 'user',
          entityId: id,
          // Never store the PIN — only the reason and who did it.
          newValue: { reason },
        });
      });

      // Persisted notification (delivery best-effort; admin router has no bot channel).
      await notifyUser(db, undefined, {
        holdingId: u.holdingId as string,
        recipientUserId: id,
        title: 'PIN сброшен администратором',
        message: `Ваш PIN был сброшен. Причина: ${reason}. Установите новый PIN в профиле.`,
        priority: 'high',
        entityType: 'user',
        entityId: id,
      });

      res.json({ ok: true, reset: true });
      void target;
    } catch (e) {
      next(e);
    }
  });

  r.get('/users/:id/roles', requirePerm('users.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      await loadHoldingRow(db, schema.users, id, u.holdingId as string);
      const assigns: {
        id: string;
        roleId: string;
        factoryId: string | null;
        departmentId: string | null;
        status: string;
      }[] = await db
        .select()
        .from(schema.userRoles)
        .where(and(eq(schema.userRoles.userId, id), eq(schema.userRoles.status, 'active')));
      const roles = await db.select().from(schema.roles);
      const roleById = new Map<string, { id: string; code: string; name: string }>(
        roles.map((rr: { id: string; code: string; name: string }) => [rr.id, rr]),
      );
      const out = await Promise.all(
        assigns.map(async (a) => ({
          assignmentId: a.id,
          roleId: a.roleId,
          roleCode: roleById.get(a.roleId)?.code,
          roleName: roleById.get(a.roleId)?.name,
          factoryId: a.factoryId,
          departmentId: a.departmentId,
          permissions: await rolePermissionCodes(a.roleId),
        })),
      );
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  // BUG 7 FIX: POST /users/:id/roles wraps insert + audit in a single transaction
  r.post('/users/:id/roles', requirePerm('users.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const targetId = req.params.id as string;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const roleId = str(body.roleId);
      const factoryId = str(body.factoryId) || null;
      const departmentId = str(body.departmentId) || null;
      if (!roleId) throw new ValidationError('roleId обязателен');

      // Target must belong to the actor's holding.
      await loadHoldingRow(db, schema.users, targetId, u.holdingId as string);
      // Role must be visible to this holding.
      await assertRoleVisible(db, roleId, u.holdingId as string);
      // Scope targets, if given, must belong to this holding.
      if (factoryId) await loadHoldingRow(db, schema.factories, factoryId, u.holdingId as string);
      if (departmentId) await loadHoldingRow(db, schema.departments, departmentId, u.holdingId as string);

      // Anti-escalation: the actor must hold every permission this role confers AT THE
      // SCOPE being granted. A holding/factory/department-scoped admin cannot mint a
      // broader grant than they themselves own.
      const grantScope: Scope = { holdingId: u.holdingId, factoryId, departmentId };
      const roleCodes = await rolePermissionCodes(roleId);
      const exceeding = await actorMissingCodes(db, u.id, roleCodes, grantScope);
      if (exceeding.length) {
        // FIX non-critical: use ForbiddenError instead of inline res.status(403).json()
        throw new ForbiddenError('Эта роль даёт права, которых нет у вас в этой области');
      }
      // Idempotent: an identical active assignment (same role + scope) is a no-op,
      // so re-inviting/re-assigning never creates duplicate pills.
      const dupe = await db
        .select()
        .from(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.userId, targetId),
            eq(schema.userRoles.roleId, roleId),
            eq(schema.userRoles.status, 'active'),
            factoryId ? eq(schema.userRoles.factoryId, factoryId) : isNull(schema.userRoles.factoryId),
            departmentId ? eq(schema.userRoles.departmentId, departmentId) : isNull(schema.userRoles.departmentId),
          ),
        );
      if (dupe.length) {
        res.status(200).json(dupe[0]);
        return;
      }
      const a = await db.transaction(async (tx: Db) => {
        const [row] = await tx
          .insert(schema.userRoles)
          .values({ userId: targetId, roleId, holdingId: u.holdingId, factoryId, departmentId, assignedBy: u.id })
          .returning();
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'role.assigned',
          module: 'admin',
          entityType: 'user',
          entityId: targetId,
          newValue: { roleId, factoryId, departmentId },
        });
        return row;
      });
      res.status(201).json(a);
    } catch (e) {
      next(e);
    }
  });

  /** Revoke (soft) every active assignment of a role for a user. */
  r.delete('/users/:id/roles/:roleId', requirePerm('users.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const roleId = req.params.roleId as string;
      await loadHoldingRow(db, schema.users, id, u.holdingId as string);
      await assertActorOutranks(u.id, u.holdingId as string, id); // R6
      const active: { id: string }[] = await db
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.userId, id),
            eq(schema.userRoles.roleId, roleId),
            eq(schema.userRoles.status, 'active'),
          ),
        );
      if (active.length === 0) throw new NotFoundError('Назначение не найдено');
      await db.transaction(async (tx: Db) => {
        await tx
          .update(schema.userRoles)
          .set({ status: 'revoked' })
          .where(
            and(
              eq(schema.userRoles.userId, id),
              eq(schema.userRoles.roleId, roleId),
              eq(schema.userRoles.status, 'active'),
            ),
          );
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'role.revoked',
          module: 'admin',
          entityType: 'user',
          entityId: id,
          oldValue: { roleId },
        });
      });
      res.json({ ok: true, revoked: active.length });
    } catch (e) {
      next(e);
    }
  });

  /** Revoke (soft) a single role assignment by its id — per-scope precision. */
  r.delete('/users/:id/assignments/:assignmentId', requirePerm('users.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const userId = req.params.id as string;
      const assignmentId = req.params.assignmentId as string;
      await loadHoldingRow(db, schema.users, userId, u.holdingId as string);
      await assertActorOutranks(u.id, u.holdingId as string, userId); // R6
      const [row] = await db.select().from(schema.userRoles).where(eq(schema.userRoles.id, assignmentId));
      if (!row || row.userId !== userId || row.holdingId !== u.holdingId || row.status !== 'active') {
        throw new NotFoundError('Назначение не найдено');
      }
      await db.transaction(async (tx: Db) => {
        await tx.update(schema.userRoles).set({ status: 'revoked' }).where(eq(schema.userRoles.id, assignmentId));
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'role.revoked',
          module: 'admin',
          entityType: 'user',
          entityId: userId,
          oldValue: { assignmentId, roleId: row.roleId },
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Block C — Roles & permissions
  // ─────────────────────────────────────────────────────────────────────────

  r.get('/permissions', requirePerm('roles.manage'), (_req, res) => {
    res.json(PERMISSIONS);
  });

  // BUG 2 FIX: GET /roles now queries only system roles (holdingId IS NULL) or this holding's roles
  r.get('/roles', requirePerm('roles.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const hid = u.holdingId as string;
      const roles = await db
        .select()
        .from(schema.roles)
        .where(or(isNull(schema.roles.holdingId), eq(schema.roles.holdingId, hid)));
      const rp = await db.select().from(schema.rolePermissions);
      const perms = await db.select().from(schema.permissions);
      const codeById = new Map<string, string>(perms.map((p: { id: string; code: string }) => [p.id, p.code]));
      const out = roles.map((role: { id: string; code: string; name: string; isSystem: boolean }) => ({
        id: role.id,
        code: role.code,
        name: role.name,
        isSystem: role.isSystem,
        permissions: rp
          .filter((m: { roleId: string }) => m.roleId === role.id)
          .map((m: { permissionId: string }) => codeById.get(m.permissionId))
          .filter(Boolean),
      }));
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.post('/roles', requirePerm('roles.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const code = str(body.code);
      const name = str(body.name);
      if (!code || !name) throw new ValidationError('code и name обязательны');
      const [role] = await db
        .insert(schema.roles)
        .values({ holdingId: u.holdingId, code, name, isSystem: false })
        .returning();
      res.status(201).json(role);
    } catch (e) {
      next(e);
    }
  });

  /** Rename a custom role. System roles are immutable. */
  r.put('/roles/:id', requirePerm('roles.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      if (!name) throw new ValidationError('name обязателен');
      const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, id));
      if (!role) throw new NotFoundError('Роль не найдена');
      if (role.isSystem || role.holdingId === null) throw new ForbiddenError('Системную роль нельзя изменить');
      if (role.holdingId !== u.holdingId) throw new NotFoundError('Роль не найдена');
      const [updated] = await db.update(schema.roles).set({ name }).where(eq(schema.roles.id, id)).returning();
      await writeAudit(db, { holdingId: u.holdingId!, userId: u.id, action: 'role.renamed', module: 'admin', entityType: 'role', entityId: id, oldValue: { name: role.name }, newValue: { name } });
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  // BUG 4 FIX: DELETE /roles/:id now checks workflowSteps.approverRoleId before deleting
  /** Delete a custom role. Blocked if it is a system role or still assigned. */
  r.delete('/roles/:id', requirePerm('roles.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, id));
      if (!role) throw new NotFoundError('Роль не найдена');
      if (role.isSystem || role.holdingId === null) throw new ForbiddenError('Системную роль нельзя удалить');
      if (role.holdingId !== u.holdingId) throw new NotFoundError('Роль не найдена');
      const inUse: { id: string }[] = await db
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(and(eq(schema.userRoles.roleId, id), eq(schema.userRoles.status, 'active')));
      if (inUse.length) throw new ConflictError('Роль назначена пользователям — снимите её перед удалением');
      // workflow_steps.approver_role_id has no ON DELETE — a referenced role would FK-fail.
      const stepRefs: { id: string }[] = await db
        .select({ id: schema.workflowSteps.id })
        .from(schema.workflowSteps)
        .where(eq(schema.workflowSteps.approverRoleId, id));
      if (stepRefs.length) {
        throw new ConflictError('Роль используется в шагах согласования — измените их перед удалением');
      }
      await db.transaction(async (tx: Db) => {
        // Active assignments are blocked above (409); only historical (revoked/expired)
        // rows can remain, and they'd violate the FK — drop them with the role.
        await tx.delete(schema.userRoles).where(eq(schema.userRoles.roleId, id));
        await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, id));
        await tx.delete(schema.roles).where(eq(schema.roles.id, id));
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'role.deleted',
          module: 'admin',
          entityType: 'role',
          entityId: id,
          oldValue: { code: role.code, name: role.name },
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.put('/roles/:id/permissions', requirePerm('roles.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const roleId = req.params.id as string;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const codes: string[] = Array.isArray(body.codes) ? (body.codes as unknown[]).map((c) => String(c)) : [];

      // A system role's permission set is fixed; only custom roles in this holding are editable.
      const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
      if (!role) throw new NotFoundError('Роль не найдена');
      if (role.isSystem || role.holdingId === null) throw new ForbiddenError('Права системной роли нельзя менять');
      if (role.holdingId !== u.holdingId) throw new NotFoundError('Роль не найдена');

      // Anti-escalation: a holding role's permissions can be assigned holding-wide, so
      // the actor must hold each requested code at holding scope — not merely "somewhere".
      const escalating = await actorMissingCodes(db, u.id, codes, { holdingId: u.holdingId });
      if (escalating.length) {
        // FIX non-critical: use ForbiddenError instead of inline res.status(403).json()
        throw new ForbiddenError('Нельзя выдать права, которых нет у вас: ' + escalating.join(', '));
      }

      const before = await rolePermissionCodes(roleId);
      const perms = await db.select().from(schema.permissions);
      const idByCode = new Map<string, string>(perms.map((p: { code: string; id: string }) => [p.code, p.id]));
      await db.transaction(async (tx: Db) => {
        await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
        const rows = codes
          .map((c) => ({ roleId, permissionId: idByCode.get(c) }))
          .filter((x): x is { roleId: string; permissionId: string } => Boolean(x.permissionId));
        if (rows.length) await tx.insert(schema.rolePermissions).values(rows);
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'role.permissions_updated',
          module: 'admin',
          entityType: 'role',
          entityId: roleId,
          oldValue: { codes: before },
          newValue: { codes },
        });
      });
      res.json({ ok: true, count: codes.length });
    } catch (e) {
      next(e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Block D — Workflow (approval chain)
  // ─────────────────────────────────────────────────────────────────────────

  r.get('/workflows', requirePerm('workflows.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const wfs = await db
        .select()
        .from(schema.workflows)
        .where(eq(schema.workflows.holdingId, u.holdingId as string));
      const steps = await db.select().from(schema.workflowSteps);
      const out = wfs.map((w: { id: string }) => ({
        ...w,
        steps: steps
          .filter((s: { workflowId: string }) => s.workflowId === w.id)
          .sort((a: { stepOrder: number }, b: { stepOrder: number }) => a.stepOrder - b.stepOrder),
      }));
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.post('/workflows', requirePerm('workflows.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      if (!name) throw new ValidationError('name обязателен');
      // New chains start inactive so they don't shadow the live one until activated.
      const [wf] = await db
        .insert(schema.workflows)
        .values({ holdingId: u.holdingId, name, isActive: false })
        .returning();
      res.status(201).json(wf);
    } catch (e) {
      next(e);
    }
  });

  // BUG 6 FIX: PUT /workflows/:id (activate) now guards against in-flight requests on the currently active workflow
  /** Rename and/or activate a workflow. Activating deactivates siblings in the same module. */
  r.put('/workflows/:id', requirePerm('workflows.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const wf = await loadHoldingRow(db, schema.workflows, id, u.holdingId as string);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) {
        const name = str(body.name);
        if (!name) throw new ValidationError('name не может быть пустым');
        patch.name = name;
      }
      const wantActive = body.is_active ?? body.isActive;
      const module = (wf as unknown as { module: string }).module;
      const [updated] = await db.transaction(async (tx: Db) => {
        if (wantActive === true) {
          const stepCount = await tx.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, id));
          if (stepCount.length === 0) throw new ValidationError('Cannot activate workflow with no steps');
          // P1-1: refuse to activate a workflow where a threshold approval has no
          // procurement step before it to verify the amount.
          await assertThresholdsHaveProcurement(tx, id);
          // Find the currently active workflow(s) for this module and check for in-flight requests
          const currentlyActive: { id: string }[] = await tx
            .select({ id: schema.workflows.id })
            .from(schema.workflows)
            .where(
              and(
                eq(schema.workflows.holdingId, u.holdingId as string),
                eq(schema.workflows.module, module),
                eq(schema.workflows.isActive, true),
              ),
            );
          for (const activeWf of currentlyActive) {
            if (activeWf.id !== id && (await workflowHasInFlight(tx, activeWf.id))) {
              throw new ConflictError('Cannot switch workflow while requests are in-flight');
            }
          }
          await tx
            .update(schema.workflows)
            .set({ isActive: false })
            .where(and(eq(schema.workflows.holdingId, u.holdingId as string), eq(schema.workflows.module, module)));
          patch.isActive = true;
        } else if (wantActive === false) {
          patch.isActive = false;
        }
        return tx.update(schema.workflows).set(patch).where(eq(schema.workflows.id, id)).returning();
      });
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  r.get('/workflows/:id/steps', requirePerm('workflows.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      await loadHoldingRow(db, schema.workflows, id, u.holdingId as string);
      const steps = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, id));
      steps.sort((a: { stepOrder: number }, b: { stepOrder: number }) => a.stepOrder - b.stepOrder);
      res.json(steps);
    } catch (e) {
      next(e);
    }
  });

  /**
   * Reorder steps. Body: [{ id, order_index }]. Blocked while requests are in flight.
   * Declared before the parameterized :stepId routes so "reorder" isn't read as an id.
   */
  r.put('/workflows/:id/steps/reorder', requirePerm('workflows.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      await loadHoldingRow(db, schema.workflows, id, u.holdingId as string);
      if (await workflowHasInFlight(db, id)) {
        throw new ConflictError('Нельзя менять порядок: есть незакрытые заявки на этой цепочке');
      }
      const raw = (req.body ?? {}) as unknown;
      const order = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { order?: unknown }).order)
          ? (raw as { order: unknown[] }).order
          : [];
      const items = (order as unknown[]).map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { id: str(o.id), orderIndex: Number(o.order_index) };
      });
      if (items.some((it) => !it.id || !Number.isFinite(it.orderIndex))) {
        throw new ValidationError('Каждый элемент должен иметь id и order_index');
      }
      const steps: { id: string }[] = await db
        .select({ id: schema.workflowSteps.id })
        .from(schema.workflowSteps)
        .where(eq(schema.workflowSteps.workflowId, id));
      const valid = new Set(steps.map((s) => s.id));
      if (items.some((it) => !valid.has(it.id))) throw new ValidationError('Шаг не принадлежит этой цепочке');
      await db.transaction(async (tx: Db) => {
        for (const it of items) {
          await tx
            .update(schema.workflowSteps)
            .set({ stepOrder: Math.round(it.orderIndex) })
            .where(eq(schema.workflowSteps.id, it.id));
        }
        await assertStepMutationInvariants(tx, id); // H1 + NEW-2
      });
      await writeAudit(db, {
        holdingId: u.holdingId!,
        userId: u.id,
        action: 'workflow.steps_reordered',
        module: 'admin',
        entityType: 'workflow',
        entityId: id,
        newValue: { order: items.map((it) => ({ id: it.id, orderIndex: it.orderIndex })) },
      });
      res.json({ ok: true, count: items.length });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Условие включения шага (engine.ConditionRule). Пустые значения выбрасываются;
   * неизвестные ключи — ошибка, чтобы опечатка не превратилась в «условие,
   * которое всегда истинно».
   */
  function parseConditionRule(raw: unknown): Record<string, unknown> | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('condition_rule должен быть объектом');
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || v === undefined || v === '') continue;
      if (k === 'amountGte' || k === 'amountLt') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${k} должен быть неотрицательным числом`);
        out[k] = Math.round(n);
      } else if (k === 'inStock') {
        if (typeof v !== 'boolean') throw new ValidationError('inStock должен быть true/false');
        out[k] = v;
      } else if (k === 'requestType') {
        out[k] = String(v).trim();
        if (!out[k]) delete out[k];
      } else {
        throw new ValidationError(`Неизвестное условие: ${k}`);
      }
    }
    if (out.amountGte != null && out.amountLt != null && (out.amountGte as number) >= (out.amountLt as number)) {
      throw new ValidationError('«Сумма от» должна быть меньше «суммы до»');
    }
    return Object.keys(out).length ? out : null;
  }

  /** Ветка «Если отклонил»: политика + целевой шаг (для return_step — обязателен и раньше текущего). */
  async function parseOnReject(
    body: Record<string, unknown>,
    workflowId: string,
    ownOrder: number,
  ): Promise<{ onReject: OnRejectPolicy; onRejectStepOrder: number | null }> {
    const policy = str(body.on_reject) || 'cancel';
    if (!ON_REJECT_POLICIES.includes(policy as OnRejectPolicy)) {
      throw new ValidationError('on_reject: допустимо cancel | return_requester | return_step');
    }
    if (policy !== 'return_step') return { onReject: policy as OnRejectPolicy, onRejectStepOrder: null };
    const target = Number(body.on_reject_step_order);
    if (!Number.isFinite(target)) throw new ValidationError('Для «вернуть на шаг» укажите on_reject_step_order');
    if (Math.round(target) >= ownOrder) {
      throw new ValidationError('Возврат возможен только на более ранний шаг (иначе петля)');
    }
    const rows = await db
      .select({ stepOrder: schema.workflowSteps.stepOrder })
      .from(schema.workflowSteps)
      .where(eq(schema.workflowSteps.workflowId, workflowId));
    if (!rows.some((s: { stepOrder: number }) => s.stepOrder === Math.round(target))) {
      throw new ValidationError('Шаг с таким порядковым номером не найден в цепочке');
    }
    return { onReject: 'return_step', onRejectStepOrder: Math.round(target) };
  }

  r.post('/workflows/:id/steps', requirePerm('workflows.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      await loadHoldingRow(db, schema.workflows, id, u.holdingId as string);
      if (await workflowHasInFlight(db, id)) {
        throw new ConflictError('Нельзя менять шаги: есть незакрытые заявки на этой цепочке');
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const stepName = str(body.name);
      const approverRoleId = str(body.approver_role_id) || null;
      if (!stepName) throw new ValidationError('name обязателен');
      if (approverRoleId) await assertRoleVisible(db, approverRoleId, u.holdingId as string);
      const stepKind = body.step_kind !== undefined ? str(body.step_kind) : 'approval';
      if (!STEP_KINDS.includes(stepKind as (typeof STEP_KINDS)[number])) {
        throw new ValidationError('Неизвестный тип шага (step_kind)');
      }
      const orderIndex = body.order_index !== undefined ? Number(body.order_index) : NaN;
      if (!Number.isFinite(orderIndex)) throw new ValidationError('order_index обязателен');
      const existing = await db.select().from(schema.workflowSteps)
        .where(and(eq(schema.workflowSteps.workflowId, id), eq(schema.workflowSteps.stepOrder, Math.round(orderIndex))));
      if (existing.length > 0) throw new ConflictError('Step with this order already exists in workflow');
      const thresholdAmount =
        body.threshold_amount === undefined || body.threshold_amount === null ? null : Number(body.threshold_amount);
      if (thresholdAmount !== null && (!Number.isFinite(thresholdAmount) || thresholdAmount < 0)) {
        throw new ValidationError('threshold_amount должен быть неотрицательным числом');
      }
      const conditionRule = parseConditionRule(body.condition_rule);
      const rejectBranch = await parseOnReject(body, id, Math.round(orderIndex));
      const step = await db.transaction(async (tx: Db) => {
        const [row] = await tx
          .insert(schema.workflowSteps)
          .values({
            workflowId: id,
            stepOrder: Math.round(orderIndex),
            stepName,
            stepKind,
            approverRoleId,
            conditionRule,
            thresholdAmount,
            onReject: rejectBranch.onReject,
            onRejectStepOrder: rejectBranch.onRejectStepOrder,
          })
          .returning();
        await assertStepMutationInvariants(tx, id); // H1 + NEW-2
        return row;
      });
      res.status(201).json(step);
    } catch (e) {
      next(e);
    }
  });

  r.put('/workflows/:id/steps/:stepId', requirePerm('workflows.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const stepId = req.params.stepId as string;
      await loadHoldingRow(db, schema.workflows, id, u.holdingId as string);
      const [step] = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.id, stepId));
      if (!step || step.workflowId !== id) throw new NotFoundError('Шаг не найден');
      if (await workflowHasInFlight(db, id)) {
        throw new ConflictError('Нельзя менять шаги: есть незакрытые заявки на этой цепочке');
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) {
        const stepName = str(body.name);
        if (!stepName) throw new ValidationError('name не может быть пустым');
        patch.stepName = stepName;
      }
      if (body.approver_role_id !== undefined) {
        const approverRoleId = str(body.approver_role_id) || null;
        if (approverRoleId) await assertRoleVisible(db, approverRoleId, u.holdingId as string);
        patch.approverRoleId = approverRoleId;
      }
      if (body.order_index !== undefined) {
        const n = Number(body.order_index);
        if (!Number.isFinite(n)) throw new ValidationError('order_index должен быть числом');
        patch.stepOrder = Math.round(n);
      }
      if (body.threshold_amount !== undefined) {
        const t = body.threshold_amount === null ? null : Number(body.threshold_amount);
        if (t !== null && (!Number.isFinite(t) || t < 0)) {
          throw new ValidationError('threshold_amount должен быть неотрицательным числом');
        }
        patch.thresholdAmount = t;
      }
      if (body.condition_rule !== undefined) {
        patch.conditionRule = parseConditionRule(body.condition_rule);
      }
      if (body.step_kind !== undefined) {
        const k = str(body.step_kind);
        if (!STEP_KINDS.includes(k as (typeof STEP_KINDS)[number])) {
          throw new ValidationError('Неизвестный тип шага (step_kind)');
        }
        patch.stepKind = k;
      }
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
      if (body.on_reject !== undefined || body.on_reject_step_order !== undefined) {
        const ownOrder = (patch.stepOrder as number | undefined) ?? step.stepOrder;
        const rejectBranch = await parseOnReject(
          { on_reject: body.on_reject ?? step.onReject, on_reject_step_order: body.on_reject_step_order ?? step.onRejectStepOrder },
          id,
          ownOrder,
        );
        patch.onReject = rejectBranch.onReject;
        patch.onRejectStepOrder = rejectBranch.onRejectStepOrder;
      }
      const updated = await db.transaction(async (tx: Db) => {
        const [row] = await tx
          .update(schema.workflowSteps)
          .set(patch)
          .where(eq(schema.workflowSteps.id, stepId))
          .returning();
        await assertStepMutationInvariants(tx, id); // H1 + NEW-2
        return row;
      });
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  r.delete('/workflows/:id/steps/:stepId', requirePerm('workflows.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const stepId = req.params.stepId as string;
      await loadHoldingRow(db, schema.workflows, id, u.holdingId as string);
      const [step] = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.id, stepId));
      if (!step || step.workflowId !== id) throw new NotFoundError('Шаг не найден');
      if (await workflowHasInFlight(db, id)) {
        throw new ConflictError('Нельзя удалять шаги: есть незакрытые заявки на этой цепочке');
      }
      // NEW-2: deleting a step (e.g. the procurement step) must not leave an active
      // workflow with a threshold approval that has no procurement before it.
      await db.transaction(async (tx: Db) => {
        await tx.delete(schema.workflowSteps).where(eq(schema.workflowSteps.id, stepId));
        await assertStepMutationInvariants(tx, id);
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Settings (per holding)
  // ─────────────────────────────────────────────────────────────────────────

  r.get('/settings', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const rows = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.holdingId, u.holdingId as string));
      const out: Record<string, string> = {};
      for (const s of rows as { key: string; value: string | null }[]) out[s.key] = s.value ?? '';
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.put('/settings', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const entries = Object.entries((req.body ?? {}) as Record<string, unknown>);
      await db.transaction(async (tx: Db) => {
        for (const [key, value] of entries) {
          const existing = await tx
            .select()
            .from(schema.settings)
            .where(and(eq(schema.settings.holdingId, u.holdingId as string), eq(schema.settings.key, key)));
          if (existing.length) {
            await tx
              .update(schema.settings)
              .set({ value: String(value), updatedAt: new Date() })
              .where(eq(schema.settings.id, existing[0].id));
          } else {
            await tx.insert(schema.settings).values({ holdingId: u.holdingId, key, value: String(value) });
          }
        }
      });
      res.json({ ok: true, count: entries.length });
    } catch (e) {
      next(e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // Block F — Audit log viewer
  // ─────────────────────────────────────────────────────────────────────────

  r.get('/audit', requirePerm('audit.view'), async (req, res, next) => {
    try {
      const u = actor(req);
      const hid = u.holdingId as string;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const rows = await db
        .select({
          id: schema.auditLogs.id,
          action: schema.auditLogs.action,
          module: schema.auditLogs.module,
          entityType: schema.auditLogs.entityType,
          entityId: schema.auditLogs.entityId,
          oldValue: schema.auditLogs.oldValue,
          newValue: schema.auditLogs.newValue,
          comment: schema.auditLogs.comment,
          source: schema.auditLogs.source,
          createdAt: schema.auditLogs.createdAt,
          userName: schema.users.fullName,
        })
        .from(schema.auditLogs)
        .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.userId))
        .where(eq(schema.auditLogs.holdingId, hid))
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(limit + 1)
        .offset(offset);
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      res.json({ items: rows, hasMore });
    } catch (e) {
      next(e);
    }
  });

  // Block E2 — Materials catalog (6.1.11)
  // ─────────────────────────────────────────────────────────────────────────

  r.get('/materials', requireAnyPerm(['warehouse.view', 'settings.manage']), async (req, res, next) => {
    try {
      const u = actor(req);
      const rows = await db
        .select()
        .from(schema.materials)
        .where(eq(schema.materials.holdingId, u.holdingId as string));
      res.json(rows.filter((m: { status: string }) => m.status !== 'archived'));
    } catch (e) {
      next(e);
    }
  });

  r.post('/materials', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      if (!name) throw new ValidationError('name обязателен');
      const [mat] = await db
        .insert(schema.materials)
        .values({
          holdingId: u.holdingId,
          name,
          sku: str(body.sku) || null,
          defaultUnit: str(body.defaultUnit) || null,
        })
        .returning();
      await writeAudit(db, {
        holdingId: u.holdingId as string,
        userId: u.id,
        action: 'material.created',
        module: 'admin',
        entityType: 'material',
        entityId: mat.id,
        newValue: { name },
      });
      res.status(201).json(mat);
    } catch (e) {
      next(e);
    }
  });

  r.put('/materials/:id', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const [mat] = await db.select().from(schema.materials).where(eq(schema.materials.id, id));
      if (!mat || mat.holdingId !== u.holdingId) throw new NotFoundError('Материал не найден');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) {
        const name = str(body.name);
        if (!name) throw new ValidationError('name не может быть пустым');
        patch.name = name;
      }
      if (body.sku !== undefined) patch.sku = str(body.sku) || null;
      if (body.defaultUnit !== undefined) patch.defaultUnit = str(body.defaultUnit) || null;
      if (Object.keys(patch).length === 0) {
        res.json(mat);
        return;
      }
      const [updated] = await db.update(schema.materials).set(patch).where(eq(schema.materials.id, id)).returning();
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  r.delete('/materials/:id', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const [mat] = await db.select().from(schema.materials).where(eq(schema.materials.id, id));
      if (!mat || mat.holdingId !== u.holdingId) throw new NotFoundError('Материал не найден');
      await db.update(schema.materials).set({ status: 'archived' }).where(eq(schema.materials.id, id));
      await writeAudit(db, {
        holdingId: u.holdingId as string,
        userId: u.id,
        action: 'material.deleted',
        module: 'admin',
        entityType: 'material',
        entityId: id,
        oldValue: { name: mat.name },
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ── Block E — Form builder (configurable create form) ──────────────────────
  // List every field on a screen (incl. disabled), ordered by step then position.
  r.get('/form-fields', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const screen = str(req.query.screen) || 'request_create';
      const rows = await db
        .select()
        .from(schema.formFields)
        .where(and(eq(schema.formFields.holdingId, u.holdingId as string), eq(schema.formFields.screen, screen)));
      rows.sort(
        (a: { stepGroup: number; orderIndex: number }, b: { stepGroup: number; orderIndex: number }) =>
          a.stepGroup - b.stepGroup || a.orderIndex - b.orderIndex,
      );
      res.json(rows.map(mapFormField));
    } catch (e) {
      next(e);
    }
  });

  // Add a custom field (always non-system; appended to the end of its step).
  r.post('/form-fields', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const screen = str(body.screen) || 'request_create';
      const label = str(body.label).slice(0, 200);
      const type = str(body.type);
      if (!label) throw new ValidationError('Название поля обязательно');
      if (!ALLOWED_FIELD_TYPES.includes(type)) throw new ValidationError('Недопустимый тип поля');
      const step = Number(body.step) >= 1 ? Math.floor(Number(body.step)) : 1;
      let options: { value: string; label: string; meta?: string }[] | null = null;
      if (type === 'select') {
        options = normalizeOptions(body.options);
        if (!options || options.length === 0) throw new ValidationError('У списка должен быть хотя бы один вариант');
      }
      const siblings = await db
        .select()
        .from(schema.formFields)
        .where(and(eq(schema.formFields.holdingId, u.holdingId as string), eq(schema.formFields.screen, screen)));
      const maxOrder = siblings
        .filter((s: { stepGroup: number }) => s.stepGroup === step)
        .reduce((m: number, s: { orderIndex: number }) => Math.max(m, s.orderIndex), 0);
      const [created] = await db
        .insert(schema.formFields)
        .values({
          holdingId: u.holdingId as string,
          screen,
          fieldKey: 'cf_' + randomUUID(),
          label,
          fieldType: type,
          system: false,
          required: !!body.required,
          enabled: true,
          placeholder: str(body.placeholder).slice(0, 500) || null,
          options,
          stepGroup: step,
          orderIndex: maxOrder + 1,
        })
        .returning();
      await writeAudit(db, {
        holdingId: u.holdingId as string,
        userId: u.id,
        action: 'form_field.created',
        module: 'admin',
        entityType: 'form_field',
        entityId: created.id,
        newValue: { label, type },
      });
      res.status(201).json(mapFormField(created));
    } catch (e) {
      next(e);
    }
  });

  // Reorder / re-step fields. MUST be declared before '/form-fields/:id'.
  r.put('/form-fields/reorder', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const body = req.body;
      const order: unknown[] = Array.isArray(body?.order) ? body.order : Array.isArray(body) ? body : [];
      await db.transaction(async (tx: Db) => {
        for (const raw of order) {
          const o = (raw ?? {}) as Record<string, unknown>;
          const id = str(o.id);
          if (!id) continue;
          const [f] = await tx.select().from(schema.formFields).where(eq(schema.formFields.id, id));
          if (!f || f.holdingId !== u.holdingId) continue; // never touch another holding's rows
          const patch: Record<string, unknown> = {};
          if (Number.isFinite(Number(o.orderIndex))) patch.orderIndex = Math.floor(Number(o.orderIndex));
          if (Number(o.step) >= 1) patch.stepGroup = Math.floor(Number(o.step));
          if (Object.keys(patch).length) await tx.update(schema.formFields).set(patch).where(eq(schema.formFields.id, id));
        }
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Update a field. System fields: label/required/order/enabled only (type, key and
  // option-values are load-bearing — they map to enums/columns). A required system
  // field cannot be disabled (it would break submit).
  r.put('/form-fields/:id', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const [field] = await db.select().from(schema.formFields).where(eq(schema.formFields.id, id));
      if (!field || field.holdingId !== u.holdingId) throw new NotFoundError('Поле не найдено');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (body.label !== undefined) {
        const l = str(body.label).slice(0, 200);
        if (!l) throw new ValidationError('Название не может быть пустым');
        patch.label = l;
      }
      if (body.required !== undefined) patch.required = !!body.required;
      // A required system field cannot be disabled — it would break request creation.
      if (body.enabled !== undefined) {
        if (!body.enabled && field.system && field.required) {
          throw new ValidationError('Required system fields cannot be disabled');
        }
        patch.enabled = !!body.enabled;
      }
      if (body.placeholder !== undefined) patch.placeholder = str(body.placeholder).slice(0, 500) || null;
      if (body.step !== undefined && Number(body.step) >= 1) patch.stepGroup = Math.floor(Number(body.step));
      if (body.orderIndex !== undefined && Number.isFinite(Number(body.orderIndex))) {
        patch.orderIndex = Math.floor(Number(body.orderIndex));
      }
      // Options are editable for any select field except 'warehouse' (its choices
      // come from the company structure, not from stored options).
      if (body.options !== undefined && field.fieldType === 'select' && field.fieldKey !== 'warehouse') {
        const opts = normalizeOptions(body.options);
        if (!opts || opts.length === 0) throw new ValidationError('У списка должен быть хотя бы один вариант');
        patch.options = opts;
      }
      if (Object.keys(patch).length === 0) {
        res.json(mapFormField(field));
        return;
      }
      const [updated] = await db
        .update(schema.formFields)
        .set(patch)
        .where(eq(schema.formFields.id, id))
        .returning();
      res.json(mapFormField(updated));
    } catch (e) {
      next(e);
    }
  });

  // Delete a custom field. System fields can only be disabled, never deleted.
  r.delete('/form-fields/:id', requirePerm('settings.manage'), async (req, res, next) => {
    try {
      const u = actor(req);
      const id = req.params.id as string;
      const [field] = await db.select().from(schema.formFields).where(eq(schema.formFields.id, id));
      if (!field || field.holdingId !== u.holdingId) throw new NotFoundError('Поле не найдено');
      // System fields are column-mapped and load-bearing — they can only be disabled, never deleted.
      if (field.system) throw new ValidationError('System fields cannot be deleted — only disabled');
      await db.transaction(async (tx: Db) => {
        await tx.delete(schema.formFields).where(eq(schema.formFields.id, id));
        await writeAudit(tx, {
          holdingId: u.holdingId as string,
          userId: u.id,
          action: 'form_field.deleted',
          module: 'admin',
          entityType: 'form_field',
          entityId: id,
          oldValue: { label: field.label },
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
