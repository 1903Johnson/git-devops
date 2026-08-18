# @church/testing

Test harness for anything that touches the database. Its job is to make the mandatory
tenant-isolation category from `docs/03` §6 a one-liner per table, and to make that
one-liner trustworthy.

## Using it

```ts
import { assertTenantIsolation, ensureAppRole, withRollback } from '@church/testing';

it('isolates tenants', async () => {
  await withRollback(async (client) => {
    await assertTenantIsolation(client, {
      table: 'person',
      insert: async (c, churchId) => {
        const { rows } = await c.query(
          'INSERT INTO person (church_id, first_name) VALUES ($1, $2) RETURNING id',
          [churchId, 'Test'],
        );
        return rows[0].id;
      },
    });
  });
});
```

Call `ensureAppRole` once in `beforeAll`. Everything runs inside a transaction that is
always rolled back, so tests leave no residue and can run in any order.

## What `assertTenantIsolation` proves

| Check | Failure it catches |
|---|---|
| `rls_enabled` | Policy written but never enabled |
| `rls_forced` | Enabled but not FORCE'd — the table's owner sails past it |
| `select_scope` | Reads return other churches' rows |
| `select_by_id` | Guessing another church's row id works |
| `update_across_tenant` | Writes reach across the boundary |
| `delete_across_tenant` | Deletes reach across the boundary |
| `insert_across_tenant` | Missing `WITH CHECK` — a tenant can plant rows in another |
| `unknown_tenant` | A church id owning nothing can still see rows |

`checkTenantIsolation` returns the whole list so one run reports every hole;
`assertTenantIsolation` throws with all of them named.

## Two traps this harness exists to avoid

**Superusers bypass RLS.** PostgreSQL does not apply row-level security to superusers, and
CI connects as `postgres`. A test written naively against that connection passes whether
or not the policy works — the worst kind of green. Every helper here switches to the
non-superuser `app_test` role (`SET LOCAL ROLE`) before touching tenant data, and
`harness.integration.test.ts` asserts that `is_superuser` is false inside a tenant context.

**Table owners bypass RLS too**, unless the table is `FORCE`'d. A migration run as the
application user produces exactly that situation, so `rls_forced` is checked structurally
rather than assumed.

Both are verified in the negative as well as the positive: `isolation.test.ts` builds
deliberately broken tables — no policy, unforced RLS, missing `WITH CHECK` — and asserts
each one is caught. A test helper that only ever passes is indistinguishable from one that
does nothing.

## Running

Needs a real PostgreSQL; `DATABASE_URL` must be set. CI provides one via a service
container.

```bash
pnpm --filter @church/testing run test:integration   # plumbing
pnpm --filter @church/testing run test:isolation     # the assertion's own self-test
```
