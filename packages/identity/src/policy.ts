// Password policy, following NIST SP 800-63B rather than folk wisdom.
//
// Length over composition: no "one uppercase, one symbol" rules, which push people toward
// Password1! and away from passphrases. What is actually screened is length, breach
// membership, and similarity to the account's own identifiers.

import { checkPasswordBreached, type BreachCheckOptions, type BreachResult } from './breach.js';

export const PASSWORD_POLICY = {
  minLength: 12,
  /** NIST recommends accepting long passphrases; the cap only bounds hashing work. */
  maxLength: 256,
} as const;

export type PolicyFailure =
  | { readonly code: 'TOO_SHORT'; readonly message: string }
  | { readonly code: 'TOO_LONG'; readonly message: string }
  | { readonly code: 'BREACHED'; readonly message: string; readonly count: number }
  | { readonly code: 'CONTAINS_IDENTIFIER'; readonly message: string }
  | { readonly code: 'REPETITIVE'; readonly message: string };

export interface PolicyResult {
  readonly ok: boolean;
  readonly failures: PolicyFailure[];
  /** True when the breach service could not be reached, so the check did not happen. */
  readonly breachCheckSkipped: boolean;
}

export interface PolicyOptions extends BreachCheckOptions {
  /** Email and name fragments the password must not simply repeat. */
  readonly identifiers?: readonly string[];
  readonly checkBreaches?: boolean;
}

export async function validatePassword(
  password: string,
  options: PolicyOptions = {},
): Promise<PolicyResult> {
  const failures: PolicyFailure[] = [];
  const normalized = password.normalize('NFKC');

  if (normalized.length < PASSWORD_POLICY.minLength) {
    failures.push({
      code: 'TOO_SHORT',
      message: `Use at least ${PASSWORD_POLICY.minLength} characters. A short phrase works well.`,
    });
  }
  if (normalized.length > PASSWORD_POLICY.maxLength) {
    failures.push({
      code: 'TOO_LONG',
      message: `Use at most ${PASSWORD_POLICY.maxLength} characters.`,
    });
  }

  const lowered = normalized.toLowerCase();
  for (const identifier of options.identifiers ?? []) {
    const candidate = identifier.toLowerCase().split('@')[0] ?? '';
    if (candidate.length >= 4 && lowered.includes(candidate)) {
      failures.push({
        code: 'CONTAINS_IDENTIFIER',
        message: 'Do not include your name or email address in your password.',
      });
      break;
    }
  }

  // A single repeated character or a two-character cycle passes a length check while
  // carrying almost no entropy.
  if (normalized.length > 0 && /^(.)\1+$/.test(normalized)) {
    failures.push({ code: 'REPETITIVE', message: 'Use something less repetitive.' });
  } else if (/^(..)\1+$/.test(normalized)) {
    failures.push({ code: 'REPETITIVE', message: 'Use something less repetitive.' });
  }

  let breachCheckSkipped = false;
  if (options.checkBreaches !== false) {
    const result: BreachResult = await checkPasswordBreached(normalized, options);
    if (result.status === 'breached') {
      failures.push({
        code: 'BREACHED',
        count: result.count,
        message:
          'This password has appeared in a known data breach. Choose one you have not used elsewhere.',
      });
    } else if (result.status === 'unavailable') {
      breachCheckSkipped = true;
      if (!result.allowed) {
        failures.push({
          code: 'BREACHED',
          count: 0,
          message: 'Could not verify this password against known breaches. Please try again.',
        });
      }
    }
  }

  return { ok: failures.length === 0, failures, breachCheckSkipped };
}
