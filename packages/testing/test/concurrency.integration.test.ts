// The suite runs package-by-package in parallel against one database, so the setup helpers
// are called by several processes at the same moment. Anything they do to a shared catalog
// object has to survive that.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { APP_ROLE, ensureAppRole } from '../src/index.js';

const CALLERS = 12;
let pool: Pool;

beforeAll(() => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  // A pool of its own rather than the shared admin one: in CI each package is a separate
  // process with a separate pool, and the shared pool's max of 4 would queue the callers
  // instead of racing them, which is the opposite of what this test is for.
  pool = new Pool({ connectionString, max: CALLERS });
});

afterAll(async () => {
  await pool.end();
});

describe('ensureAppRole under concurrency', () => {
  it('survives many callers arriving at once', async () => {
    // `GRANT USAGE ON SCHEMA public` rewrites the pg_namespace row for `public`. Two
    // sessions doing it in the same instant hit `tuple concurrently updated` (XX000) — an
    // error no exception handler inside the statement can catch, because the heap update
    // itself raises it. This is the failure that took CI down on the CORE-017 run:
    // apps/worker and packages/people started within milliseconds of each other.
    const clients = await Promise.all(Array.from({ length: CALLERS }, () => pool.connect()));
    try {
      const results = await Promise.allSettled(clients.map((client) => ensureAppRole(client)));
      const failures = results
        .filter((r) => r.status === 'rejected')
        .map((r) => (r as PromiseRejectedResult).reason?.message);
      expect(failures).toEqual([]);
    } finally {
      for (const client of clients) client.release();
    }

    const { rows } = await pool.query<{ ok: boolean }>(
      'SELECT has_schema_privilege($1, $2, $3) AS ok',
      [APP_ROLE, 'public', 'USAGE'],
    );
    expect(rows[0]?.ok).toBe(true);
  });
});
