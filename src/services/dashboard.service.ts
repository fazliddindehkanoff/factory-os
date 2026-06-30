/**
 * Dashboard aggregates for the home screen. Counts are derived from the user's own
 * requests and from the approval steps their roles can act on — so the cards a user
 * sees follow their roles/permissions, not a hardcoded role string.
 *
 * Optimized: uses SQL-level filtering instead of loading all requests into memory.
 */
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { getUserPermissionCodes } from '../rbac/rbac.js';

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

const TERMINAL = ['approved', 'rejected'];
const INACTIVE = ['approved', 'rejected', 'draft'];

export async function getDashboard(db: Db, userId: string, holdingId: string | null): Promise<Dashboard> {
  if (!holdingId) return { myActive: 0, pendingForMe: 0, totalActive: 0, activity: [] };

  // Recent-activity visibility mirrors the requests list: oversight roles see the whole
  // holding; a pure requester/observer sees only their own requests. (H3 fix)
  const codes = await getUserPermissionCodes(db, userId);
  const seeAll = ['requests.edit', 'approvals.view', 'warehouse.view', 'procurement.view', 'finance.view', 'audit.view'].some((p) => codes.includes(p));
  const activityWhere = seeAll
    ? eq(schema.requests.holdingId, holdingId)
    : and(eq(schema.requests.holdingId, holdingId), eq(schema.requests.requesterId, userId));

  // Run count queries and activity in parallel — each touches only the rows it needs.
  const [myActiveRows, totalActiveRows, activity] = await Promise.all([
    db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.holdingId, holdingId),
          eq(schema.requests.requesterId, userId),
          notInArray(schema.requests.status, TERMINAL),
        ),
      ),
    db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.holdingId, holdingId),
          notInArray(schema.requests.status, INACTIVE),
        ),
      ),
    db
      .select({
        id: schema.requests.id,
        requestNumber: schema.requests.requestNumber,
        status: schema.requests.status,
        title: schema.requests.title,
        updatedAt: schema.requests.updatedAt,
      })
      .from(schema.requests)
      .where(activityWhere)
      .orderBy(desc(schema.requests.updatedAt))
      .limit(5),
  ]);

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
      // Join approvals with requests to filter by holdingId at SQL level.
      const pend = await db
        .select({ id: schema.approvals.id })
        .from(schema.approvals)
        .innerJoin(schema.requests, eq(schema.requests.id, schema.approvals.requestId))
        .where(
          and(
            inArray(schema.approvals.workflowStepId, stepIds),
            eq(schema.approvals.status, 'pending'),
            eq(schema.requests.holdingId, holdingId),
          ),
        );
      pendingForMe = pend.length;
    }
  }

  return {
    myActive: myActiveRows.length,
    pendingForMe,
    totalActive: totalActiveRows.length,
    activity: activity.map((r: { id: string; requestNumber: string; status: string; title: string | null; updatedAt: unknown }) => ({
      id: r.id,
      requestNumber: r.requestNumber,
      status: r.status,
      title: r.title,
      updatedAt: r.updatedAt,
    })),
  };
}
