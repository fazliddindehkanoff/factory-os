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
import { availableActions, inboxCandidates } from './lifecycle.service.js';
import { TERMINAL_STATUSES } from '../workflow/step-kinds.js';

type Db = any;

export interface DashboardActivity {
  id: string;
  requestNumber: string;
  status: string;
  title: string | null;
  updatedAt: unknown;
  // Лист Excel №5: лента событий показывает сведения о заявке (объект, отдел
  // снабжения, даты), а не наименование товара.
  obyekt: string | null;
  departmentName: string | null;
  neededDate: unknown;
  createdAt: unknown;
}

export interface Dashboard {
  myActive: number;
  // FIXES 2026-07-17: «Созданные мной» = ВСЕ заявки автора (любой статус), чтобы
  // цифра на плитке совпадала со списком «Только мои», который она открывает.
  myCreated: number;
  // Лист Excel №14: свои заявки, возвращённые автору на доработку (needs_revision).
  myReturned: number;
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
const INACTIVE = [...TERMINAL_STATUSES, 'draft'];

const EMPTY_DASHBOARD: Dashboard = {
  myActive: 0,
  myCreated: 0,
  myReturned: 0,
  pendingForMe: 0,
  totalActive: 0,
  activity: [],
  awaitingPayment: null,
  inProcurement: null,
  lowStock: null,
  byStatus: null,
};

/** Count requests in a holding that currently sit on a given status. */
async function countByStatusValue(db: Db, baseWhere: any, status: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.requests)
    .where(and(baseWhere, eq(schema.requests.status, status)));
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

/** Full status breakdown over the visible set (oversight only). */
async function requestsByStatus(db: Db, baseWhere: any): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: schema.requests.status, n: count() })
    .from(schema.requests)
    .where(baseWhere)
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
  // Every count reflects what the user can SEE (top roles → whole holding), so the
  // KPIs match the lists they open. `baseWhere` is that visible-scope filter.
  const baseWhere = vis.scope ? and(eq(schema.requests.holdingId, holdingId), vis.scope) : eq(schema.requests.holdingId, holdingId);
  const activityWhere = baseWhere;

  // Run count queries and activity in parallel — each touches only the rows it needs.
  const [myActiveRows, myCreatedRows, myReturnedRows, totalActiveRows, activity] = await Promise.all([
    // "Мои заявки" = my in-flight requests (own, excluding drafts and terminal).
    db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.holdingId, holdingId),
          eq(schema.requests.requesterId, userId),
          notInArray(schema.requests.status, INACTIVE),
        ),
      ),
    // FIXES 2026-07-17: «Созданные мной» — ВСЕ заявки автора (любой статус, кроме
    // черновика), чтобы совпадать со списком «Только мои», который открывает плитка.
    db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.holdingId, holdingId),
          eq(schema.requests.requesterId, userId),
          notInArray(schema.requests.status, ['draft']),
        ),
      ),
    // Лист Excel №14: свои заявки, возвращённые на доработку (needs_revision) —
    // ждут именно автора, поэтому отдельная плитка перед «Созданные мной».
    db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.holdingId, holdingId),
          eq(schema.requests.requesterId, userId),
          eq(schema.requests.status, 'needs_revision'),
        ),
      ),
    // "Активных всего" = visible in-flight requests (holding-wide for top roles).
    db.select({ id: schema.requests.id }).from(schema.requests).where(and(baseWhere, notInArray(schema.requests.status, INACTIVE))),
    db
      .select({
        id: schema.requests.id,
        requestNumber: schema.requests.requestNumber,
        status: schema.requests.status,
        title: schema.requests.title,
        updatedAt: schema.requests.updatedAt,
        createdAt: schema.requests.createdAt,
        neededDate: schema.requests.neededDate,
        departmentId: schema.requests.departmentId,
        departmentName: schema.requests.departmentName,
        customFields: schema.requests.customFields,
      })
      .from(schema.requests)
      .where(activityWhere)
      .orderBy(desc(schema.requests.updatedAt))
      .limit(5),
  ]);

  // Лист Excel №5: резолвим имена отделов для ленты событий (заявка адресуется
  // отделу по id — имя в строке не хранится).
  const actDeptIds = [...new Set(activity.map((r: any) => r.departmentId).filter(Boolean))] as string[];
  const actDeptName = new Map<string, string>();
  if (actDeptIds.length) {
    const deps = await db
      .select({ id: schema.departments.id, name: schema.departments.name })
      .from(schema.departments)
      .where(inArray(schema.departments.id, actDeptIds));
    for (const d of deps as { id: string; name: string }[]) actDeptName.set(d.id, d.name);
  }

  // "Ожидают меня" must match the inbox ("Ждут моего решения"): count in-flight
  // requests the user can currently ACT on — approval steps AND action steps
  // (warehouse/procurement/finance), via availableActions. The old approvals-only
  // count missed action steps, so the KPI showed 0 while the queue showed 1.
  // Тот же SQL-префильтр, что у инбокса (фикс LIMIT-100) — KPI и список совпадают.
  let pendingForMe = 0;
  const inflight = await inboxCandidates(db, userId, holdingId);
  for (const r of inflight) {
    const acts = await availableActions(db, r, userId);
    if (acts.length > 0) pendingForMe++;
  }

  // Additive aggregates — computed ONLY when the caller holds the gating permission
  // (null → card hidden) AND scoped to what the caller can see (top roles → holding),
  // so each number matches the list it opens.
  const [awaitingPayment, inProcurement, lowStock, byStatus] = await Promise.all([
    has('finance.view') ? countByStatusValue(db, baseWhere, 'finance_payment') : Promise.resolve(null),
    // FIXES 2026-07-17 (лист G): «Для закупа» = согласованные директором заявки,
    // дошедшие до этапа «Оформление заказа».
    has('procurement.view') ? countByStatusValue(db, baseWhere, 'ordering') : Promise.resolve(null),
    has('warehouse.view') ? countLowStock(db, holdingId) : Promise.resolve(null),
    // FIXES 2026-07-17 (лист F): «Заявки по статусам» видят ВСЕ пользователи;
    // baseWhere уже ограничивает выборку тем, что видит вызывающий.
    requestsByStatus(db, baseWhere),
  ]);

  return {
    myActive: myActiveRows.length,
    myCreated: myCreatedRows.length,
    myReturned: myReturnedRows.length,
    pendingForMe,
    totalActive: totalActiveRows.length,
    activity: activity.map((r: any) => ({
      id: r.id,
      requestNumber: r.requestNumber,
      status: r.status,
      title: r.title,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
      neededDate: r.neededDate,
      departmentName: r.departmentId ? actDeptName.get(r.departmentId) ?? r.departmentName ?? null : r.departmentName ?? null,
      obyekt: r.customFields && typeof r.customFields === 'object' && (r.customFields as Record<string, unknown>).obyekt != null
        ? String((r.customFields as Record<string, unknown>).obyekt)
        : null,
    })),
    awaitingPayment,
    inProcurement,
    lowStock,
    byStatus,
  };
}
