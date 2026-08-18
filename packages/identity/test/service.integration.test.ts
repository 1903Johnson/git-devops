import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { applyMigrations, collectMigrations } from '@church/migrations';
import { CORE_MIGRATIONS_DIR } from '@church/migrations';
import { IdentityService, LOCKOUT_POLICY, hashPassword } from '../src/index.js';

let pool: Pool;
let service: IdentityService;
let churchA: string;
let churchB: string;

const PASSWORD = 'correct horse battery staple';
const noBreachCheck = { checkBreaches: false as const };

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

  service = new IdentityService({ pool, appRole: APP_ROLE, policy: noBreachCheck });
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM church WHERE name LIKE $1', ['identity-test-%']);
  } finally {
    client.release();
    await pool.end();
  }
});

beforeEach(async () => {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM church WHERE name LIKE $1', ['identity-test-%']);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO church (name, country) VALUES ('identity-test-a', 'US'), ('identity-test-b', 'US')
       RETURNING id`,
    );
    churchA = rows[0]!.id;
    churchB = rows[1]!.id;
  } finally {
    client.release();
  }
});

const email = () => `user-${Math.random().toString(36).slice(2)}@example.org`;

describe('registration', () => {
  it('creates a user and lets them log in', async () => {
    const address = email();
    const created = await service.register(churchA, address, PASSWORD);
    expect(created.status).toBe('created');

    const login = await service.verifyCredentials(address, PASSWORD);
    expect(login.status).toBe('success');
  });

  it('rejects a password that fails policy, without creating anything', async () => {
    const address = email();
    const result = await service.register(churchA, address, 'short');
    expect(result.status).toBe('rejected');

    const login = await service.verifyCredentials(address, 'short');
    expect(login.status).toBe('invalid');
  });

  it('returns the same neutral result for a duplicate address, in the same church', async () => {
    const address = email();
    expect((await service.register(churchA, address, PASSWORD)).status).toBe('created');
    expect((await service.register(churchA, address, PASSWORD)).status).toBe('unavailable');
  });

  it('does not reveal that an address is registered at a different church', async () => {
    // The email index is global, so a duplicate raises a unique violation regardless of
    // tenant. Surfacing it would let anyone enumerate the platform's users one address at
    // a time; the result is identical to a same-church duplicate.
    const address = email();
    expect((await service.register(churchA, address, PASSWORD)).status).toBe('created');
    const crossTenant = await service.register(churchB, address, PASSWORD);
    expect(crossTenant.status).toBe('unavailable');
  });
});

describe('login', () => {
  it('returns invalid for an unknown address', async () => {
    expect((await service.verifyCredentials(email(), PASSWORD)).status).toBe('invalid');
  });

  it('returns invalid — not a distinct code — for a wrong password', async () => {
    // Identical to the unknown-address result on purpose: a distinguishable response
    // confirms which addresses have accounts.
    const address = email();
    await service.register(churchA, address, PASSWORD);
    expect((await service.verifyCredentials(address, 'wrong passphrase here')).status).toBe(
      'invalid',
    );
  });

  it('is case-insensitive on the address but not the password', async () => {
    const address = email();
    await service.register(churchA, address, PASSWORD);
    expect((await service.verifyCredentials(address.toUpperCase(), PASSWORD)).status).toBe(
      'success',
    );
    expect((await service.verifyCredentials(address, PASSWORD.toUpperCase())).status).toBe(
      'invalid',
    );
  });

  it('reports disabled accounts separately from bad credentials', async () => {
    const address = email();
    const created = await service.register(churchA, address, PASSWORD);
    if (created.status !== 'created') throw new Error('setup failed');

    const client = await pool.connect();
    try {
      await client.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [created.userId]);
    } finally {
      client.release();
    }

    expect((await service.verifyCredentials(address, PASSWORD)).status).toBe('disabled');
  });

  it('treats an SSO-only account as invalid rather than saying it has no password', async () => {
    const address = email();
    const created = await service.register(churchA, address, PASSWORD);
    if (created.status !== 'created') throw new Error('setup failed');

    const client = await pool.connect();
    try {
      await client.query('UPDATE app_user SET password_hash = NULL WHERE id = $1', [
        created.userId,
      ]);
    } finally {
      client.release();
    }

    expect((await service.verifyCredentials(address, PASSWORD)).status).toBe('invalid');
  });

  it('upgrades a hash made with weaker parameters on successful login', async () => {
    const address = email();
    const created = await service.register(churchA, address, PASSWORD);
    if (created.status !== 'created') throw new Error('setup failed');

    const weak = await hashPassword(PASSWORD, { N: 16384, r: 8, p: 1, keyLength: 32 });
    const client = await pool.connect();
    try {
      await client.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [
        created.userId,
        weak,
      ]);
    } finally {
      client.release();
    }

    const login = await service.verifyCredentials(address, PASSWORD);
    expect(login).toMatchObject({ status: 'success', rehashed: true });

    // And the upgrade is durable, not just reported.
    const after = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM app_user WHERE id = $1',
      [created.userId],
    );
    expect(after.rows[0]!.password_hash).not.toBe(weak);
    expect((await service.verifyCredentials(address, PASSWORD)).status).toBe('success');
  });
});

describe('lockout', () => {
  it('locks after the threshold and reports how long to wait', async () => {
    const address = email();
    await service.register(churchA, address, PASSWORD);

    for (let i = 0; i < LOCKOUT_POLICY.threshold - 1; i += 1) {
      expect((await service.verifyCredentials(address, 'wrong passphrase')).status).toBe('invalid');
    }

    const locked = await service.verifyCredentials(address, 'wrong passphrase');
    expect(locked.status).toBe('locked');
    if (locked.status === 'locked') expect(locked.retryAfterMs).toBeGreaterThan(0);
  });

  it('rejects even the correct password while locked', async () => {
    const address = email();
    await service.register(churchA, address, PASSWORD);
    for (let i = 0; i < LOCKOUT_POLICY.threshold; i += 1) {
      await service.verifyCredentials(address, 'wrong passphrase');
    }
    expect((await service.verifyCredentials(address, PASSWORD)).status).toBe('locked');
  });

  it('clears the counter after a successful login', async () => {
    const address = email();
    await service.register(churchA, address, PASSWORD);

    for (let i = 0; i < LOCKOUT_POLICY.threshold - 1; i += 1) {
      await service.verifyCredentials(address, 'wrong passphrase');
    }
    expect((await service.verifyCredentials(address, PASSWORD)).status).toBe('success');

    const { rows } = await pool.query<{ failed_login_count: number; locked_until: Date | null }>(
      'SELECT failed_login_count, locked_until FROM app_user WHERE lower(email) = lower($1)',
      [address],
    );
    expect(rows[0]!.failed_login_count).toBe(0);
    expect(rows[0]!.locked_until).toBeNull();
  });
});
