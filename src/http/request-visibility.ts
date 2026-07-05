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
  canSee: (req: { requesterId: string; workflowId: string | null; id: string; responsibleUserId?: string | null }) => boolean;
}

export async function getRequestVisibility(db: Db, userId: string): Promise<RequestVisibility> {
  const codes = await getUserPermissionCodes(db, userId);
  if (TOP_VIEW_PERMS.some((p) => codes.includes(p))) {
    return { seeAll: true, scope: undefined, canSee: () => true };
  }

  // Active role ids of the user.
  const roleRows = await db
    .select({ roleId: schema.userRoles.roleId })
    .from(schema.userRoles)
    .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.status, 'active')));
  const myRoleIds = [...new Set(roleRows.map((r: { roleId: string }) => r.roleId))] as string[];

  // Action-step kinds the user can act on BY PERMISSION (not only by role match) —
  // e.g. a procurement user works the procurement step even if their role code isn't
  // literally the step's approver role. Mirrors how the inbox surfaces work.
  const PERM_STEP_KINDS: { perms: string[]; kinds: string[] }[] = [
    { perms: ['procurement.view', 'procurement.quote', 'procurement.select_supplier'], kinds: ['procurement'] },
    { perms: ['warehouse.view', 'warehouse.receive', 'warehouse.issue', 'warehouse.check_stock'], kinds: ['warehouse_check', 'receiving', 'issue'] },
    { perms: ['finance.view', 'finance.mark_paid'], kinds: ['finance_payment'] },
  ];
  const myKinds = new Set<string>();
  for (const g of PERM_STEP_KINDS) if (g.perms.some((p) => codes.includes(p))) g.kinds.forEach((k) => myKinds.add(k));
  const kindList = [...myKinds];

  // Workflows I participate in: an enabled step is either my role's approval step,
  // or an action step of a kind I can act on by permission.
  let roleWorkflowIds: string[] = [];
  const participationConds: SQL[] = [];
  if (myRoleIds.length) participationConds.push(inArray(schema.workflowSteps.approverRoleId, myRoleIds));
  if (kindList.length) participationConds.push(inArray(schema.workflowSteps.stepKind, kindList as any));
  if (participationConds.length) {
    const wf = await db
      .selectDistinct({ wf: schema.workflowSteps.workflowId })
      .from(schema.workflowSteps)
      .where(and(sql`COALESCE(${schema.workflowSteps.enabled}, true) = true`, or(...participationConds)!));
    roleWorkflowIds = wf.map((r: { wf: string | null }) => r.wf).filter(Boolean) as string[];
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
  if (roleWorkflowIds.length) conds.push(inArray(schema.requests.workflowId, roleWorkflowIds));
  if (involvedIds.length) conds.push(inArray(schema.requests.id, involvedIds));
  const scope = or(...conds)!;

  const roleWfSet = new Set(roleWorkflowIds);
  const involvedSet = new Set(involvedIds);
  return {
    seeAll: false,
    scope,
    canSee: (req) =>
      req.requesterId === userId ||
      req.responsibleUserId === userId ||
      (req.workflowId != null && roleWfSet.has(req.workflowId)) ||
      involvedSet.has(req.id),
  };
}
