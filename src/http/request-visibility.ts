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
  canSee: (req: { requesterId: string; workflowId: string | null; id: string }) => boolean;
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

  // Workflows in which one of my roles is an enabled approver step.
  let roleWorkflowIds: string[] = [];
  if (myRoleIds.length) {
    const wf = await db
      .selectDistinct({ wf: schema.workflowSteps.workflowId })
      .from(schema.workflowSteps)
      .where(
        and(
          sql`COALESCE(${schema.workflowSteps.enabled}, true) = true`,
          inArray(schema.workflowSteps.approverRoleId, myRoleIds),
        ),
      );
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
  if (roleWorkflowIds.length) conds.push(inArray(schema.requests.workflowId, roleWorkflowIds));
  if (involvedIds.length) conds.push(inArray(schema.requests.id, involvedIds));
  const scope = conds.length === 1 ? conds[0] : or(...conds)!;

  const roleWfSet = new Set(roleWorkflowIds);
  const involvedSet = new Set(involvedIds);
  return {
    seeAll: false,
    scope,
    canSee: (req) =>
      req.requesterId === userId ||
      (req.workflowId != null && roleWfSet.has(req.workflowId)) ||
      involvedSet.has(req.id),
  };
}
