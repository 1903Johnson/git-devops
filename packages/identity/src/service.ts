// Registration and credential verification.
//
// Token issuance is deliberately absent — that is CORE-014. This layer answers exactly one
// question, "are these credentials good, and is this account usable", and leaves what to
// mint on success to the caller.

import type { Pool, PoolClient } from 'pg';
import { TenantDatabase, runWithTenant } from '@church/tenancy';
import { dummyVerify, hashPassword, needsRehash, verifyPassword } from './password.js';
import {
  isLocked,
  lockRemainingMs,
  registerFailure,
  registerSuccess,
  type LockoutState,
} from './lockout.js';
import { validatePassword, type PolicyFailure, type PolicyOptions } from './policy.js';

export interface UserRow {
  id: string;
  church_id: string;
  email: string;
  password_hash: string | null;
  status: 'active' | 'disabled';
  failed_login_count: number;
  locked_until: Date | null;
}

export type RegistrationResult =
  | { readonly status: 'created'; readonly userId: string }
  | { readonly status: 'rejected'; readonly failures: PolicyFailure[] }
  /**
   * Returned both when the address is already registered and when registration is
   * otherwise refused, so a caller cannot use this endpoint to discover who has an account
   * — including at a church other than their own, since the email index is global.
   */
  | { readonly status: 'unavailable' };

export type LoginResult =
  | { readonly status: 'success'; readonly userId: string; readonly rehashed: boolean }
  | { readonly status: 'invalid' }
  | { readonly status: 'locked'; readonly retryAfterMs: number }
  | { readonly status: 'disabled' };

export interface IdentityServiceOptions {
  readonly pool: Pool;
  readonly appRole?: string;
  readonly policy?: PolicyOptions;
}

export class IdentityService {
  readonly #pool: Pool;
  readonly #db: TenantDatabase;
  readonly #policy: PolicyOptions;

  constructor(options: IdentityServiceOptions) {
    this.#pool = options.pool;
    this.#db = new TenantDatabase(
      options.pool,
      options.appRole ? { appRole: options.appRole } : {},
    );
    this.#policy = options.policy ?? {};
  }

  /** Registration happens inside a known church, so it runs in an ordinary tenant context. */
  async register(churchId: string, email: string, password: string): Promise<RegistrationResult> {
    const policy = await validatePassword(password, {
      ...this.#policy,
      identifiers: [email, ...(this.#policy.identifiers ?? [])],
    });
    if (!policy.ok) return { status: 'rejected', failures: policy.failures };

    const passwordHash = await hashPassword(password);

    return runWithTenant({ churchId }, async () => {
      try {
        return await this.#db.transaction(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO app_user (church_id, email, password_hash, password_changed_at)
             VALUES ($1, $2, $3, now())
             RETURNING id`,
            [churchId, email.trim(), passwordHash],
          );
          const row = rows[0];
          if (!row) return { status: 'unavailable' } as const;
          return { status: 'created', userId: row.id } as const;
        });
      } catch (error) {
        // 23505 is unique_violation on the global email index. Surfacing it would confirm
        // that an address is registered somewhere on the platform.
        if ((error as { code?: string }).code === '23505') return { status: 'unavailable' };
        throw error;
      }
    });
  }

  /**
   * Verifies credentials.
   *
   * This is the one operation that genuinely cannot run inside a tenant context: the church
   * is not known until the user is found, and the user is found by email. It therefore uses
   * the audited cross-tenant escape hatch rather than pretending otherwise. Everything after
   * the lookup — the counter update, the lock — runs scoped to the church that was found.
   */
  async verifyCredentials(email: string, password: string): Promise<LoginResult> {
    const user = await this.#db.unsafeCrossTenantTransaction(
      'authentication: the email lookup precedes any tenant context',
      async (client: PoolClient) => {
        const { rows } = await client.query<UserRow>(
          `SELECT id, church_id, email, password_hash, status, failed_login_count, locked_until
             FROM app_user
            WHERE lower(email) = lower($1)`,
          [email.trim()],
        );
        return rows[0];
      },
    );

    if (!user) {
      // Equalise timing against the real path, so response latency does not reveal which
      // addresses have accounts.
      await dummyVerify(password);
      return { status: 'invalid' };
    }

    const state: LockoutState = {
      failedLoginCount: user.failed_login_count,
      lockedUntil: user.locked_until,
    };

    if (isLocked(state)) return { status: 'locked', retryAfterMs: lockRemainingMs(state) };
    if (user.status === 'disabled') {
      await dummyVerify(password);
      return { status: 'disabled' };
    }
    if (!user.password_hash) {
      // SSO-only account: there is no local credential, and saying so would disclose how
      // the account signs in.
      await dummyVerify(password);
      return { status: 'invalid' };
    }

    // Captured before the closure: TypeScript's narrowing from the guard above does not
    // survive into the callback, and re-reading the nullable field there would be a lie.
    const storedHash = user.password_hash;
    const valid = await verifyPassword(password, storedHash);

    return runWithTenant({ churchId: user.church_id }, async () => {
      if (!valid) {
        const next = registerFailure(state);
        await this.#db.transaction(async (tx) => {
          await tx.query(
            `UPDATE app_user SET failed_login_count = $2, locked_until = $3, updated_at = now()
              WHERE id = $1`,
            [user.id, next.failedLoginCount, next.lockedUntil],
          );
        });
        return isLocked(next)
          ? ({ status: 'locked', retryAfterMs: lockRemainingMs(next) } as const)
          : ({ status: 'invalid' } as const);
      }

      const cleared = registerSuccess();
      const rehashed = needsRehash(storedHash);
      const nextHash = rehashed ? await hashPassword(password) : storedHash;

      await this.#db.transaction(async (tx) => {
        await tx.query(
          `UPDATE app_user
              SET failed_login_count = $2, locked_until = $3, last_login_at = now(),
                  password_hash = $4, updated_at = now()
            WHERE id = $1`,
          [user.id, cleared.failedLoginCount, cleared.lockedUntil, nextHash],
        );
      });

      return { status: 'success', userId: user.id, rehashed } as const;
    });
  }

  get pool(): Pool {
    return this.#pool;
  }
}
