// The audit log against a real database. What matters here is not that writing works — it
// is that rewriting does not, and that a secret cannot get in.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { APP_ROLE, attempt, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import { TenantDatabase, runWithTenant } from '@church/tenancy';
import { AuditService, MissingAuditContextError, REDACTED } from '../../src/index.js';

let pool: Pool;
let client: PoolClient;
let db: TenantDatabase;
const church = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
let actorId = '';

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, max: 4 });
  client = await pool.connect();
  await ensureAppRole(client);
  await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
  db = new TenantDatabase(pool, { appRole: APP_ROLE });
});

afterAll(async () => {
  await client.query('DELETE FROM church WHERE id = $1', [church]);
  client.release();
  await pool.end();
});

beforeEach(async () => {
  await client.query('DELETE FROM church WHERE id = $1', [church]);
  await client.query(`INSERT INTO church (id, name, country) VALUES ($1, 'audit', 'US')`, [church]);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO app_user (church_id, email) VALUES ($1, $2) RETURNING id`,
    [church, `actor-${Math.random().toString(36).slice(2)}@example.org`],
  );
  actorId = rows[0]!.id;
});

const asActor = <T>(fn: (audit: AuditService, tx: never) => Promise<T>): Promise<T> =>
  runWithTenant({ churchId: church, userId: actorId, roles: ['CHURCH_ADMIN'] }, () =>
    db.transaction((tx) => fn(new AuditService(tx), tx as never)),
  );

describe('writing', () => {
  it('records who did what, with the roles they held at the time', async () => {
    // A snapshot, not a join: the role assignment may change afterwards, and the line has
    // to say what was true when it happened.
    await asActor((audit) =>
      audit.record({ action: 'module.enabled', resourceType: 'module', resourceId: 'prayer_wall' }),
    );

    const [entry] = await asActor((audit) => audit.list());
    expect(entry).toMatchObject({
      action: 'module.enabled',
      resourceType: 'module',
      resourceId: 'prayer_wall',
      actorUserId: actorId,
      actorRoles: ['CHURCH_ADMIN'],
      sensitivity: 'standard',
    });
  });

  it('computes the changed fields from before and after', async () => {
    await asActor((audit) =>
      audit.record({
        action: 'person.updated',
        resourceType: 'person',
        resourceId: 'p1',
        before: { firstName: 'Jo', status: 'visitor' },
        after: { firstName: 'Jo', status: 'member' },
      }),
    );
    const [entry] = await asActor((audit) => audit.list());
    expect(entry?.changedFields).toEqual(['status']);
    expect(entry?.before).toEqual({ firstName: 'Jo', status: 'visitor' });
  });

  it('never stores a secret, even when handed one', async () => {
    // The rule that makes this table safe to keep for years: an audit log holding password
    // hashes has turned the record of a breach into a second breach.
    await asActor((audit) =>
      audit.record({
        action: 'user.updated',
        resourceType: 'app_user',
        resourceId: actorId,
        before: { email: 'a@b.c', password_hash: 'scrypt$real$hash' },
        after: { email: 'a@b.c', password_hash: 'scrypt$new$hash' },
      }),
    );

    const [entry] = await asActor((audit) => audit.list());
    expect(entry?.before?.password_hash).toBe(REDACTED);
    expect(entry?.after?.password_hash).toBe(REDACTED);
    // But the fact that it changed is still visible, which is the point of redacting
    // rather than dropping.
    expect(entry?.changedFields).toContain('password_hash');

    const raw = await client.query('SELECT before::text, after::text FROM audit_entry');
    expect(JSON.stringify(raw.rows)).not.toContain('scrypt$real$hash');
  });

  it('refuses to write with no tenant context rather than dropping the entry', async () => {
    // A silent no-op would mean actions vanishing from the log exactly when the tenant
    // context is wrong — which is when the log matters most.
    const audit = new AuditService(client);
    await expect(
      audit.record({ action: 'thing.happened', resourceType: 'thing' }),
    ).rejects.toBeInstanceOf(MissingAuditContextError);
  });

  it('records a platform action with no human behind it', async () => {
    await runWithTenant({ churchId: church }, () =>
      db.transaction((tx) =>
        new AuditService(tx).record({
          action: 'module.purged',
          resourceType: 'module',
          resourceId: 'prayer_wall',
          reason: 'retention period elapsed',
        }),
      ),
    );
    const [entry] = await asActor((audit) => audit.list());
    // Null means "no human", never "we did not record who".
    expect(entry?.actorUserId).toBeNull();
    expect(entry?.reason).toBe('retention period elapsed');
  });

  it('rejects an action name that is not dotted and lower case', async () => {
    await expect(
      asActor((audit) => audit.record({ action: 'Did Something', resourceType: 'thing' })),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('append-only', () => {
  it('refuses an UPDATE even from the table owner', async () => {
    // Grants stop the application. The trigger stops a migration, a console session, and
    // anyone who has talked their way into the owner role.
    await asActor((audit) => audit.record({ action: 'module.enabled', resourceType: 'module' }));

    await client.query('BEGIN');
    const { code } = await attempt(client, `UPDATE audit_entry SET action = 'module.disabled'`);
    expect(code).toBe('23001');
    await client.query('ROLLBACK');
  });

  it('gives the application role no privilege to rewrite or erase history', async () => {
    await asActor((audit) => audit.record({ action: 'module.enabled', resourceType: 'module' }));

    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query(`SET LOCAL app.current_church_id = '${church}'`);

    const update = await attempt(client, `UPDATE audit_entry SET reason = 'tampered'`);
    const remove = await attempt(client, 'DELETE FROM audit_entry');
    // 42501 is insufficient_privilege — refused before the trigger is even consulted.
    expect(update.code).toBe('42501');
    expect(remove.code).toBe('42501');
    await client.query('ROLLBACK');
  });

  it('is written in the same transaction as the work, so it cannot outlive a rollback', async () => {
    // An entry written on its own connection can commit while the work rolls back,
    // producing a log that says a thing happened which did not.
    await expect(
      runWithTenant({ churchId: church, userId: actorId }, () =>
        db.transaction(async (tx) => {
          await new AuditService(tx).record({ action: 'person.created', resourceType: 'person' });
          throw new Error('the work failed after the audit line was written');
        }),
      ),
    ).rejects.toThrow('the work failed');

    const survived = await asActor((audit) => audit.list({ action: 'person.created' }));
    expect(survived).toEqual([]);
  });
});

describe('reading', () => {
  beforeEach(async () => {
    await asActor(async (audit) => {
      await audit.record({ action: 'person.created', resourceType: 'person', resourceId: 'p1' });
      await audit.record({ action: 'person.updated', resourceType: 'person', resourceId: 'p1' });
      await audit.record({
        action: 'medical_note.read',
        resourceType: 'medical_note',
        resourceId: 'm1',
        sensitivity: 'restricted',
      });
    });
  });

  it('returns most recent first', async () => {
    const entries = await asActor((audit) => audit.list());
    expect(entries).toHaveLength(3);
    expect(entries[0]?.action).toBe('medical_note.read');
  });

  it('keeps entries written in one transaction in the order they were written', async () => {
    // The bug this pins: `now()` is transaction-start time, so all three of these share one
    // timestamp to the microsecond. Ordering by timestamp put them in arbitrary order, and
    // a timestamp cursor would have skipped or repeated them. `seq` is the total order.
    const entries = await asActor((audit) => audit.list());
    expect(entries.map((entry) => entry.action)).toEqual([
      'medical_note.read',
      'person.updated',
      'person.created',
    ]);
    const seqs = entries.map((entry) => Number(entry.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it('pages by cursor without repeating or skipping a shared timestamp', async () => {
    const [first] = await asActor((audit) => audit.list({ limit: 1 }));
    const next = await asActor((audit) => audit.list({ limit: 2, beforeSeq: first!.seq }));
    expect(next.map((entry) => entry.action)).toEqual(['person.updated', 'person.created']);
    expect(next.map((entry) => entry.id)).not.toContain(first!.id);
  });

  it('filters by action, resource and sensitivity', async () => {
    expect(await asActor((audit) => audit.list({ action: 'person.created' }))).toHaveLength(1);
    expect(await asActor((audit) => audit.list({ resourceType: 'person' }))).toHaveLength(2);
    expect(await asActor((audit) => audit.list({ resourceId: 'p1' }))).toHaveLength(2);
    // The query an investigation starts from: who looked at the sensitive records.
    const restricted = await asActor((audit) => audit.list({ sensitivity: 'restricted' }));
    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.action).toBe('medical_note.read');
  });

  it('caps the page size however large a limit is asked for', async () => {
    const entries = await asActor((audit) => audit.list({ limit: 10_000 }));
    expect(entries.length).toBeLessThanOrEqual(200);
  });

  it('filters by actor', async () => {
    expect(await asActor((audit) => audit.list({ actorUserId: actorId }))).toHaveLength(3);
    const other = '00000000-0000-4000-8000-000000000009';
    expect(await asActor((audit) => audit.list({ actorUserId: other }))).toHaveLength(0);
  });
});
