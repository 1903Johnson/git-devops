import { describe, expect, it } from 'vitest';
import {
  LOCKOUT_POLICY,
  type LockoutState,
  isLocked,
  lockRemainingMs,
  registerFailure,
  registerSuccess,
} from '../src/index.js';

const now = new Date('2026-08-18T12:00:00Z');
const fresh: LockoutState = { failedLoginCount: 0, lockedUntil: null };

describe('lockout', () => {
  it('does not lock before the threshold', () => {
    let state: LockoutState = fresh;
    for (let i = 1; i < LOCKOUT_POLICY.threshold; i += 1) {
      state = registerFailure(state, now);
      expect(isLocked(state, now)).toBe(false);
    }
    expect(state.failedLoginCount).toBe(LOCKOUT_POLICY.threshold - 1);
  });

  it('locks exactly at the threshold, for the base duration', () => {
    let state: LockoutState = fresh;
    for (let i = 0; i < LOCKOUT_POLICY.threshold; i += 1) state = registerFailure(state, now);
    expect(isLocked(state, now)).toBe(true);
    expect(lockRemainingMs(state, now)).toBe(LOCKOUT_POLICY.baseLockMs);
  });

  it('doubles the lock on each further threshold breach, up to the cap', () => {
    let state: LockoutState = fresh;
    const durations: number[] = [];
    for (let breach = 1; breach <= 6; breach += 1) {
      for (let i = 0; i < LOCKOUT_POLICY.threshold; i += 1) state = registerFailure(state, now);
      durations.push(lockRemainingMs(state, now));
    }
    expect(durations[0]).toBe(LOCKOUT_POLICY.baseLockMs);
    expect(durations[1]).toBe(LOCKOUT_POLICY.baseLockMs * 2);
    expect(durations[2]).toBe(LOCKOUT_POLICY.baseLockMs * 4);
    expect(durations.at(-1)).toBe(LOCKOUT_POLICY.maxLockMs);
    expect(Math.max(...durations)).toBe(LOCKOUT_POLICY.maxLockMs);
  });

  it('expires rather than locking forever', () => {
    // A permanent lock lets anyone who knows a volunteer's email keep them out — a
    // guessing attempt would become a denial of service against a real person.
    let state: LockoutState = fresh;
    for (let i = 0; i < LOCKOUT_POLICY.threshold; i += 1) state = registerFailure(state, now);
    const later = new Date(now.getTime() + LOCKOUT_POLICY.baseLockMs + 1);
    expect(isLocked(state, later)).toBe(false);
    expect(lockRemainingMs(state, later)).toBe(0);
  });

  it('clears the counter and the lock on success', () => {
    let state: LockoutState = fresh;
    for (let i = 0; i < LOCKOUT_POLICY.threshold; i += 1) state = registerFailure(state, now);
    const cleared = registerSuccess();
    expect(cleared).toEqual({ failedLoginCount: 0, lockedUntil: null });
    expect(isLocked(cleared, now)).toBe(false);
  });
});
