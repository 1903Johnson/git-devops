// Access tokens.
//
// Short-lived and stateless on purpose: verifying one is a signature check, not a database
// round trip, which is what lets every request carry authentication cheaply. The cost is
// that an access token cannot be revoked mid-life — see the note on revocation lag below.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessTokenClaims {
  /** User id. */
  readonly sub: string;
  /** Tenant. Read by the API boundary to establish the request's tenant context. */
  readonly church_id: string;
  readonly roles: readonly string[];
  readonly campus_id?: string;
  /** Family of the refresh token this access token descends from, for audit correlation. */
  readonly sid?: string;
}

export interface SigningKey {
  /** Key id, published in the JWT header so verification can pick the right key. */
  readonly kid: string;
  readonly secret: Uint8Array;
}

export interface KeyRing {
  /** The key new tokens are signed with. */
  readonly active: SigningKey;
  /**
   * Keys still accepted for verification. During a rotation the previous key stays here
   * until every token signed with it has expired — without that overlap, rotating a key
   * logs out everyone holding a valid token.
   */
  readonly accepted?: readonly SigningKey[];
}

const ISSUER = 'church-platform';
const AUDIENCE = 'church-platform-api';
/**
 * Separate audience for the half-authenticated MFA step.
 *
 * A challenge proves the password was right and nothing more. Sharing an audience with
 * access tokens would mean a challenge is accepted by every API route — password-only
 * access to a system that requires two factors. The split is what makes that impossible
 * rather than merely unlikely.
 */
const MFA_AUDIENCE = 'church-platform-mfa';
const ALGORITHM = 'HS256';

export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

export class InvalidAccessTokenError extends Error {
  constructor(reason: string) {
    super(`Access token rejected: ${reason}`);
    this.name = 'InvalidAccessTokenError';
  }
}

export async function issueAccessToken(
  claims: AccessTokenClaims,
  keys: KeyRing,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    church_id: claims.church_id,
    roles: [...claims.roles],
    ...(claims.campus_id ? { campus_id: claims.campus_id } : {}),
    ...(claims.sid ? { sid: claims.sid } : {}),
  })
    .setProtectedHeader({ alg: ALGORITHM, kid: keys.active.kid })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(keys.active.secret);
}

/**
 * Verifies signature, issuer, audience, expiry, and the claims the tenant layer depends on.
 *
 * The algorithm is pinned. Without `algorithms`, a token claiming `alg: none` or a
 * different family is the classic JWT confusion attack, and the library will otherwise
 * take the header's word for it.
 */
export async function verifyAccessToken(
  token: string,
  keys: KeyRing,
): Promise<AccessTokenClaims & JWTPayload> {
  const candidates = [keys.active, ...(keys.accepted ?? [])];

  let lastError: unknown;
  for (const key of candidates) {
    try {
      const { payload } = await jwtVerify(token, key.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALGORITHM],
      });

      if (typeof payload.sub !== 'string' || typeof payload['church_id'] !== 'string') {
        throw new InvalidAccessTokenError('missing sub or church_id');
      }
      const roles = payload['roles'];
      if (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string')) {
        throw new InvalidAccessTokenError('roles claim is not an array of strings');
      }

      return payload as AccessTokenClaims & JWTPayload;
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) throw error;
      lastError = error;
    }
  }

  throw new InvalidAccessTokenError(
    lastError instanceof Error ? lastError.message : 'no key accepted the signature',
  );
}

export interface MfaChallengeClaims {
  readonly sub: string;
  readonly church_id: string;
}

/** Short-lived proof that credentials were verified, pending a second factor. */
export async function issueMfaChallenge(
  claims: MfaChallengeClaims,
  keys: KeyRing,
  ttlSeconds: number = MFA_CHALLENGE_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ church_id: claims.church_id })
    .setProtectedHeader({ alg: ALGORITHM, kid: keys.active.kid })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(MFA_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(keys.active.secret);
}

export async function verifyMfaChallenge(
  token: string,
  keys: KeyRing,
): Promise<MfaChallengeClaims> {
  const candidates = [keys.active, ...(keys.accepted ?? [])];
  let lastError: unknown;

  for (const key of candidates) {
    try {
      const { payload } = await jwtVerify(token, key.secret, {
        issuer: ISSUER,
        audience: MFA_AUDIENCE,
        algorithms: [ALGORITHM],
      });
      if (typeof payload.sub !== 'string' || typeof payload['church_id'] !== 'string') {
        throw new InvalidAccessTokenError('challenge missing sub or church_id');
      }
      return { sub: payload.sub, church_id: payload['church_id'] as string };
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) throw error;
      lastError = error;
    }
  }

  throw new InvalidAccessTokenError(
    lastError instanceof Error ? lastError.message : 'no key accepted the challenge',
  );
}
