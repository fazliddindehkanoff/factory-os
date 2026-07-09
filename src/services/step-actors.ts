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
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { scopeCovers } from '../rbac/rbac.js';

type Db = any;

export interface StepActorsRequest {
  holdingId: string;
  requesterId: string;
  responsibleUserId?: string | null;
  companyId?: string | null;
  factoryId?: string | null;
  departmentId?: string | null;
}

export interface StepActorsStep {
  stepKind: string;
  approverRoleId?: string | null;
}

export async function stepActorIds(db: Db, reqRow: StepActorsRequest, step: StepActorsStep): Promise<string[]> {
  if (step.stepKind === 'close') {
    return reqRow.requesterId ? [reqRow.requesterId] : [];
  }
  if (step.stepKind === 'procurement' && reqRow.responsibleUserId) {
    return [reqRow.responsibleUserId];
  }
  if (!step.approverRoleId) return [];
  const assigns: { userId: string; holdingId: string | null; companyId: string | null; factoryId: string | null; departmentId: string | null }[] = await db
    .select({
      userId: schema.userRoles.userId,
      holdingId: schema.userRoles.holdingId,
      companyId: schema.userRoles.companyId,
      factoryId: schema.userRoles.factoryId,
      departmentId: schema.userRoles.departmentId,
    })
    .from(schema.userRoles)
    .where(and(
      eq(schema.userRoles.roleId, step.approverRoleId),
      eq(schema.userRoles.status, 'active'),
      eq(schema.userRoles.holdingId, reqRow.holdingId),
    ));
  const target = {
    holdingId: reqRow.holdingId,
    companyId: reqRow.companyId ?? null,
    factoryId: reqRow.factoryId ?? null,
    departmentId: reqRow.departmentId ?? null,
  };
  const covered = assigns.filter((a) => scopeCovers(a, target));
  return [...new Set(covered.map((a) => a.userId))] as string[];
}

/** Значение настройки холдинга (settings.key) или null. */
export async function holdingSetting(db: Db, holdingId: string, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.holdingId, holdingId), eq(schema.settings.key, key)));
  return row ? (row.value as string | null) : null;
}
