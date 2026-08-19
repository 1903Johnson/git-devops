import { describe, expect, it } from 'vitest';
import { PLAN_ORDER, isEntitled, planRank } from '../../src/index.js';
import type { PlanTier } from '../../src/index.js';

describe('plan ranking', () => {
  it('orders the tiers ascending', () => {
    expect(PLAN_ORDER).toEqual(['FREE', 'BASIC', 'PRO', 'ENTERPRISE']);
    expect(planRank('FREE')).toBeLessThan(planRank('ENTERPRISE'));
  });

  it('ranks an unknown plan below everything', () => {
    // A typo in a plan name must lose access, never grant it. Ranking an unknown value
    // high — or treating it as "not FREE, so probably paid" — is how a bad migration turns
    // into every church getting every module.
    expect(planRank('PLATINUM' as PlanTier)).toBe(-1);
    expect(isEntitled('PLATINUM' as PlanTier, 'FREE')).toBe(false);
  });
});

describe('entitlement', () => {
  it('grants a module to its own tier and everything above', () => {
    expect(isEntitled('PRO', 'PRO')).toBe(true);
    expect(isEntitled('ENTERPRISE', 'PRO')).toBe(true);
  });

  it('withholds it from everything below', () => {
    expect(isEntitled('FREE', 'PRO')).toBe(false);
    expect(isEntitled('BASIC', 'PRO')).toBe(false);
  });

  it('gives every plan the FREE modules', () => {
    for (const plan of PLAN_ORDER) expect(isEntitled(plan, 'FREE')).toBe(true);
  });
});
