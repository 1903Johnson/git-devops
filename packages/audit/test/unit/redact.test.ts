import { describe, expect, it } from 'vitest';
import { REDACTED, changedFields, isSecretField, redact } from '../../src/index.js';

describe('secret detection', () => {
  it('catches the same field however it is spelled', () => {
    // The same value arrives as `password_hash` from a row and `passwordHash` from a
    // contract type. A list that catches one of them catches none of the ones that matter.
    for (const key of [
      'password',
      'passwordHash',
      'password_hash',
      'token_hash',
      'refreshToken',
      'secret_ciphertext',
      'secret_iv',
      'secret_tag',
      'recoveryCode',
      'recovery_code',
      'privateKey',
      'private_key',
      'authorization',
      'Cookie',
    ]) {
      expect(isSecretField(key), key).toBe(true);
    }
  });

  it('leaves ordinary fields alone', () => {
    for (const key of ['email', 'firstName', 'status', 'campus_id', 'occurredAt']) {
      expect(isSecretField(key), key).toBe(false);
    }
  });
});

describe('redaction', () => {
  it('replaces secrets and keeps the shape', () => {
    // Replaced rather than dropped: a diff should still show *that* a credential changed,
    // which is exactly what an investigation looks for, without recording what it became.
    const redacted = redact({
      email: 'someone@example.org',
      password_hash: 'scrypt$N=16384$abc',
      nested: { refreshToken: 'rt_live_123', status: 'active' },
    }) as Record<string, unknown>;

    expect(redacted.email).toBe('someone@example.org');
    expect(redacted.password_hash).toBe(REDACTED);
    expect((redacted.nested as Record<string, unknown>).refreshToken).toBe(REDACTED);
    expect((redacted.nested as Record<string, unknown>).status).toBe('active');
  });

  it('walks arrays and stringifies dates', () => {
    const redacted = redact({
      users: [{ email: 'a@b.c', token: 'x' }],
      when: new Date('2026-01-01T00:00:00Z'),
    }) as Record<string, unknown>;
    expect((redacted.users as Record<string, unknown>[])[0]!.token).toBe(REDACTED);
    expect(redacted.when).toBe('2026-01-01T00:00:00.000Z');
  });

  it('stops rather than recursing forever on a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });
});

describe('changed fields', () => {
  it('lists only what differs', () => {
    expect(changedFields({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(['b']);
    expect(changedFields({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it('counts an added or removed field as a change', () => {
    expect(changedFields({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(changedFields({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
  });

  it('does not treat key order as a change', () => {
    // JSON.stringify alone would say these differ, and every update would look like it
    // touched everything.
    expect(changedFields({ x: { a: 1, b: 2 } }, { x: { b: 2, a: 1 } })).toEqual([]);
  });

  it('treats a nested object as one field', () => {
    // "settings changed" is what an administrator wants to read. A deep path list turns
    // one edit into forty lines of noise.
    expect(changedFields({ settings: { a: 1 } }, { settings: { a: 2 } })).toEqual(['settings']);
  });

  it('compares dates by value, not identity', () => {
    const when = '2026-01-01T00:00:00.000Z';
    expect(changedFields({ at: new Date(when) }, { at: new Date(when) })).toEqual([]);
  });

  it('returns nothing when there is no pair to compare', () => {
    // A read has neither side; reporting every field as changed would be a lie.
    expect(changedFields(undefined, { a: 1 })).toEqual([]);
    expect(changedFields({ a: 1 }, undefined)).toEqual([]);
  });
});
