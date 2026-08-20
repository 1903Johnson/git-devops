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
| `ModuleGuard` | Withholds routes of a module the tenant has not enabled | 404 `MODULE_NOT_ENABLED` |
| `TenantInterceptor` | Runs the handler inside `runWithTenant`, so RLS applies | — |
| handler | | |
| `ErrorFilter` | Maps anything thrown to the contract's error envelope | — |

Order is load-bearing. Guards run before interceptors, so tenancy is established *after*
authentication: the church id comes from the verified token, and there is nothing
trustworthy to scope to until the JWT has been checked.

`ModuleGuard` runs after `PolicyGuard` so permission is checked before existence is
revealed — a caller without the permission learns nothing about whether the module is on.

**One stage is still absent and it is not stubbed.** Audit (CORE-021) belongs inside
`TenantInterceptor`, so entries are written in the same tenant context as the work they
describe. A placeholder that logged nothing would be worse than its absence, because it
would look enforced.

## Signing in

| Route | Purpose |
|---|---|
| `POST /auth/login` | Credentials → tokens, or an MFA challenge |
| `POST /auth/mfa` | Challenge + code → tokens |
| `POST /auth/refresh` | Rotate a refresh token; roles are re-read here |
| `POST /auth/logout` | End this device's session |
| `POST /auth/logout-all` | End every session for this user |
| `GET /me` | Who is signed in, and what they may do |

The controller does no security reasoning of its own — password verification, lockout,
rotation, theft detection and TOTP all live in `@church/identity`. What it does own is what
the endpoints decline to say:

- **A disabled account answers exactly like a wrong password.** Distinguishing them turns
  login into an account-existence oracle. The difference is in the log.
- **A replayed refresh token answers like a junk one.** Presenting a spent token revokes
  the whole family; telling the thief it was noticed only tells them to move faster, and
  the real user's devices are already logged out.
- **Logout always answers 204.** A caller logging out should never learn their token was
  already dead.
- **Lockout is 429 with `Retry-After`**, not 401 — it is rate limiting, and every HTTP
  client already knows what to do with that.

Refresh tokens travel in the request body rather than an httpOnly cookie, so web, mobile
and kiosk share one flow. Cookies would be marginally safer against XSS on web alone, at
the cost of CSRF handling and a second code path for the two native clients.

## Roles

An access token carries the roles from `user_role`, read at issue **and at every refresh**.
A granted or revoked role therefore reaches an active session within one access-token
lifetime — 15 minutes — instead of lasting as long as the session.

A campus-scoped role must name its campus, enforced by a CHECK constraint, and a user may
hold at most one. Both exist because the policy engine narrows a `CAMPUS_ADMIN` to their
campus *only when the subject has one*: with no campus it skips the check and the role
reaches the whole church. Making the ambiguous state unreachable is safer than handling it.

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

- **Every route declares `@RequiresPermission()`, `@Public()`, or `@Authenticated()`.** One
  that declares none is refused at request time, not allowed. The usual way an
  authorization system fails is not a wrong rule; it is a route nobody put a rule on.
  `@Authenticated()` is the narrow case of a route needing a signed-in user and nothing
  more — reading your own profile, ending your own session.
- **Inject `TenantDatabase`, never `Pool`.** Going around `TenantDatabase` means going
  around `SET LOCAL app.current_church_id`, and RLS stops applying. The pool is provided
  for migrations and health checks only.
- **A module's controller carries `@RequiresModule('<key>')`.** Put it on the controller so
  it covers every route in it. A module route without one is reachable by every tenant,
  enabled or not.
- **Never read the church id from the request.** It comes from the token. A path parameter
  naming a church is for routing and validation, never for scoping — there is a test
  asserting a query string cannot override it.

## Paths, and the absence of CORS

Every route is served under **`/api/v1`**, set once in `src/api-prefix.ts` and applied by
both `bootstrap()` and the test harness. That value is not a preference: the contract
declares `servers: [{ url: /api/v1 }]`, and in this repo the contract is what code conforms
to rather than the other way round. Changing it means changing the contract in the same
commit.

It was wrong until CORE-018a. The server answered on `/auth/login` while the contract
promised `/api/v1/auth/login`, so any client built from the SDK would have 404'd on every
request — and nothing caught it, because `bootstrap()` is exercised by no test and every
integration test injected a literal unprefixed path. `test/integration/contract-paths.test.ts`
now reads the prefix out of the spec and asserts the server answers there and *only* there.

**There is no CORS configuration here, and that is deliberate.** The admin web app reaches
this API from its own server, not from the browser: tokens live in httpOnly cookies the
browser cannot read, so an XSS in the UI cannot lift a refresh token. Adding
`app.enableCors()` to "make the frontend work" would mean the browser is now calling this
API directly, which is a different security model reached by accident. If a genuine
cross-origin client ever needs to exist, that is a decision with an ADR behind it, not a
one-line fix.

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
MFA_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64 -w0)" \
APP_DB_ROLE=app_runtime \
pnpm --filter @church/api run dev
```

`MFA_ENCRYPTION_KEY` is separate from the signing keys on purpose: signing keys rotate
freely, but rotating this one means re-encrypting every enrolled TOTP secret, so conflating
them would turn routine key rotation into a migration.

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
