import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import {
  IdentityService,
  SessionService,
  verifyAccessToken,
  type KeyRing,
  type RefreshOutcome,
} from '../src/index.js';

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

/**
 * Waits until `n` backends are stalled waiting on a lock.
 *
 * Racing two requests and hoping they overlap produces a test that passes against the
 * defect it exists to catch. Waiting for the contention to be observable in
 * pg_stat_activity makes the overlap a fact rather than a hope.
 */
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

  it('treats a concurrent second presentation as reuse, not a second session', async () => {
    // Rotation is a theft control only if a token is spendable exactly once. Sequentially
    // it is — the test above proves that. This asks whether the property survives two
    // holders presenting the same token at the same instant, which is the shape of a
    // stolen token racing its legitimate owner: the case the sequential test cannot see,
    // and the one an attacker gets to choose.
    //
    // The interleaving is forced rather than hoped for. Two bare Promise.all refreshes
    // pass against the broken code most of the time, because they happen to serialise —
    // which would make this a test that reports green on a live defect. So a third
    // connection takes a row lock on the token first: both refreshes then read it as
    // unused, and both stall at their UPDATE until the lock is released. That is the
    // window an attacker has, held open on purpose.
    const { address, userId } = await newUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'success') throw new Error('login failed');

    const tokenId = (
      await pool.query<{ id: string }>(
        'SELECT id FROM refresh_token WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      )
    ).rows[0]!.id;

    const blocker = await pool.connect();
    let racing: Promise<[RefreshOutcome, RefreshOutcome]>;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM refresh_token WHERE id = $1 FOR UPDATE', [tokenId]);

      racing = Promise.all([
        sessions.refresh(login.tokens.refreshToken),
        sessions.refresh(login.tokens.refreshToken),
      ]);

      // Both have read the token and are queued behind the lock. Waiting on the observed
      // lock waits rather than a sleep is what makes this deterministic instead of merely
      // likely.
      await waitForBlockedBackends(2);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    const [first, second] = await racing;

    // Exactly one winner. Two successes means the thief and the owner both hold a live
    // session and nothing was detected.
    expect([first.status, second.status].sort()).toEqual(['reuse_detected', 'success']);

    // And the detection has to bite: the winner's successor dies with the family. The
    // loser blocks on the winner's row lock until it commits, so that successor is
    // already visible when the family is revoked — the lock is what makes the ordering
    // hold rather than luck.
    const winner = [first, second].find((r) => r.status === 'success');
    if (winner?.status !== 'success') throw new Error('expected exactly one success');
    expect((await sessions.refresh(winner.tokens.refreshToken)).status).toBe('invalid');

    const live = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM refresh_token WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    expect(live.rows[0]?.n).toBe('0');
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

describe('roles in the access token', () => {
  /** Grants a role, outside tenant context — the seeding path, not the request path. */
  async function grant(userId: string, role: string, campusId?: string) {
    const client = await pool.connect();
    try {
      await client.query(
        'INSERT INTO user_role (church_id, user_id, role, campus_id) VALUES ($1, $2, $3, $4)',
        [churchId, userId, role, campusId ?? null],
      );
    } finally {
      client.release();
    }
  }

  async function newCampus(): Promise<string> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO campus (church_id, name) VALUES ($1, 'North') RETURNING id`,
        [churchId],
      );
      return rows[0]!.id;
    } finally {
      client.release();
    }
  }

  it('carries the roles the user actually holds', async () => {
    // This array was hardcoded empty until CORE-019, so every permission-guarded route
    // denied every real user — an authorization system that was correct and inert.
    const { address, userId } = await newUser();
    await grant(userId, 'STAFF');

    const result = await sessions.login(address, PASSWORD);
    if (result.status !== 'success') throw new Error(`login failed: ${result.status}`);
    const claims = await verifyAccessToken(result.tokens.accessToken, keys);
    expect(claims.roles).toEqual(['STAFF']);
  });

  it('carries the campus of a campus-scoped role', async () => {
    // Without the campus the policy engine skips its narrowing check entirely, and a
    // campus admin silently reaches the whole church.
    const { address, userId } = await newUser();
    const campusId = await newCampus();
    await grant(userId, 'CAMPUS_ADMIN', campusId);

    const result = await sessions.login(address, PASSWORD);
    if (result.status !== 'success') throw new Error('login failed');
    expect((await verifyAccessToken(result.tokens.accessToken, keys)).campus_id).toBe(campusId);
  });

  it('issues an empty set for a user with no roles, rather than failing', async () => {
    const { address } = await newUser();
    const result = await sessions.login(address, PASSWORD);
    if (result.status !== 'success') throw new Error('login failed');
    expect((await verifyAccessToken(result.tokens.accessToken, keys)).roles).toEqual([]);
  });

  it('picks up a role granted mid-session, on the next refresh', async () => {
    // Roles are read at issue and at refresh rather than baked into the refresh token, so
    // a grant takes effect within one access-token lifetime instead of lasting the session.
    const { address, userId } = await newUser();
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'success') throw new Error('login failed');
    expect((await verifyAccessToken(login.tokens.accessToken, keys)).roles).toEqual([]);

    await grant(userId, 'PASTOR');

    const refreshed = await sessions.refresh(login.tokens.refreshToken);
    if (refreshed.status !== 'success') throw new Error('refresh failed');
    expect((await verifyAccessToken(refreshed.tokens.accessToken, keys)).roles).toEqual(['PASTOR']);
  });

  it('drops a revoked role on the next refresh', async () => {
    // The direction that matters: revocation must reach an active session promptly, or
    // removing someone's access means waiting for them to log out.
    const { address, userId } = await newUser();
    await grant(userId, 'STAFF');
    const login = await sessions.login(address, PASSWORD);
    if (login.status !== 'success') throw new Error('login failed');

    const client = await pool.connect();
    try {
      await client.query('DELETE FROM user_role WHERE user_id = $1', [userId]);
    } finally {
      client.release();
    }

    const refreshed = await sessions.refresh(login.tokens.refreshToken);
    if (refreshed.status !== 'success') throw new Error('refresh failed');
    expect((await verifyAccessToken(refreshed.tokens.accessToken, keys)).roles).toEqual([]);
  });

  it("cannot see another church's role rows", async () => {
    // user_role is RLS-scoped and read inside the tenant transaction; a leak here would
    // put another church's privileges into this church's token.
    const { address, userId } = await newUser();
    await grant(userId, 'STAFF');

    const client = await pool.connect();
    let otherChurch: string;
    let otherUser: string;
    try {
      const church = await client.query<{ id: string }>(
        `INSERT INTO church (name, country) VALUES ('role-iso', 'US') RETURNING id`,
      );
      otherChurch = church.rows[0]!.id;
      const user = await client.query<{ id: string }>(
        `INSERT INTO app_user (church_id, email) VALUES ($1, $2) RETURNING id`,
        [otherChurch, email()],
      );
      otherUser = user.rows[0]!.id;
      await client.query(
        `INSERT INTO user_role (church_id, user_id, role) VALUES ($1, $2, 'CHURCH_ADMIN')`,
        [otherChurch, otherUser],
      );
    } finally {
      client.release();
    }

    const result = await sessions.login(address, PASSWORD);
    if (result.status !== 'success') throw new Error('login failed');
    expect((await verifyAccessToken(result.tokens.accessToken, keys)).roles).toEqual(['STAFF']);

    const cleanup = await pool.connect();
    try {
      await cleanup.query('DELETE FROM church WHERE id = $1', [otherChurch]);
    } finally {
      cleanup.release();
    }
  });
});
