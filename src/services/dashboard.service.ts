/**
 * Dashboard aggregates for the home screen. Counts are derived from the user's own
 * requests and from the approval steps their roles can act on — so the cards a user
 * sees follow their roles/permissions, not a hardcoded role string.
 *
 * Optimized: uses SQL-level filtering instead of loading all requests into memory.
 */
import { and, count, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { getUserPermissionCodes } from '../rbac/rbac.js';
import { getRequestVisibility } from '../http/request-visibility.js';
import { TERMINAL_STATUSES } from '../workflow/step-kinds.js';

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
  // Sprint 1 additive, role-scoped + permission-gated aggregates.
  // `null` = the caller lacks the permission → the card is hidden (never a fake 0).
  awaitingPayment: number | null; // finance.view — requests parked on the finance step
  inProcurement: number | null; // procurement.view — requests on the procurement step
  lowStock: number | null; // warehouse.view — stock balances at/under their min qty
  byStatus: Record<string, number> | null; // oversight (reports.view | audit.view)
}

// P2-1: closed/cancelled/archived are terminal too — a finished request must not
// keep counting as "active" on the dashboard.
const TERMINAL = [...TERMINAL_STATUSES];
const INACTIVE = [...TERMINAL_STATUSES, 'draft'];

const EMPTY_DASHBOARD: Dashboard = {
  myActive: 0,
  pendingForMe: 0,
  totalActive: 0,
  activity: [],
  awaitingPayment: null,
  inProcurement: null,
  lowStock: null,
  byStatus: null,
};

/** Count requests in a holding that currently sit on a given status. */
async function countByStatusValue(db: Db, holdingId: string, status: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.requests)
    .where(and(eq(schema.requests.holdingId, holdingId), eq(schema.requests.status, status)));
  return Number(row?.n ?? 0);
}

/** Count stock balances at or below their configured minimum (only where a min is set). */
async function countLowStock(db: Db, holdingId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.stockBalances)
    .where(
      and(
        eq(schema.stockBalances.holdingId, holdingId),
        isNotNull(schema.stockBalances.minQty),
        sql`${schema.stockBalances.availableQty} <= ${schema.stockBalances.minQty}`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** Full status breakdown for a holding (oversight only). */
async function requestsByStatus(db: Db, holdingId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: schema.requests.status, n: count() })
    .from(schema.requests)
    .where(eq(schema.requests.holdingId, holdingId))
    .groupBy(schema.requests.status);
  const out: Record<string, number> = {};
  for (const r of rows as { status: string; n: number }[]) out[r.status] = Number(r.n);
  return out;
}

export async function getDashboard(db: Db, userId: string, holdingId: string | null): Promise<Dashboard> {
  if (!holdingId) return { ...EMPTY_DASHBOARD };

  // Recent-activity visibility mirrors the requests list: oversight roles see the whole
  // holding; a pure requester/observer sees only their own requests. (H3 fix)
  const codes = await getUserPermissionCodes(db, userId);
  const has = (p: string) => codes.includes(p);
  // Activity feed follows the request-visibility model (bug #2): own + involved +
  // role-in-workflow; top roles see the whole holding.
  const vis = await getRequestVisibility(db, userId);
  const activityWhere = vis.scope
    ? and(eq(schema.requests.holdingId, holdingId), vis.scope)
    : eq(schema.requests.holdingId, holdingId);

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

  // Additive aggregates — computed ONLY when the caller holds the gating permission,
  // otherwise null (card hidden). Role-scoped: all counts are holding-wide, matching
  // the current visibility model (no dept scope this sprint).
  const [awaitingPayment, inProcurement, lowStock, byStatus] = await Promise.all([
    has('finance.view') ? countByStatusValue(db, holdingId, 'finance_payment') : Promise.resolve(null),
    has('procurement.view') ? countByStatusValue(db, holdingId, 'procurement') : Promise.resolve(null),
    has('warehouse.view') ? countLowStock(db, holdingId) : Promise.resolve(null),
    has('reports.view') || has('audit.view') ? requestsByStatus(db, holdingId) : Promise.resolve(null),
  ]);

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
    awaitingPayment,
    inProcurement,
    lowStock,
    byStatus,
  };
}
