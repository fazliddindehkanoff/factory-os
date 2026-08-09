/**
 * Approval service — approve/reject an approval and advance the request through the
 * data-driven workflow. Fixes the legacy bugs by construction:
 *  - separation of duties: a requester cannot approve their own request (default ON);
 *  - authority: the actor must hold the step's approver role within the request scope;
 *  - idempotency: a non-pending approval cannot be re-processed;
 *  - the next stage and terminal state come from the workflow engine, not a hardcoded chain;
 *  - the "one pending approval per request" invariant is enforced by the DB index.
 * Everything runs in a single transaction with status history + audit.
 */
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { nextStep } from '../workflow/engine.js';
import { statusForStep, type KindStep } from '../workflow/step-kinds.js';
import type { Scope } from '../rbac/rbac.js';
import { roleActorIdsForScope } from './step-actors.js';
import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from './errors.js';

type Db = any;

export interface ApproveInput {
  approvalId: string;
  actorUserId: string;
  comment?: string;
  /** Policy escape hatch; default false (self-approval forbidden). */
  allowSelfApproval?: boolean;
}

export interface RejectInput {
  approvalId: string;
  actorUserId: string;
  comment: string;
  allowSelfApproval?: boolean;
}

async function actorHoldsRoleInScope(
  tx: Db,
  userId: string,
  roleId: string,
  scope: Scope,
): Promise<boolean> {
  return (await roleActorIdsForScope(tx, roleId, scope, userId)).includes(userId);
}

async function loadApprovalContext(tx: Db, approvalId: string, actorUserId: string, allowSelf: boolean) {
  const [probe] = await tx
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.id, approvalId));
  if (!probe) throw new NotFoundError('Approval not found');

  // Row-level lock on the request (same order as performAction), THEN re-read the
  // approval: a concurrent approve of the same approval serializes here and the
  // loser sees status != 'pending' → clean 409 instead of a 23505/500. (M6)
  await tx.execute(sql`SELECT 1 FROM requests WHERE id = ${probe.requestId} FOR UPDATE`);
  const [approval] = await tx
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.id, approvalId));
  if (!approval || approval.status !== 'pending') throw new ConflictError('Заявка уже обработана');

  const [req] = await tx.select().from(schema.requests).where(eq(schema.requests.id, approval.requestId));
  if (!req) throw new NotFoundError('Request not found');

  if (!allowSelf && req.requesterId === actorUserId) {
    throw new ForbiddenError('Нельзя согласовывать собственную заявку');
  }

  const scope: Scope = {
    holdingId: req.holdingId,
    companyId: req.companyId,
    factoryId: req.factoryId,
    departmentId: req.departmentId,
  };

  // Fail-closed: the request must still be in flight AND this approval must be its
  // CURRENT step. A terminal request (currentStepId = null) must never be re-opened
  // by a stale/orphan pending approval (B2); a mismatched step is stale/forged (C1).
  if (!req.currentStepId) {
    throw new ConflictError('Заявка уже завершена');
  }
  if (approval.workflowStepId && req.currentStepId !== approval.workflowStepId) {
    throw new ConflictError('Этот этап уже не активен');
  }

  let step: { id: string; stepOrder: number; approverRoleId: string | null } | null = null;
  if (approval.workflowStepId) {
    [step] = await tx
      .select()
      .from(schema.workflowSteps)
      .where(eq(schema.workflowSteps.id, approval.workflowStepId));
  }
  // Authority is MANDATORY. A step with no approver role is a misconfiguration, not an
  // open door — fail closed (409) instead of letting any user approve (C1 fix).
  if (!step || !step.approverRoleId) {
    throw new ConflictError('Шаг согласования настроен неверно: не задана роль согласующего');
  }
  const ok = await actorHoldsRoleInScope(tx, actorUserId, step.approverRoleId, scope);
  if (!ok) throw new ForbiddenError('Недостаточно прав для обработки этого этапа');

  return { approval, req, step };
}

export async function approveApproval(db: Db, input: ApproveInput) {
  return db.transaction(async (tx: Db) => {
    const { approval, req, step } = await loadApprovalContext(
      tx,
      input.approvalId,
      input.actorUserId,
      input.allowSelfApproval ?? false,
    );

    await tx
      .update(schema.approvals)
      .set({
        status: 'approved',
        approverUserId: input.actorUserId,
        comment: input.comment ?? null,
        approvedAt: new Date(),
      })
      .where(eq(schema.approvals.id, approval.id));

    await tx.insert(schema.signatures).values({
      approvalId: approval.id,
      requestId: req.id,
      userId: input.actorUserId,
      signatureType: 'telegram_pin',
    });

    let next: KindStep | null = null;
    if (req.workflowId && step) {
      const steps = await tx
        .select()
        .from(schema.workflowSteps)
        .where(eq(schema.workflowSteps.workflowId, req.workflowId));
      const kindSteps: KindStep[] = steps.map((s: any) => ({
        id: s.id,
        stepOrder: s.stepOrder,
        stepKind: s.stepKind,
        conditionRule: s.conditionRule,
        thresholdAmount: s.thresholdAmount,
        enabled: s.enabled,
      }));
      next = nextStep(
        kindSteps,
        { amount: req.estimatedAmount, inStock: req.inStock ?? undefined, requestType: req.requestType },
        step.stepOrder,
      ) as KindStep | null;
    }

    let newStatus: string;
    if (next) {
      // Advance exactly like performAction: the status comes from the next step's
      // KIND, and a pending approval row exists only for approval steps. (C1)
      newStatus = statusForStep({ stepKind: next.stepKind });
      await tx
        .update(schema.requests)
        .set({ currentStepId: next.id, status: newStatus, updatedAt: new Date() })
        .where(eq(schema.requests.id, req.id));
      if (next.stepKind === 'approval') {
        // Safe: the prior approval is now 'approved', so the partial unique index allows this.
        await tx.insert(schema.approvals).values({ requestId: req.id, workflowStepId: next.id });
      }
    } else {
      newStatus = 'approved';
      await tx
        .update(schema.requests)
        .set({ currentStepId: null, status: newStatus, updatedAt: new Date(), closedAt: new Date() })
        .where(eq(schema.requests.id, req.id));
    }

    await tx.insert(schema.requestStatusHistory).values({
      requestId: req.id,
      oldStatus: req.status,
      newStatus,
      changedBy: input.actorUserId,
      source: 'api',
    });
    await tx.insert(schema.auditLogs).values({
      holdingId: req.holdingId,
      factoryId: req.factoryId,
      userId: input.actorUserId,
      action: 'approval.approved',
      module: 'approvals',
      entityType: 'approval',
      entityId: approval.id,
      oldValue: { status: 'pending' },
      newValue: { status: 'approved', next: next?.id ?? null },
      source: 'api',
    });

    return { requestId: req.id, status: newStatus, nextStepId: next?.id ?? null };
  });
}

export async function rejectApproval(db: Db, input: RejectInput) {
  if (!input.comment?.trim()) throw new ValidationError('Укажите причину отклонения');
  return db.transaction(async (tx: Db) => {
    const { approval, req } = await loadApprovalContext(
      tx,
      input.approvalId,
      input.actorUserId,
      input.allowSelfApproval ?? false,
    );
    const reason = input.comment.trim();

    await tx
      .update(schema.approvals)
      .set({
        status: 'rejected',
        approverUserId: input.actorUserId,
        comment: reason,
        approvedAt: new Date(),
      })
      .where(eq(schema.approvals.id, approval.id));
    await tx
      .update(schema.requests)
      .set({ status: 'rejected', currentStepId: null, updatedAt: new Date(), closedAt: new Date() })
      .where(eq(schema.requests.id, req.id));

    await tx.insert(schema.requestStatusHistory).values({
      requestId: req.id,
      oldStatus: req.status,
      newStatus: 'rejected',
      changedBy: input.actorUserId,
      comment: reason,
      source: 'api',
    });
    await tx.insert(schema.auditLogs).values({
      holdingId: req.holdingId,
      factoryId: req.factoryId,
      userId: input.actorUserId,
      action: 'approval.rejected',
      module: 'approvals',
      entityType: 'approval',
      entityId: approval.id,
      oldValue: { status: 'pending' },
      newValue: { status: 'rejected' },
      comment: reason,
      source: 'api',
    });

    return { requestId: req.id, status: 'rejected' };
  });
}
