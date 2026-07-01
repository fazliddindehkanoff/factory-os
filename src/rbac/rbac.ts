/**
 * RBAC enforcement — default-deny, scope-aware.
 *
 * A user holds zero or more role assignments (user_roles), each carrying a scope
 * (holding/company/factory/department). A permission is granted for a target scope
 * only if the user has an active assignment to a role that has the permission AND
 * whose scope covers the target. No assignment ⇒ no access.
 */
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';

// db handle is intentionally loose so the same code works over node-postgres and pglite.
type Db = any;

export interface Scope {
  holdingId?: string | null;
  companyId?: string | null;
  factoryId?: string | null;
  departmentId?: string | null;
}

/**
 * An assignment's scope covers the target if, for every level the assignment
 * restricts (non-null), the target specifies the same value. A null level on the
 * assignment means "any" (broader). A level the assignment restricts but the target
 * leaves unspecified is NOT covered (fail closed).
 */
export function scopeCovers(assignment: Scope, target?: Scope): boolean {
  const t = target ?? {};
  const levels: (keyof Scope)[] = ['holdingId', 'companyId', 'factoryId', 'departmentId'];
  for (const lvl of levels) {
    const a = assignment[lvl];
    if (a != null && a !== t[lvl]) return false;
  }
  return true;
}

export async function hasPermission(
  db: Db,
  userId: string,
  code: string,
  target?: Scope,
): Promise<boolean> {
  const rows = await db
    .select({
      holdingId: schema.userRoles.holdingId,
      companyId: schema.userRoles.companyId,
      factoryId: schema.userRoles.factoryId,
      departmentId: schema.userRoles.departmentId,
    })
    .from(schema.userRoles)
    .innerJoin(schema.rolePermissions, eq(schema.rolePermissions.roleId, schema.userRoles.roleId))
    .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
    .where(
      and(
        eq(schema.userRoles.userId, userId),
        eq(schema.userRoles.status, 'active'),
        eq(schema.permissions.code, code),
      ),
    );
  return rows.some((r: Scope) => scopeCovers(r, target));
}

/**
 * Module-level gate: the user holds `code` via ANY active assignment that belongs
 * to this holding (or a global one). Narrower scope levels (factory/department)
 * are deliberately ignored — list/module endpoints have no concrete object to
 * scope against, and a factory-scoped role must still open its module instead of
 * being locked out with 403 (M7). Object-level checks (lifecycle actions) keep
 * using hasPermission with the full request scope.
 */
export async function hasPermissionInHolding(
  db: Db,
  userId: string,
  code: string,
  holdingId: string | null,
): Promise<boolean> {
  if (!holdingId) return false;
  const rows = await db
    .select({ holdingId: schema.userRoles.holdingId })
    .from(schema.userRoles)
    .innerJoin(schema.rolePermissions, eq(schema.rolePermissions.roleId, schema.userRoles.roleId))
    .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
    .where(
      and(
        eq(schema.userRoles.userId, userId),
        eq(schema.userRoles.status, 'active'),
        eq(schema.permissions.code, code),
      ),
    );
  return rows.some((r: { holdingId: string | null }) => r.holdingId == null || r.holdingId === holdingId);
}

/** All distinct permission codes the user holds anywhere (for UI gating). */
export async function getUserPermissionCodes(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ code: schema.permissions.code })
    .from(schema.userRoles)
    .innerJoin(schema.rolePermissions, eq(schema.rolePermissions.roleId, schema.userRoles.roleId))
    .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
    .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.status, 'active')));
  return rows.map((r: { code: string }) => r.code);
}
