/**
 * Кто должен действовать на текущем шаге заявки — единая логика адресатов для
 * мгновенных уведомлений (routes.notifyStepApprovers), эскалаций и дайджестов:
 *  - close-шаг — подтверждает АВТОР (requesterOnly), а не держатели роли шага;
 *  - procurement с назначенным исполнителем — только исполнитель (Bug #8);
 *  - иначе — активные держатели роли шага, чей СКОУП назначения покрывает
 *    заявку (отдел/завод) — тот же гейт, что у авторизации действий: иначе
 *    руководителей чужих отделов бомбит пушами о заявках, на которые у них
 *    нет ни действий, ни инбокса (QA 2026-07-09, «выбор отдела»).
 */
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { scopeCovers, type Scope } from '../rbac/rbac.js';

type Db = any;

export interface StepActorsRequest {
  holdingId: string;
  requesterId: string;
  responsibleUserId?: string | null;
  warehouseId?: string | null;
  companyId?: string | null;
  factoryId?: string | null;
  departmentId?: string | null;
}

export interface StepActorsStep {
  stepKind: string;
  approverRoleId?: string | null;
}

/**
 * Resolve active holders of a role for a concrete request scope. Department
 * heads are special: legacy data stores their role assignment at holding level
 * and their actual responsibility in user_departments, so a global role alone
 * must not make them responsible for every department.
 */
export async function roleActorIdsForScope(
  db: Db,
  roleId: string,
  target: Scope,
  onlyUserId?: string,
): Promise<string[]> {
  const conditions = [
    eq(schema.userRoles.roleId, roleId),
    eq(schema.userRoles.status, 'active'),
    eq(schema.userRoles.holdingId, target.holdingId as string),
  ];
  if (onlyUserId) conditions.push(eq(schema.userRoles.userId, onlyUserId));
  const assigns: {
    userId: string;
    holdingId: string | null;
    companyId: string | null;
    factoryId: string | null;
    departmentId: string | null;
    roleCode: string;
  }[] = await db
    .select({
      userId: schema.userRoles.userId,
      holdingId: schema.userRoles.holdingId,
      companyId: schema.userRoles.companyId,
      factoryId: schema.userRoles.factoryId,
      departmentId: schema.userRoles.departmentId,
      roleCode: schema.roles.code,
    })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(and(...conditions));
  if (!assigns.length) return [];

  const needsDepartmentMembership = assigns.some((assignment) =>
    assignment.roleCode === 'dept_head' && !!target.departmentId && assignment.departmentId == null,
  );
  const memberIds = new Set<string>();
  if (needsDepartmentMembership) {
    const memberships = await db
      .select({ userId: schema.userDepartments.userId })
      .from(schema.userDepartments)
      .where(and(
        inArray(schema.userDepartments.userId, [...new Set(assigns.map((assignment) => assignment.userId))]),
        eq(schema.userDepartments.departmentId, target.departmentId as string),
      ));
    memberships.forEach((membership: { userId: string }) => memberIds.add(membership.userId));
  }

  return [...new Set(assigns.filter((assignment) => {
    if (!scopeCovers(assignment, target)) return false;
    if (assignment.roleCode !== 'dept_head' || !target.departmentId) return true;
    return assignment.departmentId === target.departmentId ||
      (assignment.departmentId == null && memberIds.has(assignment.userId));
  }).map((assignment) => assignment.userId))];
}

export async function stepActorIds(db: Db, reqRow: StepActorsRequest, step: StepActorsStep): Promise<string[]> {
  if (step.stepKind === 'close') {
    return reqRow.requesterId ? [reqRow.requesterId] : [];
  }
  if (['procurement', 'ordering', 'delivery'].includes(step.stepKind) && reqRow.responsibleUserId) {
    return [reqRow.responsibleUserId];
  }
  if (['warehouse_check', 'receiving', 'issue'].includes(step.stepKind) && reqRow.warehouseId) {
    const [assigned] = await db.select({ userId: schema.warehouseResponsibles.userId })
      .from(schema.warehouseResponsibles)
      .innerJoin(schema.users, eq(schema.users.id, schema.warehouseResponsibles.userId))
      .where(and(
        eq(schema.warehouseResponsibles.warehouseId, reqRow.warehouseId),
        eq(schema.warehouseResponsibles.holdingId, reqRow.holdingId),
        eq(schema.users.status, 'active'),
      )).limit(1);
    if (assigned) return [assigned.userId];
  }
  if (!step.approverRoleId) return [];
  const target = {
    holdingId: reqRow.holdingId,
    companyId: reqRow.companyId ?? null,
    factoryId: reqRow.factoryId ?? null,
    departmentId: reqRow.departmentId ?? null,
  };
  return roleActorIdsForScope(db, step.approverRoleId, target);
}

/** Значение настройки холдинга (settings.key) или null. */
export async function holdingSetting(db: Db, holdingId: string, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.holdingId, holdingId), eq(schema.settings.key, key)));
  return row ? (row.value as string | null) : null;
}
