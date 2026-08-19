# `@church/api`

The HTTP surface. A NestJS modular monolith (`docs/01` §1), Fastify-backed.

This package is the scaffold and the request lifecycle. The business logic lives in
packages — `@church/identity`, `@church/policy`, `@church/tenancy`, and the service
packages Sprint 1 adds — and controllers here are thin.

## The request lifecycle

Assembled in `src/app.module.ts`, matching `docs/01` §3:

| Stage | What it does | Fails with |
|---|---|---|
| `AuthGuard` | Verifies the bearer token, builds the `Subject` | 401 `UNAUTHENTICATED` |
| `PolicyGuard` | `assertCan` for the route's `@RequiresPermission()` | 403 `FORBIDDEN` |
| `TenantInterceptor` | Runs the handler inside `runWithTenant`, so RLS applies | — |
| handler | | |
| `ErrorFilter` | Maps anything thrown to the contract's error envelope | — |

Order is load-bearing. Guards run before interceptors, so tenancy is established *after*
authentication: the church id comes from the verified token, and there is nothing
trustworthy to scope to until the JWT has been checked.

**Two stages are absent and neither is stubbed.** A `ModuleGuard` (CORE-022) returning 404
`MODULE_NOT_ENABLED` belongs between `PolicyGuard` and the handler; audit (CORE-021)
belongs inside `TenantInterceptor`, so entries are written in the same tenant context as
the work they describe. A placeholder for either would be worse than its absence, because
it would look enforced.

## Writing a controller

```ts
@Controller('churches')
export class ChurchController {
  constructor(private readonly churches: ChurchService) {}

  @RequiresPermission(CORE_PERMISSIONS.church_read)
  @Get(':churchId')
  get(@Param('churchId') churchId: string) {
    return this.churches.get(churchId);
  }
}
```

Three rules:

- **Every route declares `@RequiresPermission()` or `@Public()`.** One that declares
  neither is refused at request time, not allowed. The usual way an authorization system
  fails is not a wrong rule; it is a route nobody put a rule on.
- **Inject `TenantDatabase`, never `Pool`.** Going around `TenantDatabase` means going
  around `SET LOCAL app.current_church_id`, and RLS stops applying. The pool is provided
  for migrations and health checks only.
- **Never read the church id from the request.** It comes from the token. A path parameter
  naming a church is for routing and validation, never for scoping — there is a test
  asserting a query string cannot override it.

## Why SWC here and esbuild everywhere else

Nest resolves constructor injection from `design:paramtypes` metadata, which only a
TypeScript-aware transform emits. esbuild — what `tsx` and vitest use by default — cannot
emit decorator metadata at all. Under esbuild every dependency needs an explicit
`@Inject(Token)`, and a forgotten one is a runtime 500 rather than a compile error. That is
the wrong failure mode for the foundation everything else sits on, so this package alone
transforms with SWC, in `vitest.config.ts` and via `@swc-node/register` at runtime. The
rest of the repo is unchanged.

## Running it

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/church_dev \
JWT_SIGNING_KEYS="k1:$(head -c 32 /dev/urandom | base64 -w0)" \
APP_DB_ROLE=app_runtime \
pnpm --filter @church/api run dev
```

`GET /health` is liveness; `GET /health/ready` checks the database. Load balancers need the
difference — a process that is alive but cannot reach Postgres should leave rotation, not
be restarted.

Config is read once at boot and every value is required. A server that starts without a
signing key and discovers it on the first login has turned a boot failure into a 3am
incident.

## Tests

| Suite | What it proves |
|---|---|
| `test:unit` | Config parsing, claim-to-subject mapping, error classification |
| `test:integration` | The lifecycle over real HTTP: auth, authz, tenant context, envelopes |
| `test:isolation` | A token for church A cannot reach church B's rows, including under concurrent load |

The isolation suite is the one that matters. The package suites prove RLS holds when a
query runs inside `runWithTenant`; this one proves the API actually puts it there. Both
halves are needed — "the database is safe" and "the product is safe" are different claims.

New test files must be added to the matching script in `package.json`. They name files
explicitly, so an unregistered suite never runs and its green tick means nothing.
