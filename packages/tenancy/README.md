# @church/tenancy

The isolation boundary between churches, enforced in application code. Row-Level Security
is the backstop; this package is the plan.

## The three layers (docs/01 §3)

1. **Database** — RLS policies on every tenant-scoped table.
2. **Application** — this package: a request-scoped context and a repository base class
   that injects `church_id` so no query is written by hand with it.
3. **Testing** — `@church/testing`, which proves layer 1 works for every table.

## Using it

At the API boundary, once per request:

```ts
runWithTenant({ churchId, campusId, userId, roles }, () => handler(req));
```

Everywhere below that, nothing takes a church id as a parameter:

```ts
await db.transaction(async (tx) => {
  const person = await personRepo.insert(tx, { first_name: 'Ada' }); // church_id injected
  return personRepo.findAll(tx);                                     // scoped by RLS
});
```

At startup:

```ts
await db.assertNotRlsExempt(); // refuses to boot on a superuser / BYPASSRLS connection
```

## Design decisions worth knowing

**Context lives in `AsyncLocalStorage`, not a parameter.** An implicit dependency in
exchange for making it impossible to forget to pass the tenant down a call chain.
Forgetting is what leaks data between churches, and a missing argument is easier to miss in
review than a missing `runWithTenant` at the edge.

**All access goes through `transaction()`.** `SET LOCAL` is scoped to one connection and
unwinds at COMMIT. Setting the GUC and then querying through a pool — where each statement
may land on a different connection — produces an isolation layer that is silently inactive.
Checking the connection out for the whole transaction is what makes it real. A test asserts
the role and GUC do not survive on a released connection.

**`findById` adds no `church_id` predicate.** RLS already restricts the visible set, and
adding a redundant filter would mask a policy that is missing or inactive. The isolation
tests must fail loudly when the policy is wrong rather than be papered over here.

**Cross-tenant work is possible but conspicuous.** `unsafeCrossTenantTransaction(reason,
fn)` exists for migrations, platform-admin reporting, and module purge. It is named to be
obvious in review and greppable in audit.

**A boot-time guard against RLS-exempt connections.** Superusers and `BYPASSRLS` roles sail
past every policy: the app would run, tests would pass, and isolation would not exist.
`assertNotRlsExempt()` turns that into a startup failure. Note the subtlety it was written
around — `SET LOCAL ROLE` outside a transaction block is a silent no-op, so the check runs
inside one.

## Running the tests

```bash
pnpm --filter @church/tenancy run test:unit          # context, no database
pnpm --filter @church/tenancy run test:integration   # needs DATABASE_URL
pnpm --filter @church/tenancy run test:isolation     # needs DATABASE_URL
```
