import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { CurrentUser } from '@church/contracts';
import { IdentityService, MfaService, SessionService, mfaRequiredFor } from '@church/identity';
import { type Role, permissionsFor } from '@church/policy';
import { TenantDatabase } from '@church/tenancy';
import { API_CONFIG, PG_POOL } from '../common/tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Wires the identity packages into one object the controller can use.
 *
 * There is no logic here beyond assembly and the `/me` projection: login, rotation, theft
 * detection and TOTP all live in `@church/identity`, tested against a real database, and
 * duplicating any of it at the HTTP layer would mean two implementations of a rule that
 * must have exactly one.
 */
@Injectable()
export class AuthService {
  readonly sessions: SessionService;
  private readonly mfa: MfaService;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly db: TenantDatabase,
  ) {
    const identity = new IdentityService({ pool: this.pool, appRole: config.appRole });
    this.mfa = new MfaService({
      pool: this.pool,
      appRole: config.appRole,
      encryptionKey: config.mfaEncryptionKey,
    });
    this.sessions = new SessionService({
      pool: this.pool,
      identity,
      keys: config.keys,
      appRole: config.appRole,
      mfa: this.mfa,
    });
  }

  /**
   * The signed-in user, as a client shell needs them.
   *
   * `permissions` is expanded from the roles for rendering only. A client that treated it
   * as authorization would be one tampered response away from showing someone else's data,
   * which is why every request is checked server-side regardless.
   */
  async currentUser(userId: string): Promise<CurrentUser | undefined> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        church_id: string;
        email: string;
        person_id: string | null;
      }>('SELECT id, church_id, email, person_id FROM app_user WHERE id = $1', [userId]);
      const user = rows[0];
      if (!user) return undefined;

      const roleRows = await tx.query<{ role: Role; campus_id: string | null }>(
        'SELECT role, campus_id FROM user_role WHERE user_id = $1 ORDER BY role',
        [userId],
      );
      const roles = roleRows.rows.map((row) => row.role);
      const campusId = roleRows.rows.find((row) => row.campus_id !== null)?.campus_id ?? null;

      const enrolled = await tx.query('SELECT 1 FROM mfa_credential WHERE user_id = $1', [userId]);

      return {
        id: user.id,
        churchId: user.church_id,
        email: user.email,
        campusId,
        roles,
        permissions: [...permissionsFor(roles)].sort(),
        personId: user.person_id,
        mfaEnrolled: (enrolled.rowCount ?? 0) > 0,
        mfaRequired: mfaRequiredFor(roles),
      };
    });
  }
}
