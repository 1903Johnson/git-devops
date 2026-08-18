import { describe, expect, it } from 'vitest';
import {
  decideRefresh,
  generateRefreshSecret,
  hashRefreshSecret,
  refreshExpiry,
  type StoredRefreshToken,
} from '../src/index.js';

const base: StoredRefreshToken = {
  id: 'r1',
  church_id: 'c1',
  user_id: 'u1',
  family_id: 'f1',
  expires_at: new Date('2026-12-01T00:00:00Z'),
  used_at: null,
  revoked_at: null,
  revoked_reason: null,
};
const now = new Date('2026-08-18T12:00:00Z');

describe('refresh secrets', () => {
  it('generates unpredictable, url-safe secrets', () => {
    const secrets = new Set(Array.from({ length: 200 }, generateRefreshSecret));
    expect(secrets.size).toBe(200);
    for (const secret of secrets) expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically and does not echo the secret', () => {
    const secret = generateRefreshSecret();
    expect(hashRefreshSecret(secret)).toBe(hashRefreshSecret(secret));
    expect(hashRefreshSecret(secret)).not.toContain(secret);
    expect(hashRefreshSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expires 30 days out', () => {
    const days = (refreshExpiry(now).getTime() - now.getTime()) / 86_400_000;
    expect(days).toBe(30);
  });
});

describe('decideRefresh', () => {
  it('rotates a fresh, unused token', () => {
    expect(decideRefresh(base, now)).toEqual({ action: 'rotate' });
  });

  it('treats a second use as theft and kills the family', () => {
    // Rotation makes a token valid exactly once. A second presentation is a replay or a
    // stolen copy, and from here those are indistinguishable.
    const used = { ...base, used_at: new Date('2026-08-18T11:00:00Z') };
    expect(decideRefresh(used, now)).toEqual({ action: 'revoke_family', reason: 'reuse_detected' });
  });

  it('treats a rotated-then-presented token as theft, not merely revoked', () => {
    const rotated = {
      ...base,
      revoked_at: new Date('2026-08-18T11:00:00Z'),
      revoked_reason: 'rotated',
    };
    expect(decideRefresh(rotated, now)).toEqual({
      action: 'revoke_family',
      reason: 'reuse_detected',
    });
  });

  it('rejects a token revoked by logout without escalating', () => {
    // A deliberate logout is not evidence of theft; escalating would be noise.
    const out = { ...base, revoked_at: new Date('2026-08-18T11:00:00Z'), revoked_reason: 'logout' };
    expect(decideRefresh(out, now)).toEqual({ action: 'reject', reason: 'revoked' });
  });

  it('rejects an expired token', () => {
    const expired = { ...base, expires_at: new Date('2026-08-18T11:59:59Z') };
    expect(decideRefresh(expired, now)).toEqual({ action: 'reject', reason: 'expired' });
  });

  it('rejects a token expiring exactly now rather than allowing it', () => {
    const boundary = { ...base, expires_at: now };
    expect(decideRefresh(boundary, now)).toEqual({ action: 'reject', reason: 'expired' });
  });
});
