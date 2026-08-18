import { describe, expect, it, vi } from 'vitest';
import { PASSWORD_POLICY, validatePassword } from '../src/index.js';

const noBreachCheck = { checkBreaches: false as const };
const codes = (result: Awaited<ReturnType<typeof validatePassword>>) =>
  result.failures.map((f) => f.code);

describe('password policy', () => {
  it('accepts a long passphrase with no special characters', async () => {
    // The point of length-over-composition: this is a good password and a composition rule
    // would reject it while accepting Password1!.
    const result = await validatePassword('correct horse battery staple', noBreachCheck);
    expect(result.ok).toBe(true);
  });

  it('rejects anything under the minimum length', async () => {
    const result = await validatePassword('a'.repeat(PASSWORD_POLICY.minLength - 1), noBreachCheck);
    expect(codes(result)).toContain('TOO_SHORT');
  });

  it('rejects absurdly long input', async () => {
    // Not security theatre: unbounded input is unbounded hashing work per request.
    const result = await validatePassword('a'.repeat(PASSWORD_POLICY.maxLength + 1), noBreachCheck);
    expect(codes(result)).toContain('TOO_LONG');
  });

  it('imposes no composition rules', async () => {
    const result = await validatePassword('alllowercaselettersonly', noBreachCheck);
    expect(result.ok).toBe(true);
  });

  it('rejects a password containing the account email', async () => {
    const result = await validatePassword('pastorjohn-is-my-password', {
      ...noBreachCheck,
      identifiers: ['pastorjohn@example.org'],
    });
    expect(codes(result)).toContain('CONTAINS_IDENTIFIER');
  });

  it('rejects trivially repetitive input that passes a length check', async () => {
    expect(codes(await validatePassword('aaaaaaaaaaaaaaaa', noBreachCheck))).toContain(
      'REPETITIVE',
    );
    expect(codes(await validatePassword('abababababababab', noBreachCheck))).toContain(
      'REPETITIVE',
    );
  });

  it('rejects a breached password', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:24230577'),
    ) as unknown as typeof globalThis.fetch;

    const result = await validatePassword('password', { fetch: fetchImpl });
    expect(codes(result)).toContain('BREACHED');
    expect(result.ok).toBe(false);
  });

  it('allows registration but reports the gap when the breach service is down', async () => {
    // A HIBP outage must not stop a church registering volunteers on a Sunday morning —
    // but the caller is told the check did not run, so it can be audited rather than
    // silently skipped.
    const fetchImpl = vi.fn(async () => {
      throw new Error('unreachable');
    }) as unknown as typeof globalThis.fetch;

    const result = await validatePassword('a perfectly reasonable passphrase', {
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.breachCheckSkipped).toBe(true);
  });

  it('can be configured to refuse when the breach service is down', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('unreachable');
    }) as unknown as typeof globalThis.fetch;

    const result = await validatePassword('a perfectly reasonable passphrase', {
      fetch: fetchImpl,
      onUnavailable: 'deny',
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('BREACHED');
  });

  it('reports every failure at once rather than one at a time', async () => {
    const result = await validatePassword('aaa', { ...noBreachCheck, identifiers: ['aaa@x.org'] });
    expect(result.failures.length).toBeGreaterThan(1);
  });
});
