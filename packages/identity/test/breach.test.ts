import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkPasswordBreached } from '../src/index.js';

// SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
const PASSWORD_PREFIX = '5BAA6';
const PASSWORD_SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

const respondWith = (body: string, status = 200) =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;

describe('breach check', () => {
  it('sends only the first five hash characters', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      seen.push(String(url));
      return new Response('');
    }) as unknown as typeof globalThis.fetch;

    await checkPasswordBreached('password', { fetch: fetchImpl });

    expect(seen[0]).toBe(`https://api.pwnedpasswords.com/range/${PASSWORD_PREFIX}`);
    expect(seen[0]).not.toContain(PASSWORD_SUFFIX);
  });

  it('never puts the password or its full digest on the wire', async () => {
    // k-anonymity is the whole reason this check is acceptable at all: the secret and its
    // full hash stay in the process. Uses a distinctive passphrase, because asserting the
    // absence of "password" is meaningless against a host called pwnedpasswords.com.
    const secret = 'zaphod-beeblebrox-improbability-42';
    const digest = createHash('sha1').update(secret).digest('hex').toUpperCase();

    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      seen.push(String(url));
      return new Response('');
    }) as unknown as typeof globalThis.fetch;

    await checkPasswordBreached(secret, { fetch: fetchImpl });

    expect(seen[0]).not.toContain('zaphod');
    expect(seen[0]).not.toContain(digest.slice(5));
    expect(seen[0]).toBe(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`);
  });

  it('reports a breached password with its count', async () => {
    const result = await checkPasswordBreached('password', {
      fetch: respondWith(`${PASSWORD_SUFFIX}:24230577\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:5`),
    });
    expect(result).toEqual({ status: 'breached', count: 24230577 });
  });

  it('reports a clean password when the suffix is absent', async () => {
    const result = await checkPasswordBreached('password', {
      fetch: respondWith('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:5'),
    });
    expect(result).toEqual({ status: 'clean' });
  });

  it('ignores padding entries, which have a count of zero', async () => {
    // With Add-Padding the API returns decoy suffixes at count 0; treating one as a hit
    // would reject a perfectly good password.
    const result = await checkPasswordBreached('password', {
      fetch: respondWith(`${PASSWORD_SUFFIX}:0`),
    });
    expect(result).toEqual({ status: 'clean' });
  });

  it('fails open by default when the service is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof globalThis.fetch;

    const result = await checkPasswordBreached('password', { fetch: fetchImpl });
    expect(result).toEqual({ status: 'unavailable', allowed: true, reason: 'network down' });
  });

  it('can be configured to fail closed', async () => {
    const result = await checkPasswordBreached('password', {
      fetch: respondWith('', 503),
      onUnavailable: 'deny',
    });
    expect(result.status).toBe('unavailable');
    expect(result).toMatchObject({ allowed: false });
  });
});
