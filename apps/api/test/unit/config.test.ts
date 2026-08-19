import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseKeyRing } from '../../src/config.js';

const key = Buffer.alloc(32, 1).toString('base64');

describe('parseKeyRing', () => {
  it('makes the first key active and the rest accepted', () => {
    const ring = parseKeyRing(`a:${key},b:${key}`);
    expect(ring.active.kid).toBe('a');
    expect(ring.accepted?.map((k) => k.kid)).toEqual(['b']);
  });

  it('rejects a key shorter than 32 bytes', () => {
    // A 16-byte HMAC secret is brute-forceable offline; failing at boot is the only place
    // this can be caught, because a short key signs and verifies perfectly well.
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(() => parseKeyRing(`a:${short}`)).toThrow(ConfigError);
  });

  it('rejects an empty ring and a malformed entry', () => {
    expect(() => parseKeyRing('')).toThrow(ConfigError);
    expect(() => parseKeyRing('nokey')).toThrow(ConfigError);
  });
});

describe('loadConfig', () => {
  it('refuses to start without a database url or signing keys', () => {
    expect(() => loadConfig({ JWT_SIGNING_KEYS: `a:${key}` })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/JWT_SIGNING_KEYS/);
  });

  it('defaults the database role to an unprivileged one, never a superuser', () => {
    // RLS does not apply to superusers at all, so a default of `postgres` here would
    // disable tenant isolation everywhere while every test still passed.
    const config = loadConfig({ DATABASE_URL: 'postgres://x', JWT_SIGNING_KEYS: `a:${key}` });
    expect(config.appRole).toBe('app_runtime');
    expect(config.appRole).not.toBe('postgres');
  });
});
