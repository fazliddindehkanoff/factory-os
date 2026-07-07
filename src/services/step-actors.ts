/**
 * Кто должен действовать на текущем шаге заявки — единая логика адресатов для
 * мгновенных уведомлений (routes.notifyStepApprovers), эскалаций и дайджестов:
 *  - close-шаг — подтверждает АВТОР (requesterOnly), а не держатели роли шага;
 *  - procurement с назначенным исполнителем — только исполнитель (Bug #8);
 *  - иначе — все активные держатели роли шага в холдинге.
 */
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';

type Db = any;

export interface StepActorsRequest {
  holdingId: string;
  requesterId: string;
  responsibleUserId?: string | null;
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
  const assigns = await db
    .select({ userId: schema.userRoles.userId })
    .from(schema.userRoles)
    .where(and(
      eq(schema.userRoles.roleId, step.approverRoleId),
      eq(schema.userRoles.status, 'active'),
      eq(schema.userRoles.holdingId, reqRow.holdingId),
    ));
  return [...new Set(assigns.map((a: { userId: string }) => a.userId))] as string[];
}

/** Значение настройки холдинга (settings.key) или null. */
export async function holdingSetting(db: Db, holdingId: string, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.holdingId, holdingId), eq(schema.settings.key, key)));
  return row ? (row.value as string | null) : null;
}
