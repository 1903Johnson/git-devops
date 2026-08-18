// Breached-password check via the Have I Been Pwned range API.
//
// k-anonymity: only the first five characters of the SHA-1 are sent, and the response is a
// list of suffixes to match locally. The full password, and its full hash, never leave the
// process.

import { createHash } from 'node:crypto';

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';

export interface BreachCheckOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /**
   * What to do when the service is unreachable.
   *
   * Default 'allow': a third-party outage must not stop every church from registering
   * volunteers on a Sunday morning. 'deny' is available for deployments that would rather
   * fail closed. Either way the caller learns the check did not run, and should record
   * that — a silently skipped check is the worst of both.
   */
  readonly onUnavailable?: 'allow' | 'deny';
}

export type BreachResult =
  | { readonly status: 'clean' }
  | { readonly status: 'breached'; readonly count: number }
  | { readonly status: 'unavailable'; readonly allowed: boolean; readonly reason: string };

/** Number of times a password appears in known breaches, or why we could not tell. */
export async function checkPasswordBreached(
  password: string,
  options: BreachCheckOptions = {},
): Promise<BreachResult> {
  const digest = createHash('sha1').update(password.normalize('NFKC')).digest('hex').toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);

  const doFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);

  try {
    const response = await doFetch(`${RANGE_URL}${prefix}`, {
      signal: controller.signal,
      headers: { 'Add-Padding': 'true' },
    });

    if (!response.ok) {
      return unavailable(options, `range API returned ${response.status}`);
    }

    const body = await response.text();
    for (const line of body.split('\n')) {
      const [candidate, countText] = line.trim().split(':');
      if (candidate === suffix) {
        const count = Number(countText);
        // Padding entries are returned with a count of 0 and must not be treated as hits.
        if (count > 0) return { status: 'breached', count };
      }
    }
    return { status: 'clean' };
  } catch (error) {
    return unavailable(options, (error as Error).message);
  } finally {
    clearTimeout(timeout);
  }
}

const unavailable = (options: BreachCheckOptions, reason: string): BreachResult => ({
  status: 'unavailable',
  allowed: (options.onUnavailable ?? 'allow') === 'allow',
  reason,
});
