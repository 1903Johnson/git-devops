// MFA enrollment, verification, and recovery.

import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { TenantDatabase, runWithTenant } from '@church/tenancy';
import { createHash } from 'node:crypto';
import { openSecret, sealSecret } from './secret-box.js';
import { counterFor, fromBase32, generateTotpSecret, otpauthUri, verifyCode } from './totp.js';

/**
 * Roles that must hold a second factor.
 *
 * These are the roles that can reach giving records, pastoral cases, and children's data.
 * Members are encouraged but not required: forcing MFA on a congregation of volunteers
 * produces shared secrets on sticky notes, not security.
 */
export const MFA_REQUIRED_ROLES = ['STAFF', 'PASTOR', 'CHURCH_ADMIN', 'CAMPUS_ADMIN'] as const;

export const mfaRequiredFor = (roles: readonly string[]): boolean =>
  roles.some((role) => (MFA_REQUIRED_ROLES as readonly string[]).includes(role));

export const RECOVERY_CODE_COUNT = 10;

/** 80 bits, formatted in groups so it can be read off paper without transcription errors. */
export function generateRecoveryCode(): string {
  const raw = randomBytes(10).toString('base64url').replace(/[-_]/g, '').slice(0, 12).toUpperCase();
  return (raw.match(/.{1,4}/g) ?? []).join('-');
}

export const normalizeRecoveryCode = (code: string): string =>
  code.replace(/[\s-]/g, '').toUpperCase();

/**
 * SHA-256, not scrypt.
 *
 * Same reasoning as refresh tokens: these are 80 bits of uniform randomness the server
 * generated, not a user-chosen password, so there is no dictionary to run and a slow hash
 * buys nothing. It costs plenty, though — ten scrypt hashes at 64 MiB each added roughly
 * two seconds to enrollment, which is an interactive request.
 */
export const hashRecoveryCode = (code: string): string =>
  createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

export interface EnrollmentChallenge {
  readonly secret: string;
  readonly otpauthUri: string;
}

export type ConfirmResult =
  | { readonly status: 'confirmed'; readonly recoveryCodes: string[] }
  | { readonly status: 'invalid_code' }
  | { readonly status: 'not_enrolling' };

export type MfaVerifyResult =
  | { readonly status: 'ok'; readonly method: 'totp' | 'recovery' }
  | { readonly status: 'invalid' }
  | { readonly status: 'not_enrolled' };

interface CredentialRow {
  id: string;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  confirmed_at: Date | null;
  last_used_counter: string | null;
}

export interface MfaServiceOptions {
  readonly pool: Pool;
  /** 32 bytes. In production this comes from KMS or a secrets manager, never from code. */
  readonly encryptionKey: Uint8Array;
  readonly appRole?: string;
}

export class MfaService {
  readonly #db: TenantDatabase;
  readonly #key: Uint8Array;

  constructor(options: MfaServiceOptions) {
    this.#db = new TenantDatabase(
      options.pool,
      options.appRole ? { appRole: options.appRole } : {},
    );
    this.#key = options.encryptionKey;
  }

  /**
   * Starts enrollment: generates a secret and stores it *unconfirmed*.
   *
   * Nothing changes about how the user logs in until they prove they can generate a code.
   * Enabling on issue would lock out anyone who mistyped the setup, lost the QR, or gave
   * up halfway.
   */
  async beginEnrollment(
    churchId: string,
    userId: string,
    account: string,
  ): Promise<EnrollmentChallenge> {
    const secret = generateTotpSecret();
    const sealed = sealSecret(secret, this.#key);

    await runWithTenant({ churchId }, () =>
      this.#db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO mfa_credential (church_id, user_id, secret_ciphertext, secret_iv, secret_tag)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id) DO UPDATE
             SET secret_ciphertext = EXCLUDED.secret_ciphertext,
                 secret_iv = EXCLUDED.secret_iv,
                 secret_tag = EXCLUDED.secret_tag,
                 confirmed_at = NULL,
                 last_used_counter = NULL,
                 updated_at = now()`,
          [churchId, userId, sealed.ciphertext, sealed.iv, sealed.tag],
        );
      }),
    );

    return { secret, otpauthUri: otpauthUri(secret, account) };
  }

  /** Confirms enrollment with a live code, and issues the recovery codes. */
  async confirmEnrollment(churchId: string, userId: string, code: string): Promise<ConfirmResult> {
    return runWithTenant({ churchId }, async () => {
      const credential = await this.#load(userId);
      if (!credential || credential.confirmed_at !== null) return { status: 'not_enrolling' };

      const secret = openSecret(
        {
          ciphertext: credential.secret_ciphertext,
          iv: credential.secret_iv,
          tag: credential.secret_tag,
        },
        this.#key,
      );

      const result = verifyCode(fromBase32(secret), code);
      if (!result.valid) return { status: 'invalid_code' };

      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
      const hashes = codes.map(hashRecoveryCode);

      await this.#db.transaction(async (tx) => {
        await tx.query(
          `UPDATE mfa_credential SET confirmed_at = now(), last_used_counter = $2, updated_at = now()
            WHERE id = $1`,
          [credential.id, result.counter ?? null],
        );
        await tx.query('DELETE FROM mfa_recovery_code WHERE user_id = $1', [userId]);
        for (const hash of hashes) {
          await tx.query(
            'INSERT INTO mfa_recovery_code (church_id, user_id, code_hash) VALUES ($1, $2, $3)',
            [churchId, userId, hash],
          );
        }
      });

      return { status: 'confirmed', recoveryCodes: codes };
    });
  }

  async isEnrolled(churchId: string, userId: string): Promise<boolean> {
    return runWithTenant({ churchId }, async () => {
      const credential = await this.#load(userId);
      return credential !== undefined && credential.confirmed_at !== null;
    });
  }

  /** Verifies a TOTP code, falling back to a recovery code. */
  async verify(churchId: string, userId: string, code: string): Promise<MfaVerifyResult> {
    return runWithTenant({ churchId }, async () => {
      const credential = await this.#load(userId);
      if (!credential || credential.confirmed_at === null) return { status: 'not_enrolled' };

      const secret = openSecret(
        {
          ciphertext: credential.secret_ciphertext,
          iv: credential.secret_iv,
          tag: credential.secret_tag,
        },
        this.#key,
      );

      const lastUsed =
        credential.last_used_counter === null ? null : Number(credential.last_used_counter);
      const result = verifyCode(fromBase32(secret), code, { notBefore: lastUsed });

      if (result.valid) {
        // The counter was read in an earlier transaction, so `notBefore` above only says
        // this code had not been spent *then*. A code stays valid for its whole 30-second
        // step, which is long enough for someone who captured it to present it alongside
        // its owner rather than after them — and an unconditional write would let both
        // through, leaving single-use a property of the clock rather than of the code.
        //
        // The advance is therefore a compare-and-set: it only matches while the stored
        // counter is still behind this one. Losing that race means the code was already
        // spent, which is a replay however innocent it looks from here.
        const counter = result.counter ?? counterFor();
        const advanced = await this.#db.transaction(async (tx) =>
          tx.query(
            `UPDATE mfa_credential SET last_used_counter = $2, updated_at = now()
              WHERE id = $1 AND (last_used_counter IS NULL OR last_used_counter < $2)
              RETURNING id`,
            [credential.id, counter],
          ),
        );
        if ((advanced.rowCount ?? 0) === 0) return { status: 'invalid' };
        return { status: 'ok', method: 'totp' };
      }

      return (await this.#consumeRecoveryCode(userId, code))
        ? { status: 'ok', method: 'recovery' }
        : { status: 'invalid' };
    });
  }

  /** Removes MFA entirely — an admin action, or a user stepping down from a staff role. */
  async disable(churchId: string, userId: string): Promise<void> {
    await runWithTenant({ churchId }, () =>
      this.#db.transaction(async (tx) => {
        await tx.query('DELETE FROM mfa_recovery_code WHERE user_id = $1', [userId]);
        await tx.query('DELETE FROM mfa_credential WHERE user_id = $1', [userId]);
      }),
    );
  }

  async remainingRecoveryCodes(churchId: string, userId: string): Promise<number> {
    return runWithTenant({ churchId }, () =>
      this.#db.transaction(async (tx) => {
        const { rows } = await tx.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM mfa_recovery_code WHERE user_id = $1 AND used_at IS NULL',
          [userId],
        );
        return Number(rows[0]?.count ?? 0);
      }),
    );
  }

  async #load(userId: string): Promise<CredentialRow | undefined> {
    return this.#db.transaction(async (tx) => {
      const { rows } = await tx.query<CredentialRow>(
        `SELECT id, secret_ciphertext, secret_iv, secret_tag, confirmed_at, last_used_counter
           FROM mfa_credential WHERE user_id = $1`,
        [userId],
      );
      return rows[0];
    });
  }

  async #consumeRecoveryCode(userId: string, supplied: string): Promise<boolean> {
    const normalized = normalizeRecoveryCode(supplied);
    if (normalized.length < 8) return false;

    // Marked used rather than deleted, and only where still unused, so two racing requests
    // cannot both spend the same code — the database decides the winner, not the process.
    return this.#db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE mfa_recovery_code SET used_at = now()
          WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
        [userId, hashRecoveryCode(normalized)],
      );
      return (rowCount ?? 0) > 0;
    });
  }
}
