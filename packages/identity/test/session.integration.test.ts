import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { IdentityService, SessionService, verifyAccessToken, type KeyRing } from '../src/index.js';

let pool: Pool;
let sessions: SessionService;
let churchId: string;

const PASSWORD = 'correct horse battery staple';
const keys: KeyRing = { active: { kid: 'test', secret: new Uint8Array(randomBytes(32)) } };
const email = () => `session-${Math.random().toString(36).slice(2)}@example.org`;

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

  const identity = new IdentityService({
    pool,
    appRole: APP_ROLE,
    policy: { checkBreaches: false },
  });
  sessions = new SessionService({ pool, identity, keys, appRole: APP_ROLE });
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM church WHERE name LIKE $1', ['session-test-%']);
  } finally {
    client.release();
    await pool.end();
  }
});

beforeEach(async () => {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM church WHERE name LIKE $1', ['session-test-%']);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO church (name, country) VALUES ('session-test', 'US') RETURNING id`,
    );
    churchId = rows[0]!.id;
  } finally {
    client.release();
  }
});

async function newUser() {
  const address = email();
  const identity = new IdentityService({
    pool,
    appRole: APP_ROLE,
    policy: { checkBreaches: false },
  });
  const created = await identity.register(churchId, address, PASSWORD);
  if (created.status !== 'created') throw new Error(`setup failed: ${created.status}`);
  return { address, userId: created.userId };
}

describe('login', () => {
  it('issues a verifiable access token carrying the tenant', async () => {
    const { address } = await newUser();
    const result = await sessions.login(address, PASSWORD, 'Pixel 9');
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;

    const claims = await verifyAccessToken(result.tokens.accessToken, keys);
    expect(claims.church_id).toBe(churchId);
    expect(claims.sub).toBe(result.userId);
    expect(result.tokens.expiresInSeconds).toBe(900);
  });

  it('does not issue tokens for bad credentials', async () => {
    const { address } = await newUser();
    expect((await sessions.login(address, 'wrong passphrase here')).status).toBe('invalid');
  });
});

describe('refresh rotation', () => {
  it('exchanges a refresh token for a new pair', async () => {
    const { address } = await newUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'success') throw new Error('login failed');

    const refreshed = await sessions.refresh(login.tokens.refreshToken);
    expect(refreshed.status).toBe('success');
    if (refreshed.status !== 'success') return;

    expect(refreshed.tokens.refreshToken).not.toBe(login.tokens.refreshToken);
    await expect(verifyAccessToken(refreshed.tokens.accessToken, keys)).resolves.toBeDefined();
  });

  it('keeps the same family across rotations, so one logout ends one device', async () => {
    const { address, userId } = await newUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'success') throw new Error('login failed');
    await sessions.refresh(login.tokens.refreshToken);

    const { rows } = await pool.query<{ family_id: string }>(
      'SELECT DISTINCT family_id FROM refresh_token WHERE user_id = $1',
      [userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('gives separate logins separate families', async () => {
    const { address, userId } = await newUser();
    await sessions.login(address, PASSWORD, 'laptop');
    await sessions.login(address, PASSWORD, 'phone');

    const { rows } = await pool.query(
      'SELECT DISTINCT family_id FROM refresh_token WHERE user_id = $1',
      [userId],
    );
    expect(rows).toHaveLength(2);
  });

  it('rejects an unknown refresh token', async () => {
    expect((await sessions.refresh('not-a-real-token')).status).toBe('invalid');
  });
});

describe('theft detection', () => {
  it('revokes the whole family when a rotated token is presented again', async () => {
    const { address, userId } = await newUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'success') throw new Error('login failed');

    const first = await sessions.refresh(login.tokens.refreshToken);
    if (first.status !== 'success') throw new Error('refresh failed');

    // The attacker replays the token the legitimate client already spent.
    const replay = await sessions.refresh(login.tokens.refreshToken);
    expect(replay.status).toBe('reuse_detected');

    // Both parties are now logged out — the deliberate trade: the alternative leaves a
    // thief holding a live session while the user sees nothing wrong.
    const afterTheft = await sessions.refresh(first.tokens.refreshToken);
    expect(afterTheft.status).toBe('invalid');

    const { rows } = await pool.query<{ revoked_reason: string }>(
      `SELECT revoked_reason FROM refresh_token WHERE user_id = $1 AND revoked_reason = 'reuse_detected'`,
      [userId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('leaves other devices alone when one family is compromised', async () => {
    const { address } = await newUser();
    const phone = await sessions.login(address, PASSWORD, 'phone');
    const laptop = await sessions.login(address, PASSWORD, 'laptop');
    if (phone.status !== 'success' || laptop.status !== 'success') throw new Error('login failed');

    await sessions.refresh(phone.tokens.refreshToken);
    expect((await sessions.refresh(phone.tokens.refreshToken)).status).toBe('reuse_detected');

    // The laptop had nothing to do with it.
    expect((await sessions.refresh(laptop.tokens.refreshToken)).status).toBe('success');
  });
});

describe('logout', () => {
  it('ends the session that presented the token, and only that one', async () => {
    const { address } = await newUser();
    const phone = await sessions.login(address, PASSWORD, 'phone');
    const laptop = await sessions.login(address, PASSWORD, 'laptop');
    if (phone.status !== 'success' || laptop.status !== 'success') throw new Error('login failed');

    await sessions.logout(phone.tokens.refreshToken);

    expect((await sessions.refresh(phone.tokens.refreshToken)).status).toBe('invalid');
    expect((await sessions.refresh(laptop.tokens.refreshToken)).status).toBe('success');
  });

  it('logs out every device — the lost-phone case', async () => {
    const { address, userId } = await newUser();
    const a = await sessions.login(address, PASSWORD, 'phone');
    const b = await sessions.login(address, PASSWORD, 'laptop');
    const c = await sessions.login(address, PASSWORD, 'kiosk');
    if (a.status !== 'success' || b.status !== 'success' || c.status !== 'success') {
      throw new Error('login failed');
    }

    const revoked = await sessions.logoutAllDevices(churchId, userId);
    expect(revoked).toBe(3);

    for (const session of [a, b, c]) {
      expect((await sessions.refresh(session.tokens.refreshToken)).status).toBe('invalid');
    }
  });

  it('records an admin-forced revocation distinctly from a user logout', async () => {
    const { address, userId } = await newUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'success') throw new Error('login failed');

    await sessions.logoutAllDevices(churchId, userId, 'admin');
    const { rows } = await pool.query<{ revoked_reason: string }>(
      'SELECT revoked_reason FROM refresh_token WHERE user_id = $1',
      [userId],
    );
    expect(rows[0]!.revoked_reason).toBe('admin');
  });

  it('leaves an already-issued access token valid until it expires', async () => {
    // Stateless verification is the whole point of a short-lived access token, so
    // revocation cannot be instant. This asserts the window exists rather than pretending
    // otherwise — 15 minutes is the exposure, and it is why the TTL is short.
    const { address, userId } = await newUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'success') throw new Error('login failed');

    await sessions.logoutAllDevices(churchId, userId);

    await expect(verifyAccessToken(login.tokens.accessToken, keys)).resolves.toBeDefined();
    expect((await sessions.refresh(login.tokens.refreshToken)).status).toBe('invalid');
  });
});
