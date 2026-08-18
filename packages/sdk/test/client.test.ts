import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, ModuleNotEnabledError, createChurchClient } from '../src/index.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const clientWith = (fetchImpl: typeof globalThis.fetch, token?: string) =>
  createChurchClient({
    baseUrl: 'https://api.test/api/v1',
    fetch: fetchImpl,
    ...(token ? { getAccessToken: () => token } : {}),
  });

describe('createChurchClient', () => {
  it('attaches a bearer token resolved at request time', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (request: Request) => {
      seen.push(request.headers.get('authorization') ?? '');
      return json(200, {
        id: 'c1',
        name: 'Grace',
        country: 'US',
        timezone: 'UTC',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
      });
    }) as unknown as typeof globalThis.fetch;

    // A token that changes between calls: access tokens are short-lived, so a client that
    // captured one at construction would start failing mid-session.
    let current = 'token-1';
    const client = createChurchClient({
      baseUrl: 'https://api.test/api/v1',
      fetch: fetchImpl,
      getAccessToken: () => current,
    });

    await client.raw.GET('/churches/{churchId}', { params: { path: { churchId: 'c1' } } });
    current = 'token-2';
    await client.raw.GET('/churches/{churchId}', { params: { path: { churchId: 'c1' } } });

    expect(seen).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('sends no Authorization header when there is no token', async () => {
    let header: string | null = 'unset';
    const fetchImpl = vi.fn(async (request: Request) => {
      header = request.headers.get('authorization');
      return json(200, {});
    }) as unknown as typeof globalThis.fetch;

    const client = clientWith(fetchImpl);
    await client.raw.GET('/churches/{churchId}', { params: { path: { churchId: 'c1' } } });
    expect(header).toBeNull();
  });
});

describe('unwrap', () => {
  it('returns data on success', async () => {
    const church = {
      id: 'c1',
      name: 'Grace',
      country: 'US',
      timezone: 'UTC',
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const fetchImpl = vi.fn(async () => json(200, church)) as unknown as typeof globalThis.fetch;
    const client = clientWith(fetchImpl, 't');

    const result = await client.raw.GET('/churches/{churchId}', {
      params: { path: { churchId: 'c1' } },
    });
    expect(client.unwrap(result, '/churches/c1')).toEqual(church);
  });

  it('throws ModuleNotEnabledError for a disabled module, not a generic 404', async () => {
    // The wire format is an ordinary 404 so a caller cannot probe which modules a tenant
    // runs. The client is where the distinction is reconstructed, so the UI can say "not
    // enabled" instead of showing a crash.
    const fetchImpl = vi.fn(async () =>
      json(404, { code: 'MODULE_NOT_ENABLED', message: 'nope', requestId: 'req_7' }),
    ) as unknown as typeof globalThis.fetch;
    const client = clientWith(fetchImpl, 't');

    const result = await client.raw.GET('/churches/{churchId}', {
      params: { path: { churchId: 'c1' } },
    });

    expect(() => client.unwrap(result, '/checkin/sessions')).toThrowError(ModuleNotEnabledError);
    try {
      client.unwrap(result, '/checkin/sessions');
    } catch (error) {
      expect((error as ModuleNotEnabledError).requestId).toBe('req_7');
    }
  });

  it('throws ApiRequestError with status and code for other failures', async () => {
    const fetchImpl = vi.fn(async () =>
      json(403, { code: 'FORBIDDEN', message: 'not your church', requestId: 'req_9' }),
    ) as unknown as typeof globalThis.fetch;
    const client = clientWith(fetchImpl, 't');

    const result = await client.raw.GET('/churches/{churchId}', {
      params: { path: { churchId: 'c1' } },
    });

    try {
      client.unwrap(result, '/churches/c1');
      expect.unreachable('should have thrown');
    } catch (error) {
      const failure = error as ApiRequestError;
      expect(failure).toBeInstanceOf(ApiRequestError);
      expect(failure.status).toBe(403);
      expect(failure.code).toBe('FORBIDDEN');
      expect(failure.requestId).toBe('req_9');
      expect(failure.message).toBe('not your church');
    }
  });

  it('still throws when the server sends an unparseable body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>502</html>', { status: 502 }),
    ) as unknown as typeof globalThis.fetch;
    const client = clientWith(fetchImpl, 't');

    const result = await client.raw.GET('/churches/{churchId}', {
      params: { path: { churchId: 'c1' } },
    });

    try {
      client.unwrap(result, '/churches/c1');
      expect.unreachable('should have thrown');
    } catch (error) {
      const failure = error as ApiRequestError;
      expect(failure).toBeInstanceOf(ApiRequestError);
      expect(failure.status).toBe(502);
      expect(failure.code).toBeUndefined();
    }
  });
});
