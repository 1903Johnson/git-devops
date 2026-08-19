import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import {
  IdentityService,
  MfaService,
  RECOVERY_CODE_COUNT,
  SessionService,
  counterFor,
  fromBase32,
  generateCode,
  mfaRequiredFor,
  verifyAccessToken,
  type KeyRing,
  type MfaVerifyResult,
} from '../src/index.js';

let pool: Pool;
let identity: IdentityService;
let mfa: MfaService;
let sessions: SessionService;
let churchId: string;

const PASSWORD = 'correct horse battery staple';
const keys: KeyRing = { active: { kid: 'test', secret: new Uint8Array(randomBytes(32)) } };
const encryptionKey = new Uint8Array(randomBytes(32));
const email = () => `mfa-${Math.random().toString(36).slice(2)}@example.org`;
const codeFor = (secret: string) => generateCode(fromBase32(secret), counterFor());
/**
 * The *next* step's code, which the authenticator app will show in a moment.
 *
 * Needed because confirming enrollment consumes the code it was confirmed with: the
 * replay guard records that counter, so the same code cannot log in during the same
 * 30-second step. That is correct behaviour, and these tests would otherwise be asserting
 * that a used code still works.
 */
const nextCodeFor = (secret: string) => generateCode(fromBase32(secret), counterFor() + 1);

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 6 });

  const client = await pool.connect();
  try {
    await ensureAppRole(client);
    await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
  } finally {
    client.release();
  }

  identity = new IdentityService({ pool, appRole: APP_ROLE, policy: { checkBreaches: false } });
  mfa = new MfaService({ pool, encryptionKey, appRole: APP_ROLE });
  sessions = new SessionService({ pool, identity, keys, appRole: APP_ROLE, mfa });
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM church WHERE name LIKE $1', ['mfa-test-%']);
  } finally {
    client.release();
    await pool.end();
  }
});

beforeEach(async () => {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM church WHERE name LIKE $1', ['mfa-test-%']);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO church (name, country) VALUES ('mfa-test', 'US') RETURNING id`,
    );
    churchId = rows[0]!.id;
  } finally {
    client.release();
  }
});

/** See the note in session.integration.test.ts: observed contention, not a sleep. */
async function waitForBlockedBackends(n: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active' AND pid <> pg_backend_pid()`,
    );
    if (Number(rows[0]?.n ?? 0) >= n) return;
    if (Date.now() > deadline) {
      throw new Error(`only ${rows[0]?.n ?? 0} of ${n} backends blocked before timeout`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function unenrolledUser() {
  const address = email();
  const created = await identity.register(churchId, address, PASSWORD);
  if (created.status !== 'created') throw new Error('setup failed');
  return { address, userId: created.userId };
}

async function enrolledUser() {
  const address = email();
  const created = await identity.register(churchId, address, PASSWORD);
  if (created.status !== 'created') throw new Error('setup failed');

  const challenge = await mfa.beginEnrollment(churchId, created.userId, address);
  const confirmed = await mfa.confirmEnrollment(
    churchId,
    created.userId,
    codeFor(challenge.secret),
  );
  if (confirmed.status !== 'confirmed') throw new Error('enrollment failed');

  return {
    address,
    userId: created.userId,
    secret: challenge.secret,
    recoveryCodes: confirmed.recoveryCodes,
  };
}

describe('role policy', () => {
  it('requires MFA for privileged roles and not for members', () => {
    expect(mfaRequiredFor(['CHURCH_ADMIN'])).toBe(true);
    expect(mfaRequiredFor(['MEMBER', 'PASTOR'])).toBe(true);
    expect(mfaRequiredFor(['MEMBER'])).toBe(false);
    expect(mfaRequiredFor([])).toBe(false);
  });
});

describe('enrollment', () => {
  it('does not take effect until a code confirms it', async () => {
    // Enabling on issue locks out anyone who mistyped the setup or lost the QR.
    const address = email();
    const created = await identity.register(churchId, address, PASSWORD);
    if (created.status !== 'created') throw new Error('setup failed');

    await mfa.beginEnrollment(churchId, created.userId, address);
    expect(await mfa.isEnrolled(churchId, created.userId)).toBe(false);

    const login = await sessions.login(address, PASSWORD);
    expect(login.status).toBe('success');
  });

  it('rejects a wrong confirmation code and stays unenrolled', async () => {
    const address = email();
    const created = await identity.register(churchId, address, PASSWORD);
    if (created.status !== 'created') throw new Error('setup failed');

    await mfa.beginEnrollment(churchId, created.userId, address);
    expect((await mfa.confirmEnrollment(churchId, created.userId, '000000')).status).toBe(
      'invalid_code',
    );
    expect(await mfa.isEnrolled(churchId, created.userId)).toBe(false);
  });

  it('issues recovery codes exactly once, on confirmation', async () => {
    const { userId, recoveryCodes } = await enrolledUser();
    expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);
    expect(await mfa.remainingRecoveryCodes(churchId, userId)).toBe(RECOVERY_CODE_COUNT);
  });

  it('stores the secret encrypted, not in the clear', async () => {
    const { userId, secret } = await enrolledUser();
    const { rows } = await pool.query<{ secret_ciphertext: Buffer }>(
      'SELECT secret_ciphertext FROM mfa_credential WHERE user_id = $1',
      [userId],
    );
    expect(rows[0]!.secret_ciphertext.toString('utf8')).not.toContain(secret);
    expect(rows[0]!.secret_ciphertext.toString('base64')).not.toContain(secret);
  });
});

describe('login with MFA', () => {
  it('withholds tokens and returns a challenge', async () => {
    const { address } = await enrolledUser();
    const login = await sessions.login(address, PASSWORD);
    expect(login.status).toBe('mfa_required');
    if (login.status !== 'mfa_required') return;
    expect(login).not.toHaveProperty('tokens');
  });

  it('refuses to accept the challenge as an access token', async () => {
    // The whole point of the separate audience: a challenge proves the password was
    // right and nothing more. If it verified as an access token, MFA would be optional
    // for anyone who read the response body.
    const { address } = await enrolledUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'mfa_required') throw new Error('expected a challenge');

    await expect(verifyAccessToken(login.challenge, keys)).rejects.toThrow();
  });

  it('issues tokens once a valid code is supplied', async () => {
    const { address, secret } = await enrolledUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'mfa_required') throw new Error('expected a challenge');

    const completed = await sessions.completeMfa(login.challenge, nextCodeFor(secret));
    expect(completed.status).toBe('success');
    if (completed.status !== 'success') return;
    await expect(verifyAccessToken(completed.tokens.accessToken, keys)).resolves.toBeDefined();
  });

  it('rejects a wrong code, and a forged challenge', async () => {
    const { address, secret } = await enrolledUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'mfa_required') throw new Error('expected a challenge');

    expect((await sessions.completeMfa(login.challenge, '000000')).status).toBe('invalid');
    expect((await sessions.completeMfa('not-a-token', nextCodeFor(secret))).status).toBe('invalid');
  });
});

describe('replay and recovery', () => {
  it('refuses to reuse the code that confirmed enrollment', async () => {
    // Read the consumed counter back rather than assuming the test still sits inside the
    // same 30-second step — otherwise this passes or fails depending on when it runs.
    const { userId, secret } = await enrolledUser();
    const { rows } = await pool.query<{ last_used_counter: string }>(
      'SELECT last_used_counter FROM mfa_credential WHERE user_id = $1',
      [userId],
    );
    const consumed = Number(rows[0]!.last_used_counter);
    const alreadyUsed = generateCode(fromBase32(secret), consumed);

    expect((await mfa.verify(churchId, userId, alreadyUsed)).status).toBe('invalid');
  });

  it('refuses the same TOTP code twice', async () => {
    // A code stays valid for its full 30-second step, so without the counter check a code
    // read over a shoulder still works.
    const { userId, secret } = await enrolledUser();
    const code = nextCodeFor(secret);

    expect((await mfa.verify(churchId, userId, code)).status).toBe('ok');
    expect((await mfa.verify(churchId, userId, code)).status).toBe('invalid');
  });

  it('refuses a privileged account that never enrolled, and gives it a way in', async () => {
    // The gap REV-004 closes. mfaRequiredFor named STAFF from the day MFA shipped and
    // nothing consulted it: login asked only whether a second factor *existed*, so a
    // privileged account that never set one up was waved through on a password while /me
    // told it, accurately, that MFA was required of it.
    const { address, userId } = await unenrolledUser();
    await pool.query(`INSERT INTO user_role (church_id, user_id, role) VALUES ($1, $2, 'STAFF')`, [
      churchId,
      userId,
    ]);

    const login = await sessions.login(address, PASSWORD);
    expect(login.status).toBe('mfa_enrollment_required');
    if (login.status !== 'mfa_enrollment_required') return;

    // The ticket is not a session. This is the property the whole design rests on, and it
    // holds because of the audience rather than because a route remembered to check.
    await expect(verifyAccessToken(login.enrollmentTicket, keys)).rejects.toThrow();

    const started = await sessions.beginEnrollment(login.enrollmentTicket);
    if (!started) throw new Error('enrollment did not start');

    const confirmed = await sessions.completeEnrollment(
      login.enrollmentTicket,
      nextCodeFor(started.secret),
    );
    expect(confirmed.status).toBe('success');
    if (confirmed.status !== 'success') return;
    expect(confirmed.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);

    // Now enrolled, so the next login owes a code rather than a ticket.
    expect((await sessions.login(address, PASSWORD)).status).toBe('mfa_required');
  });

  it('lets an unprivileged account sign in without a second factor', async () => {
    // MEMBER is deliberately outside MFA_REQUIRED_ROLES: forcing a congregation of
    // volunteers onto TOTP produces shared secrets on paper, not security.
    const { address, userId } = await unenrolledUser();
    await pool.query(`INSERT INTO user_role (church_id, user_id, role) VALUES ($1, $2, 'MEMBER')`, [
      churchId,
      userId,
    ]);
    expect((await sessions.login(address, PASSWORD)).status).toBe('success');
  });

  it('refuses an enrollment ticket forged from an MFA challenge', async () => {
    // Two half-authenticated tokens now exist. Each must be worthless where the other is
    // expected, or the split has bought nothing.
    const { address, secret } = await enrolledUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'mfa_required') throw new Error('expected a challenge');

    expect(await sessions.beginEnrollment(login.challenge)).toBeUndefined();
    const asEnrollment = await sessions.completeEnrollment(login.challenge, nextCodeFor(secret));
    expect(asEnrollment.status).toBe('invalid');
  });

  it('refuses the same TOTP code to two callers arriving together', async () => {
    // The test above proves a code is single-use in sequence. A code is valid for its whole
    // 30-second step, though, so an attacker who captures one does not have to take turns:
    // they present it alongside the owner. If both are validated against the same stored
    // counter, single-use is a property of the clock rather than of the code.
    //
    // The overlap is forced rather than hoped for, as in the refresh rotation race: a third
    // connection holds the credential row so both verifications read the same counter and
    // both stall at their write.
    const { userId, secret } = await enrolledUser();
    const code = nextCodeFor(secret);

    const credentialId = (
      await pool.query<{ id: string }>('SELECT id FROM mfa_credential WHERE user_id = $1', [userId])
    ).rows[0]!.id;

    const blocker = await pool.connect();
    let racing: Promise<[MfaVerifyResult, MfaVerifyResult]>;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM mfa_credential WHERE id = $1 FOR UPDATE', [credentialId]);

      racing = Promise.all([
        mfa.verify(churchId, userId, code),
        mfa.verify(churchId, userId, code),
      ]);
      await waitForBlockedBackends(2);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    const [first, second] = await racing;
    expect([first.status, second.status].sort()).toEqual(['invalid', 'ok']);
  });

  it('accepts a recovery code once and never again', async () => {
    const { userId, recoveryCodes } = await enrolledUser();
    const [first] = recoveryCodes;

    const used = await mfa.verify(churchId, userId, first!);
    expect(used).toEqual({ status: 'ok', method: 'recovery' });
    expect((await mfa.verify(churchId, userId, first!)).status).toBe('invalid');
    expect(await mfa.remainingRecoveryCodes(churchId, userId)).toBe(RECOVERY_CODE_COUNT - 1);
  });

  it('accepts a recovery code however the user types it', async () => {
    const { userId, recoveryCodes } = await enrolledUser();
    const messy = recoveryCodes[1]!.toLowerCase().replace(/-/g, ' ');
    expect((await mfa.verify(churchId, userId, messy)).status).toBe('ok');
  });

  it('lets a recovery code complete a real login', async () => {
    const { address, recoveryCodes } = await enrolledUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'mfa_required') throw new Error('expected a challenge');

    expect((await sessions.completeMfa(login.challenge, recoveryCodes[2]!)).status).toBe('success');
  });
});

describe('disable', () => {
  it('removes the credential and its recovery codes together', async () => {
    const { address, userId } = await enrolledUser();
    await mfa.disable(churchId, userId);

    expect(await mfa.isEnrolled(churchId, userId)).toBe(false);
    expect(await mfa.remainingRecoveryCodes(churchId, userId)).toBe(0);
    expect((await sessions.login(address, PASSWORD)).status).toBe('success');
  });
});
