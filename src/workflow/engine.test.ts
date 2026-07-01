import { describe, it, expect } from 'vitest';
import {
  evaluateCondition,
  applicableSteps,
  firstStep,
  nextStep,
  type StepLike,
} from './engine.js';

// A tiered approval chain expressed entirely as data (the shape the legacy app
// hardcoded). dept_head + warehouse always; procurement only when not in stock;
// finance/director/owner gated by amount thresholds.
const STEPS: StepLike[] = [
  { id: 'dept_head', stepOrder: 1 },
  { id: 'warehouse', stepOrder: 2 },
  { id: 'procurement', stepOrder: 3, conditionRule: { inStock: false } },
  { id: 'finance', stepOrder: 4, thresholdAmount: 5_000_000 },
  { id: 'director', stepOrder: 5, thresholdAmount: 30_000_000 },
  { id: 'owner', stepOrder: 6, thresholdAmount: 100_000_000 },
];

const ids = (steps: StepLike[]) => steps.map((s) => s.id);

describe('evaluateCondition', () => {
  it('treats absent/empty rules as always-true', () => {
    expect(evaluateCondition(null, { amount: 0 })).toBe(true);
    expect(evaluateCondition({}, { amount: 0 })).toBe(true);
  });
  it('checks amount and inStock clauses', () => {
    expect(evaluateCondition({ amountGte: 5_000_000 }, { amount: 5_000_000 })).toBe(true);
    expect(evaluateCondition({ amountGte: 5_000_000 }, { amount: 4_999_999 })).toBe(false);
    expect(evaluateCondition({ inStock: false }, { amount: 0, inStock: true })).toBe(false);
    expect(evaluateCondition({ inStock: false }, { amount: 0, inStock: false })).toBe(true);
  });
});

describe('applicableSteps — amount tiering (the legacy bug class)', () => {
  it('small out-of-stock request: dept_head, warehouse, procurement only', () => {
    expect(ids(applicableSteps(STEPS, { amount: 2_000_000, inStock: false }))).toEqual([
      'dept_head',
      'warehouse',
      'procurement',
    ]);
  });

  it('medium request adds finance at >= 5M but not director at < 30M', () => {
    expect(ids(applicableSteps(STEPS, { amount: 10_000_000, inStock: false }))).toEqual([
      'dept_head',
      'warehouse',
      'procurement',
      'finance',
    ]);
  });

  it('large request adds director at >= 30M but not owner at < 100M', () => {
    expect(ids(applicableSteps(STEPS, { amount: 50_000_000, inStock: false }))).toEqual([
      'dept_head',
      'warehouse',
      'procurement',
      'finance',
      'director',
    ]);
  });

  it('very large request requires the whole chain incl. owner at >= 100M', () => {
    expect(ids(applicableSteps(STEPS, { amount: 150_000_000, inStock: false }))).toEqual([
      'dept_head',
      'warehouse',
      'procurement',
      'finance',
      'director',
      'owner',
    ]);
  });

  it('in-stock request skips procurement', () => {
    expect(ids(applicableSteps(STEPS, { amount: 2_000_000, inStock: true }))).toEqual([
      'dept_head',
      'warehouse',
    ]);
  });
});

describe('firstStep / nextStep', () => {
  it('firstStep is always dept_head', () => {
    expect(firstStep(STEPS, { amount: 2_000_000, inStock: false })?.id).toBe('dept_head');
  });

  it('nextStep walks the applicable chain and ends with null', () => {
    const ctx = { amount: 10_000_000, inStock: false };
    expect(nextStep(STEPS, ctx, 1)?.id).toBe('warehouse');
    expect(nextStep(STEPS, ctx, 2)?.id).toBe('procurement');
    expect(nextStep(STEPS, ctx, 3)?.id).toBe('finance'); // skips nothing; finance is applicable
    expect(nextStep(STEPS, ctx, 4)).toBeNull(); // director (30M) not applicable at 10M
  });

  it('after procurement a small request terminates (no finance/director/owner)', () => {
    expect(nextStep(STEPS, { amount: 2_000_000, inStock: false }, 3)).toBeNull();
  });
});
