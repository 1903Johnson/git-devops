# Deploying against Supabase

Supabase is used here as **managed PostgreSQL and nothing else**. Not its auth, not its
generated API, not its client libraries. This matters enough to say first, because the
obvious reading of "we use Supabase" is the opposite.

## Why only the database

The platform already owns the things Supabase would otherwise provide, and they are not
the parts you would want duplicated:

| Supabase offers | Why this project does not use it |
|---|---|
| Supabase Auth (GoTrue) | Identity is `packages/identity`: password policy and breach checks, JWT with rotating refresh-token families, TOTP MFA, and the enrollment gate from REV-004. Two auth systems means two answers to "is this user allowed in", and the weaker one wins. |
| PostgREST auto-API | The API is contract-first (`packages/contracts`), so every route exists in OpenAPI before it exists in code. An auto-generated surface would bypass the guards in `apps/api/src/common` — the module guard, the tenant interceptor, the policy check. |
| `anon` / `authenticated` / `service_role` | Tenancy is keyed on `church_id` through RLS driven by a session GUC, not on a Supabase JWT. Those roles have no idea which church a request belongs to. |

What Supabase does give: a managed Postgres with backups, connection pooling, and no
server to run. That is the whole reason it is here.

## Two things to know before you start

**The Postgres versions differ.** CI and `docker-compose.yml` pin **PostgreSQL 16**; the
Supabase project runs **17**. Nothing in the schema is known to be version-sensitive, but
"known to be" is doing real work in that sentence — nothing has verified it, because CI has
only ever run 16. Treat Supabase as unverified ground until either CI gains a 17 matrix
entry or the suites have been run against it once. This is exactly the class of gap that
`docker-compose.yml` carries a comment about.

**`docs/04` INF-005 assumes AWS RDS.** That ticket plans Terraform for VPC, RDS,
ElastiCache, S3 and ECS/Fargate. Supabase replaces the RDS half of it. INF-005 needs
rewriting before anyone builds it, or you will end up provisioning a database you do not
use.

## Roles

Two, deliberately:

```
church_app    logs in, holds no privileges
app_church    holds every table grant, cannot log in
```

`TenantDatabase` issues `SET LOCAL ROLE app_church` inside every transaction, which
Postgres allows only between roles that are members of one another. Splitting them means a
leaked connection string is not by itself a leaked set of privileges, and it keeps the
deployed shape identical to the one the isolation suites run against.

Neither role may be `SUPERUSER` or hold `BYPASSRLS`, and neither may own the tables.
**Row-level security is not applied to a superuser, and a table's owner bypasses it unless
the table is `FORCE`'d.** Our tables are forced, so ownership is belt-and-braces rather
than the only defence — but a superuser connection would void the tenant boundary
completely while every query kept working, which is the failure mode with no symptoms.

`TenantDatabase.assertNotRlsExempt()` refuses to boot in that state. Call it at startup.

## Steps

1. **Un-pause the project.** The Supabase dashboard reports it as `INACTIVE`; a paused
   project accepts no connections.

2. **Create the login role.** Edit `infra/supabase/bootstrap.sql` to set a generated
   password, then run its first half against the project as `postgres` (SQL Editor, or
   `psql` with the direct connection string).

3. **Apply the schema**, as `postgres`, over the **direct** connection on port 5432 —
   not the pooler. Migrations issue DDL and create a role; both want a real session.

   ```bash
   APP_DB_ROLE=app_church \
   DATABASE_URL='postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres' \
     pnpm --filter @church/migrations run migrate:test
   ```

   That creates `app_church` and grants it every table (`@app_role@` in
   `packages/migrations/sql`).

4. **Finish the bootstrap.** Run the rest of `infra/supabase/bootstrap.sql`. It grants
   `app_church` to `church_app` and then refuses to complete if either role is
   RLS-exempt or owns tables.

5. **Point the application at the pooler**, port 6543, as `church_app`:

   ```
   DATABASE_URL=postgresql://church_app:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
   APP_DB_ROLE=app_church
   ```

## Connection pooling

Transaction-mode pooling is safe here, and it is safe for a specific reason rather than by
luck: every piece of per-request state this platform sets is **transaction-scoped**.
`SET LOCAL ROLE`, `set_config('app.current_church_id', ..., true)`, and
`pg_advisory_xact_lock` all unwind with the transaction, so a pooled connection handed to
the next request carries nothing from the last one.

The corollary is a rule worth keeping: **never introduce session-scoped state.** A plain
`SET ROLE` or `set_config(..., false)` would survive into another church's request through
the pooler. That is not a performance bug; it is a cross-tenant read, and RLS would not
catch it because the GUC would say the request legitimately belongs to the previous
tenant.

Use the direct connection (5432) for migrations and anything else issuing DDL.

## What is not covered here

The application still needs `JWT_SIGNING_KEYS` and `MFA_ENCRYPTION_KEY` from somewhere
that is not this file — see `.env.example` for their shapes. Supabase holds no secrets for
this platform beyond the database password.
