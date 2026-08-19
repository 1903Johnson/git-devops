// Login, refresh, and logout: the operations that turn verified credentials into a session
// and take it away again.

import type { Pool, PoolClient } from 'pg';
import { TenantDatabase, runWithTenant } from '@church/tenancy';
import { IdentityService, type LoginResult } from './service.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  issueAccessToken,
  issueMfaChallenge,
  verifyMfaChallenge,
  type AccessTokenClaims,
  type KeyRing,
} from './jwt.js';
import type { MfaService } from './mfa.js';
import {
  decideRefresh,
  generateRefreshSecret,
  hashRefreshSecret,
  refreshExpiry,
  type StoredRefreshToken,
} from './refresh.js';

/** The slice of a client this file needs to read roles, so a tx or a client both fit. */
interface RoleQuery {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
}

export type SessionResult =
  | { readonly status: 'success'; readonly tokens: TokenPair; readonly userId: string }
  /** Credentials were right; a second factor is still owed. */
  | { readonly status: 'mfa_required'; readonly challenge: string }
  | { readonly status: 'invalid' }
  | { readonly status: 'locked'; readonly retryAfterMs: number }
  | { readonly status: 'disabled' };

export type RefreshOutcome =
  | { readonly status: 'success'; readonly tokens: TokenPair; readonly userId: string }
  | { readonly status: 'invalid' }
  /** Reuse detected: the family is now revoked and every device on it must log in again. */
  | { readonly status: 'reuse_detected' };

export interface SessionServiceOptions {
  readonly pool: Pool;
  readonly identity: IdentityService;
  readonly keys: KeyRing;
  readonly appRole?: string;
  /** Omit to run without MFA — used by tests that are not exercising it. */
  readonly mfa?: MfaService;
}

export class SessionService {
  readonly #pool: Pool;
  readonly #db: TenantDatabase;
  readonly #identity: IdentityService;
  readonly #keys: KeyRing;
  readonly #mfa: MfaService | undefined;

  constructor(options: SessionServiceOptions) {
    this.#pool = options.pool;
    this.#db = new TenantDatabase(
      options.pool,
      options.appRole ? { appRole: options.appRole } : {},
    );
    this.#identity = options.identity;
    this.#keys = options.keys;
    this.#mfa = options.mfa;
  }

  /** Verifies credentials and, on success, opens a new token family. */
  async login(email: string, password: string, deviceLabel?: string): Promise<SessionResult> {
    const result: LoginResult = await this.#identity.verifyCredentials(email, password);
    if (result.status !== 'success') return result;

    const context = await this.#loadUserContext(result.userId);
    if (!context) return { status: 'invalid' };

    // Enrolled users get a challenge instead of tokens. The password alone is not a
    // session here, and the challenge cannot be used as one — it carries a different
    // audience, which every access-token verification rejects.
    if (this.#mfa && (await this.#mfa.isEnrolled(context.churchId, context.userId))) {
      return {
        status: 'mfa_required',
        challenge: await issueMfaChallenge(
          { sub: context.userId, church_id: context.churchId },
          this.#keys,
        ),
      };
    }

    const tokens = await runWithTenant({ churchId: context.churchId }, () =>
      this.#issuePair(context.userId, context.churchId, crypto.randomUUID(), deviceLabel),
    );
    return { status: 'success', tokens, userId: result.userId };
  }

  /**
   * Exchanges a refresh token for a new pair, rotating it.
   *
   * Like login, the lookup precedes any tenant context: the presented secret is all we
   * have, and the church is a property of the row it matches.
   */
  async refresh(secret: string, deviceLabel?: string): Promise<RefreshOutcome> {
    const hash = hashRefreshSecret(secret);
    const stored = await this.#db.unsafeCrossTenantTransaction(
      'session refresh: the token lookup precedes any tenant context',
      async (client: PoolClient) => {
        const { rows } = await client.query<StoredRefreshToken>(
          `SELECT id, church_id, user_id, family_id, expires_at, used_at, revoked_at, revoked_reason
             FROM refresh_token WHERE token_hash = $1`,
          [hash],
        );
        return rows[0];
      },
    );

    if (!stored) return { status: 'invalid' };

    const decision = decideRefresh(stored);

    return runWithTenant({ churchId: stored.church_id }, async () => {
      if (decision.action === 'reject') return { status: 'invalid' } as const;

      if (decision.action === 'revoke_family') {
        await this.#db.transaction(async (tx) => {
          await tx.query(
            `UPDATE refresh_token
                SET revoked_at = now(), revoked_reason = 'reuse_detected'
              WHERE family_id = $1 AND revoked_at IS NULL`,
            [stored.family_id],
          );
        });
        return { status: 'reuse_detected' } as const;
      }

      const tokens = await this.#db.transaction(async (tx) => {
        await tx.query(
          `UPDATE refresh_token SET used_at = now(), revoked_at = now(), revoked_reason = 'rotated'
            WHERE id = $1`,
          [stored.id],
        );
        return this.#issuePairIn(
          tx,
          stored.user_id,
          stored.church_id,
          stored.family_id,
          deviceLabel,
        );
      });

      return { status: 'success', tokens, userId: stored.user_id } as const;
    });
  }

  /**
   * Completes a login that owed a second factor.
   *
   * A challenge is single-use in effect: it is consumed by producing tokens, and its
   * five-minute life bounds how long a stolen one is worth anything.
   */
  async completeMfa(challenge: string, code: string, deviceLabel?: string): Promise<SessionResult> {
    if (!this.#mfa) return { status: 'invalid' };

    let claims;
    try {
      claims = await verifyMfaChallenge(challenge, this.#keys);
    } catch {
      return { status: 'invalid' };
    }

    const verified = await this.#mfa.verify(claims.church_id, claims.sub, code);
    if (verified.status !== 'ok') return { status: 'invalid' };

    const tokens = await runWithTenant({ churchId: claims.church_id }, () =>
      this.#issuePair(claims.sub, claims.church_id, crypto.randomUUID(), deviceLabel),
    );
    return { status: 'success', tokens, userId: claims.sub };
  }

  /** Ends one session — the device that holds this token, and nothing else. */
  async logout(secret: string): Promise<void> {
    const hash = hashRefreshSecret(secret);
    await this.#db.unsafeCrossTenantTransaction(
      'logout: the token lookup precedes any tenant context',
      async (client: PoolClient) => {
        await client.query(
          `UPDATE refresh_token
              SET revoked_at = now(), revoked_reason = 'logout'
            WHERE family_id = (SELECT family_id FROM refresh_token WHERE token_hash = $1)
              AND revoked_at IS NULL`,
          [hash],
        );
      },
    );
  }

  /**
   * "Log out all devices" — the lost-phone and departed-volunteer case from docs/01 §2.5.
   *
   * Runs inside the tenant context because the user is already known. Access tokens
   * already issued stay valid until they expire; see the revocation-lag note in the README.
   */
  async logoutAllDevices(
    churchId: string,
    userId: string,
    reason: 'logout_all' | 'admin' = 'logout_all',
  ): Promise<number> {
    return runWithTenant({ churchId }, () =>
      this.#db.transaction(async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE refresh_token SET revoked_at = now(), revoked_reason = $2
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId, reason],
        );
        return rowCount ?? 0;
      }),
    );
  }

  async #loadUserContext(
    userId: string,
  ): Promise<{ userId: string; churchId: string } | undefined> {
    return this.#db.unsafeCrossTenantTransaction(
      'session issue: resolving the church of a just-authenticated user',
      async (client: PoolClient) => {
        const { rows } = await client.query<{ id: string; church_id: string }>(
          'SELECT id, church_id FROM app_user WHERE id = $1',
          [userId],
        );
        const row = rows[0];
        return row ? { userId: row.id, churchId: row.church_id } : undefined;
      },
    );
  }

  async #issuePair(
    userId: string,
    churchId: string,
    familyId: string,
    deviceLabel?: string,
  ): Promise<TokenPair> {
    return this.#db.transaction((tx) =>
      this.#issuePairIn(tx, userId, churchId, familyId, deviceLabel),
    );
  }

  /**
   * The roles this user holds, read inside the caller's transaction so RLS scopes them.
   *
   * Loaded at every issue and every refresh rather than cached in the refresh token, so a
   * revoked role stops working within one access-token lifetime (15 minutes) instead of
   * lasting as long as the session. Granting a role is equally prompt.
   */
  async #loadRoles(tx: RoleQuery, userId: string): Promise<{ roles: string[]; campusId?: string }> {
    const { rows } = await tx.query<{ role: string; campus_id: string | null }>(
      'SELECT role, campus_id FROM user_role WHERE user_id = $1 ORDER BY role',
      [userId],
    );
    const campusId = rows.find((row) => row.campus_id !== null)?.campus_id ?? undefined;
    return { roles: rows.map((row) => row.role), ...(campusId ? { campusId } : {}) };
  }

  async #issuePairIn(
    tx: RoleQuery,
    userId: string,
    churchId: string,
    familyId: string,
    deviceLabel?: string,
  ): Promise<TokenPair> {
    const secret = generateRefreshSecret();
    await tx.query(
      `INSERT INTO refresh_token (church_id, user_id, family_id, token_hash, device_label, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [churchId, userId, familyId, hashRefreshSecret(secret), deviceLabel ?? null, refreshExpiry()],
    );

    const { roles, campusId } = await this.#loadRoles(tx, userId);
    const claims: AccessTokenClaims = {
      sub: userId,
      church_id: churchId,
      roles,
      ...(campusId ? { campus_id: campusId } : {}),
      sid: familyId,
    };

    return {
      accessToken: await issueAccessToken(claims, this.#keys),
      refreshToken: secret,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  get pool(): Pool {
    return this.#pool;
  }
}
