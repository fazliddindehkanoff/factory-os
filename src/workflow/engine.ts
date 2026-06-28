/**
 * Workflow routing engine (pure, data-driven).
 *
 * Routing is computed from the workflow's steps and their conditions — NOT
 * hardcoded. This is the deliberate fix for the legacy engine, where the approval
 * chain was a hardcoded switch and the configurable table was ignored (and a whole
 * amount threshold was dead). Here every routing decision comes from the data.
 *
 * These functions are pure (no DB) so the routing rules can be tested exhaustively.
 */
export interface ConditionRule {
  amountGte?: number;
  amountLt?: number;
  inStock?: boolean;
  requestType?: string;
}

export interface StepLike {
  id: string;
  stepOrder: number;
  conditionRule?: ConditionRule | null;
  thresholdAmount?: number | null;
  isRequired?: boolean;
  enabled?: boolean;
}

export interface WorkflowContext {
  amount: number;
  inStock?: boolean;
  requestType?: string;
}

/** True if the rule's every specified clause holds for the context. Empty/absent rule = always true. */
export function evaluateCondition(
  rule: ConditionRule | null | undefined,
  ctx: WorkflowContext,
): boolean {
  if (!rule) return true;
  if (rule.amountGte != null && !(ctx.amount >= rule.amountGte)) return false;
  if (rule.amountLt != null && !(ctx.amount < rule.amountLt)) return false;
  if (rule.inStock != null && rule.inStock !== Boolean(ctx.inStock)) return false;
  if (rule.requestType != null && rule.requestType !== ctx.requestType) return false;
  return true;
}

/** Steps that apply to this context (threshold + condition satisfied), in step order. */
export function applicableSteps<T extends StepLike>(steps: T[], ctx: WorkflowContext): T[] {
  return steps
    .filter((s) => {
      if (s.enabled === false) return false; // stage switched off in the admin constructor
      if (s.thresholdAmount != null && !(ctx.amount >= s.thresholdAmount)) return false;
      return evaluateCondition(s.conditionRule ?? null, ctx);
    })
    .sort((a, b) => a.stepOrder - b.stepOrder);
}

export function firstStep<T extends StepLike>(steps: T[], ctx: WorkflowContext): T | null {
  const applicable = applicableSteps(steps, ctx);
  return applicable.length > 0 ? applicable[0] : null;
}

/** The next applicable step strictly after currentStepOrder, or null if the chain ends. */
export function nextStep<T extends StepLike>(
  steps: T[],
  ctx: WorkflowContext,
  currentStepOrder: number,
): T | null {
  for (const s of applicableSteps(steps, ctx)) {
    if (s.stepOrder > currentStepOrder) return s;
  }
  return null;
}
