/**
 * Request visibility model (bug #2).
 *
 * A user sees a request if ANY holds:
 *   1. they are a TOP role (owner / director / auditor — all carry `audit.view`) → see all;
 *   2. they are the requester (author);
 *   3. they have already acted on it (status-history change or a signature);
 *   4. one of their active roles is an (enabled) approver step in the request's workflow
 *      — i.e. the request will eventually reach their role.
 *
 * Otherwise the request is hidden. This replaces the old binary own-vs-whole-holding
 * rule where any oversight permission leaked every request.
 */
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { getUserPermissionCodes } from '../rbac/rbac.js';

type Db = any;

// Top roles see the whole holding. owner/director/auditor (and admin/ops-lead) hold audit.view.
export const TOP_VIEW_PERMS = ['audit.view'];

export interface RequestVisibility {
  seeAll: boolean;
  /** WHERE condition to AND into a requests query (undefined when seeAll). */
  scope: SQL | undefined;
  /** In-memory predicate for a single already-loaded request row. */
  canSee: (req: {
    requesterId: string;
    workflowId: string | null;
    id: string;
    responsibleUserId?: string | null;
    companyId?: string | null;
    factoryId?: string | null;
    departmentId?: string | null;
  }) => boolean;
}

/**
 * Права, дающие видимость сумм всегда (закупка / финансы / аудит). Гейт общий
 * для списка, инбокса и деталей — раньше каждый экран решал по-своему и роли
 * видели цену в одном месте, но не видели в другом.
 */
export const MONEY_PERMS = [
  'procurement.view',
  'procurement.quote',
  'procurement.select_supplier',
  'finance.view',
  'finance.mark_paid',
  'audit.view',
];

export interface MoneyVisibility {
  /** Денежные права — видит суммы по всем заявкам. */
  always: boolean;
  /** Workflow'ы, где роль пользователя согласует на шаге не раньше первой закупки. */
  workflowIds: Set<string>;
  /** Видит ли пользователь суммы этой заявки. */
  canSee: (req: { workflowId: string | null }) => boolean;
}

/**
 * Денежная видимость (bug #9, расширено 2026-07-07): суммы видят
 *  1) держатели MONEY_PERMS — всегда;
 *  2) согласующие маршрута, чей шаг стоит НЕ РАНЬШЕ первого шага закупки: они
 *     утверждают уже оценённую заявку и обязаны видеть, ЧТО утверждают. Это
 *     покрывает кастомные роли холдингов (например «Исп дир»), которым админ
 *     не выдал procurement.* — из-за чего часть цепочки цену не видела.
 * Роли ДО закупки (рук. отдела, склад) сумм по-прежнему не видят.
 */
export async function getMoneyVisibility(db: Db, userId: string): Promise<MoneyVisibility> {
  const codes = await getUserPermissionCodes(db, userId);
  const mk = (always: boolean, workflowIds: Set<string>): MoneyVisibility => ({
    always,
    workflowIds,
    canSee: (req) => always || (req.workflowId != null && workflowIds.has(req.workflowId)),
  });
  if (MONEY_PERMS.some((p) => codes.includes(p))) return mk(true, new Set());

  const roleRows = await db
    .select({ roleId: schema.userRoles.roleId })
    .from(schema.userRoles)
    .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.status, 'active')));
  const myRoleIds = [...new Set(roleRows.map((r: { roleId: string }) => r.roleId))] as string[];
  if (!myRoleIds.length) return mk(false, new Set());

  // Первый включённый шаг закупки каждого workflow.
  const procMins = await db
    .select({ wf: schema.workflowSteps.workflowId, minOrder: sql<number>`min(${schema.workflowSteps.stepOrder})` })
    .from(schema.workflowSteps)
    .where(and(eq(schema.workflowSteps.stepKind, 'procurement' as any), sql`COALESCE(${schema.workflowSteps.enabled}, true) = true`))
    .groupBy(schema.workflowSteps.workflowId);
  const minByWf = new Map<string, number>(procMins.map((r: { wf: string; minOrder: number }) => [r.wf, Number(r.minOrder)]));
  if (!minByWf.size) return mk(false, new Set());

  // Мои шаги согласования: «не раньше первой закупки» проверяем по order.
  // Считаются только РЕШАЮЩИЕ шаги (approval/procurement/finance) — роль,
  // прикреплённая к close-шагу (подтверждает автор) или складским шагам,
  // сумм из-за этого не получает.
  const mySteps = await db
    .select({ wf: schema.workflowSteps.workflowId, ord: schema.workflowSteps.stepOrder })
    .from(schema.workflowSteps)
    .where(
      and(
        inArray(schema.workflowSteps.approverRoleId, myRoleIds),
        inArray(schema.workflowSteps.stepKind, ['approval', 'procurement', 'finance_payment'] as any),
        sql`COALESCE(${schema.workflowSteps.enabled}, true) = true`,
      ),
    );
  const qualified = new Set<string>();
  for (const s of mySteps as { wf: string; ord: number }[]) {
    const min = minByWf.get(s.wf);
    if (min != null && s.ord >= min) qualified.add(s.wf);
  }
  return mk(false, qualified);
}

export async function getRequestVisibility(db: Db, userId: string): Promise<RequestVisibility> {
  const codes = await getUserPermissionCodes(db, userId);
  if (TOP_VIEW_PERMS.some((p) => codes.includes(p))) {
    return { seeAll: true, scope: undefined, canSee: () => true };
  }

  // Active role ASSIGNMENTS of the user — with their scopes: participation
  // visibility is granted per assignment, and a dept/factory-scoped assignment
  // must not leak other departments' requests (QA 2026-07-09, «выбор отдела»).
  const assigns: { roleId: string; companyId: string | null; factoryId: string | null; departmentId: string | null }[] = await db
    .select({
      roleId: schema.userRoles.roleId,
      companyId: schema.userRoles.companyId,
      factoryId: schema.userRoles.factoryId,
      departmentId: schema.userRoles.departmentId,
    })
    .from(schema.userRoles)
    .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.status, 'active')));
  const myRoleIds = [...new Set(assigns.map((r) => r.roleId))] as string[];

  // Role → workflows where it approves (enabled approval steps).
  const roleWf = new Map<string, Set<string>>();
  if (myRoleIds.length) {
    const rows: { roleId: string | null; wf: string | null }[] = await db
      .select({ roleId: schema.workflowSteps.approverRoleId, wf: schema.workflowSteps.workflowId })
      .from(schema.workflowSteps)
      .where(and(inArray(schema.workflowSteps.approverRoleId, myRoleIds), sql`COALESCE(${schema.workflowSteps.enabled}, true) = true`));
    for (const r of rows) {
      if (!r.roleId || !r.wf) continue;
      if (!roleWf.has(r.roleId)) roleWf.set(r.roleId, new Set());
      roleWf.get(r.roleId)!.add(r.wf);
    }
  }

  // Action-step kinds the user can act on BY PERMISSION (not only by role match) —
  // e.g. a procurement user works the procurement step even if their role code isn't
  // literally the step's approver role. Mirrors how the inbox surfaces work.
  // Resolved PER ROLE so the permission's visibility carries that role's scope.
  const PERM_STEP_KINDS: { perms: string[]; kinds: string[] }[] = [
    { perms: ['procurement.view', 'procurement.quote', 'procurement.select_supplier'], kinds: ['procurement'] },
    { perms: ['warehouse.view', 'warehouse.receive', 'warehouse.issue', 'warehouse.check_stock'], kinds: ['warehouse_check', 'receiving', 'issue'] },
    { perms: ['finance.view', 'finance.mark_paid'], kinds: ['finance_payment'] },
  ];
  const roleKinds = new Map<string, Set<string>>();
  const allKinds = new Set<string>();
  if (myRoleIds.length) {
    const rp: { roleId: string; code: string }[] = await db
      .select({ roleId: schema.rolePermissions.roleId, code: schema.permissions.code })
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.rolePermissions.permissionId, schema.permissions.id))
      .where(inArray(schema.rolePermissions.roleId, myRoleIds));
    const roleCodes = new Map<string, Set<string>>();
    for (const r of rp) {
      if (!roleCodes.has(r.roleId)) roleCodes.set(r.roleId, new Set());
      roleCodes.get(r.roleId)!.add(r.code);
    }
    for (const [roleId, cs] of roleCodes) {
      for (const g of PERM_STEP_KINDS) {
        if (g.perms.some((p) => cs.has(p))) {
          if (!roleKinds.has(roleId)) roleKinds.set(roleId, new Set());
          g.kinds.forEach((k) => { roleKinds.get(roleId)!.add(k); allKinds.add(k); });
        }
      }
    }
  }
  const kindWf = new Map<string, Set<string>>();
  if (allKinds.size) {
    const rows: { kind: string; wf: string | null }[] = await db
      .select({ kind: schema.workflowSteps.stepKind, wf: schema.workflowSteps.workflowId })
      .from(schema.workflowSteps)
      .where(and(inArray(schema.workflowSteps.stepKind, [...allKinds] as any), sql`COALESCE(${schema.workflowSteps.enabled}, true) = true`));
    for (const r of rows) {
      if (!r.wf) continue;
      if (!kindWf.has(r.kind)) kindWf.set(r.kind, new Set());
      kindWf.get(r.kind)!.add(r.wf);
    }
  }

  // Per assignment: the workflows it opens + the scope it is limited to.
  const perAssign: { wfSet: Set<string>; companyId: string | null; factoryId: string | null; departmentId: string | null }[] = [];
  for (const a of assigns) {
    const wfSet = new Set<string>(roleWf.get(a.roleId) ?? []);
    for (const k of roleKinds.get(a.roleId) ?? []) for (const wf of kindWf.get(k) ?? []) wfSet.add(wf);
    if (wfSet.size) perAssign.push({ wfSet, companyId: a.companyId, factoryId: a.factoryId, departmentId: a.departmentId });
  }

  // Requests I've acted on: I changed their status, or I signed an approval.
  const hist = await db
    .selectDistinct({ rid: schema.requestStatusHistory.requestId })
    .from(schema.requestStatusHistory)
    .where(eq(schema.requestStatusHistory.changedBy, userId));
  const sigs = await db
    .selectDistinct({ rid: schema.signatures.requestId })
    .from(schema.signatures)
    .where(eq(schema.signatures.userId, userId));
  const involvedIds = [
    ...new Set([...hist.map((r: { rid: string | null }) => r.rid), ...sigs.map((r: { rid: string | null }) => r.rid)].filter(Boolean)),
  ] as string[];

  const conds: SQL[] = [eq(schema.requests.requesterId, userId)];
  // Bug #8: the assigned procurement person always sees their request.
  conds.push(eq(schema.requests.responsibleUserId, userId));
  for (const p of perAssign) {
    const sub: SQL[] = [inArray(schema.requests.workflowId, [...p.wfSet])];
    if (p.companyId) sub.push(eq(schema.requests.companyId, p.companyId));
    if (p.factoryId) sub.push(eq(schema.requests.factoryId, p.factoryId));
    if (p.departmentId) sub.push(eq(schema.requests.departmentId, p.departmentId));
    conds.push(and(...sub)!);
  }
  if (involvedIds.length) conds.push(inArray(schema.requests.id, involvedIds));
  const scope = or(...conds)!;

  const involvedSet = new Set(involvedIds);
  const assignCovers = (p: { companyId: string | null; factoryId: string | null; departmentId: string | null }, req: { companyId?: string | null; factoryId?: string | null; departmentId?: string | null }): boolean =>
    (p.companyId == null || p.companyId === (req.companyId ?? null)) &&
    (p.factoryId == null || p.factoryId === (req.factoryId ?? null)) &&
    (p.departmentId == null || p.departmentId === (req.departmentId ?? null));
  return {
    seeAll: false,
    scope,
    canSee: (req) =>
      req.requesterId === userId ||
      req.responsibleUserId === userId ||
      perAssign.some((p) => req.workflowId != null && p.wfSet.has(req.workflowId) && assignCovers(p, req)) ||
      involvedSet.has(req.id),
  };
}
