// Refresh tokens: opaque, rotating, with family-based theft detection.
//
// Opaque rather than a JWT because these are checked against the database on every use
// anyway — a self-describing token would add parsing surface and leak claims for nothing.

import { createHash, randomBytes } from 'node:crypto';

export const REFRESH_TOKEN_TTL_DAYS = 30;
const SECRET_BYTES = 32;

/** Presented to the client once, at issue. Only its hash is ever stored. */
export const generateRefreshSecret = (): string => randomBytes(SECRET_BYTES).toString('base64url');

/**
 * SHA-256, deliberately not scrypt.
 *
 * These are 256 bits of uniform randomness, not user-chosen passwords: there is nothing to
 * brute-force, so the slow hash that protects a password buys nothing here and would add
 * ~100 ms to every refresh.
 */
export const hashRefreshSecret = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex');

export const refreshExpiry = (from: Date = new Date()): Date =>
  new Date(from.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60_000);

export interface StoredRefreshToken {
  readonly id: string;
  readonly church_id: string;
  readonly user_id: string;
  readonly family_id: string;
  readonly expires_at: Date;
  readonly used_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_reason: string | null;
}

export type RefreshDecision =
  | { readonly action: 'rotate' }
  /** Already used or revoked: someone is replaying a token. Kill the family. */
  | { readonly action: 'revoke_family'; readonly reason: 'reuse_detected' }
  | { readonly action: 'reject'; readonly reason: 'expired' | 'revoked' };

/**
 * What to do with a presented refresh token.
 *
 * The interesting case is reuse. Rotation means a token is valid exactly once, so a second
 * presentation is either a replayed copy or a stolen one, and the two are indistinguishable
 * from here. Revoking the entire family logs out both the attacker and the legitimate
 * holder — which is the right trade, because the alternative leaves a thief with a live
 * session and the user with no signal that anything happened.
 */
export function decideRefresh(token: StoredRefreshToken, now: Date = new Date()): RefreshDecision {
  if (token.revoked_at !== null) {
    return token.revoked_reason === 'rotated'
      ? { action: 'revoke_family', reason: 'reuse_detected' }
      : { action: 'reject', reason: 'revoked' };
  }
  if (token.used_at !== null) return { action: 'revoke_family', reason: 'reuse_detected' };
  if (token.expires_at.getTime() <= now.getTime()) return { action: 'reject', reason: 'expired' };
  return { action: 'rotate' };
}
