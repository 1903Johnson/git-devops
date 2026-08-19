# @church/migrations

The core schema, the runner that applies it, and the check that refuses to let a
tenant-scoped table exist without a working policy.

## Running

```bash
pnpm --filter @church/migrations run migrate:test   # apply, then verify coverage
```

CI runs this before the integration and isolation suites. `DATABASE_URL` is required;
`APP_DB_ROLE` selects the role that migrations grant to (defaults to the harness's
`app_test`, so CI needs no extra setup).

## Writing a migration

Core migrations live in `sql/`. Optional-module migrations live in
`modules/<key>/migrations/` and are discovered automatically — nothing central to edit,
matching how the module registry finds manifests. Names must be unique across every
directory, so prefix module migrations with the module key.

Every tenant-scoped table needs all four parts:

```sql
CREATE TABLE thing (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id  uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  ...
);

ALTER TABLE thing ENABLE ROW LEVEL SECURITY;
ALTER TABLE thing FORCE ROW LEVEL SECURITY;   -- without this the owner bypasses the policy

CREATE POLICY tenant_isolation ON thing
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON thing TO @app_role@;
```

`@app_role@` is substituted at apply time, so one migration set works in test (`app_test`)
and production (an unprivileged application role) without conditionals in SQL.

## Foreign keys between tenant-scoped tables must carry `church_id`

The four parts above make reads and writes tenant-safe. They do nothing about references.
Postgres runs referential-integrity checks as the owner of the *referenced* table, and
those checks do not consult row-level security — so given

```sql
person_id uuid NOT NULL REFERENCES person (id)
```

one church can insert a row pointing at another church's person knowing nothing but the
UUID. RLS still hides the person on every read, so no data escapes, but two things are
wrong: the insert succeeding is an existence oracle for a UUID in some other tenant, and
the row left behind is a reference the owning church can delete out from under. This is not
theoretical — it was reproduced against a live database while writing `0005_people.sql`.

The fix is to put the tenant inside the key. Give the parent a `UNIQUE (church_id, id)` and
reference both columns:

```sql
CONSTRAINT thing_tenant_key UNIQUE (church_id, id),
CONSTRAINT thing_person_fk FOREIGN KEY (church_id, person_id)
  REFERENCES person (church_id, id) ON DELETE CASCADE
```

Now a mismatched tenant is a foreign-key violation, enforced by the same machinery that was
previously the hole. Two details:

- **Nullable references need the column-list form.** `ON DELETE SET NULL` on a composite key
  tries to null `church_id` too, which is `NOT NULL`, so the delete fails at runtime rather
  than at migration time. Write `ON DELETE SET NULL (campus_id)` (Postgres 15+) to null only
  the optional half.
- **The unique key looks redundant** against the primary key on `id` alone. It is not
  decoration — a composite foreign key needs a unique key of matching shape to point at.

`packages/migrations/test/people-isolation.test.ts` has the regression test, including the
same-tenant case: a constraint that rejects everything is an outage, not isolation.

Applied migrations are immutable: the runner records a checksum and refuses to run if the
file later changes. Add a new migration instead of editing history.

## Why a coverage check exists on top of the boundary rule

`scripts/check-boundaries.mjs` rule C5 greps migration SQL for `ENABLE ROW LEVEL SECURITY`.
That catches the obvious omission and nothing else. All of these pass C5 and leak:

- RLS enabled but not `FORCE`'d — the table's owner, which is whatever role ran the
  migration, ignores every policy.
- A policy with no `WITH CHECK` — a tenant can write rows it cannot read.
- `USING (true)` — structurally perfect, protects nothing.
- A policy dropped by a later migration.

`assertPolicyCoverage` asks pg_catalog after the migrations have run, so what is verified
is what actually exists. Each of the cases above has a test asserting it is caught.

Two escape hatches, both requiring a written reason in `policy-check.ts`:
`TENANT_ROOT_TABLES` (scoped by their own `id` — currently just `church`) and
`PLATFORM_TABLES` (genuinely not customer data — currently just `schema_migrations`).

## The nested option

`applyMigrations` owns its transactions by default. Pass `{ nested: true }` when the caller
already holds one: otherwise the runner's `COMMIT` commits *the caller's* transaction. That
is not hypothetical — it silently persisted fixtures out of a rollback-wrapped test during
development, which is how the option came to exist.
