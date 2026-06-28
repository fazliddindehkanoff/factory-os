/**
 * Dashboard aggregates for the home screen. Counts are derived from the user's own
 * requests and from the approval steps their roles can act on — so the cards a user
 * sees follow their roles/permissions, not a hardcoded role string.
 */
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema.js';

type Db = any;

export interface DashboardActivity {
  id: string;
  requestNumber: string;
  status: string;
  title: string | null;
  updatedAt: unknown;
}

export interface Dashboard {
  myActive: number;
  pendingForMe: number;
  totalActive: number;
  activity: DashboardActivity[];
}

export async function getDashboard(db: Db, userId: string, holdingId: string | null): Promise<Dashboard> {
  if (!holdingId) return { myActive: 0, pendingForMe: 0, totalActive: 0, activity: [] };

  const all = await db.select().from(schema.requests).where(eq(schema.requests.holdingId, holdingId));
  const holdingReqIds = new Set(all.map((r: { id: string }) => r.id));

  const myActive = all.filter(
    (r: { requesterId: string; status: string }) =>
      r.requesterId === userId && !['approved', 'rejected'].includes(r.status),
  ).length;
  const totalActive = all.filter(
    (r: { status: string }) => !['approved', 'rejected', 'draft'].includes(r.status),
  ).length;

  // Pending approvals at steps this user's roles can act on.
  const roleRows = await db
    .select({ roleId: schema.userRoles.roleId })
    .from(schema.userRoles)
    .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.status, 'active')));
  const roleIds = roleRows.map((r: { roleId: string }) => r.roleId);
  let pendingForMe = 0;
  if (roleIds.length) {
    const stepRows = await db
      .select({ id: schema.workflowSteps.id })
      .from(schema.workflowSteps)
      .where(inArray(schema.workflowSteps.approverRoleId, roleIds));
    const stepIds = stepRows.map((s: { id: string }) => s.id);
    if (stepIds.length) {
      const pend = await db
        .select()
        .from(schema.approvals)
        .where(and(inArray(schema.approvals.workflowStepId, stepIds), eq(schema.approvals.status, 'pending')));
      pendingForMe = pend.filter((p: { requestId: string }) => holdingReqIds.has(p.requestId)).length;
    }
  }

  const activity = [...all]
    .sort(
      (a: { updatedAt: unknown }, b: { updatedAt: unknown }) =>
        new Date(b.updatedAt as string).getTime() - new Date(a.updatedAt as string).getTime(),
    )
    .slice(0, 5)
    .map((r: { id: string; requestNumber: string; status: string; title: string | null; updatedAt: unknown }) => ({
      id: r.id,
      requestNumber: r.requestNumber,
      status: r.status,
      title: r.title,
      updatedAt: r.updatedAt,
    }));

  return { myActive, pendingForMe, totalActive, activity };
}
