import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseEncryptionKey, parseKeyRing } from '../../src/config.js';

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

const mfaKey = Buffer.alloc(32, 2).toString('base64');
const minimalEnv = {
  DATABASE_URL: 'postgres://x',
  JWT_SIGNING_KEYS: `a:${key}`,
  MFA_ENCRYPTION_KEY: mfaKey,
};

describe('parseEncryptionKey', () => {
  it('insists on exactly 32 bytes', () => {
    // AES-256-GCM takes nothing else. A short key fails deep inside the crypto call on the
    // first enrolment, which is a long way from the mistake that caused it.
    expect(() => parseEncryptionKey(Buffer.alloc(16, 2).toString('base64'))).toThrow(ConfigError);
    expect(() => parseEncryptionKey(Buffer.alloc(64, 2).toString('base64'))).toThrow(ConfigError);
    expect(parseEncryptionKey(mfaKey)).toHaveLength(32);
  });
});

describe('loadConfig', () => {
  it('refuses to start without any required value', () => {
    for (const missing of ['DATABASE_URL', 'JWT_SIGNING_KEYS', 'MFA_ENCRYPTION_KEY']) {
      const env: Record<string, string> = { ...minimalEnv };
      delete env[missing];
      expect(() => loadConfig(env), missing).toThrow(new RegExp(missing));
    }
  });

  it('defaults the database role to an unprivileged one, never a superuser', () => {
    // RLS does not apply to superusers at all, so a default of `postgres` here would
    // disable tenant isolation everywhere while every test still passed.
    const config = loadConfig(minimalEnv);
    expect(config.appRole).toBe('app_runtime');
    expect(config.appRole).not.toBe('postgres');
  });

  it('keeps the MFA key separate from the signing keys', () => {
    // Sharing one key would make rotating the signing key require re-encrypting every
    // enrolled TOTP secret — routine rotation turned into a migration.
    const config = loadConfig(minimalEnv);
    expect(Buffer.from(config.mfaEncryptionKey)).not.toEqual(
      Buffer.from(config.keys.active.secret),
    );
  });
});
