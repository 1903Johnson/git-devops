// Account lockout after repeated failures.
//
// Pure decision logic, kept separate from storage so the escalation can be reasoned about
// and tested without a database.

export const LOCKOUT_POLICY = {
  /** Failures tolerated before the first lock. */
  threshold: 5,
  /** Base lock duration; doubles for each further threshold breach, up to the cap. */
  baseLockMs: 5 * 60_000,
  maxLockMs: 60 * 60_000,
} as const;

export interface LockoutState {
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
}

export const isLocked = (state: LockoutState, now: Date = new Date()): boolean =>
  state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();

/**
 * Next state after a failed attempt.
 *
 * The duration doubles per threshold breach rather than locking permanently: a permanent
 * lock hands anyone who knows a volunteer's email the ability to keep them out, and turns
 * a guessing attempt into a denial-of-service against a real person.
 */
export function registerFailure(state: LockoutState, now: Date = new Date()): LockoutState {
  const failedLoginCount = state.failedLoginCount + 1;
  if (failedLoginCount % LOCKOUT_POLICY.threshold !== 0) {
    return { failedLoginCount, lockedUntil: state.lockedUntil };
  }

  const breaches = Math.floor(failedLoginCount / LOCKOUT_POLICY.threshold);
  const duration = Math.min(
    LOCKOUT_POLICY.baseLockMs * 2 ** (breaches - 1),
    LOCKOUT_POLICY.maxLockMs,
  );
  return { failedLoginCount, lockedUntil: new Date(now.getTime() + duration) };
}

/** Successful login clears both the counter and any expired lock. */
export const registerSuccess = (): LockoutState => ({ failedLoginCount: 0, lockedUntil: null });

export const lockRemainingMs = (state: LockoutState, now: Date = new Date()): number =>
  state.lockedUntil === null ? 0 : Math.max(0, state.lockedUntil.getTime() - now.getTime());
