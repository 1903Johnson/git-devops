# `apps/admin-web`

The pastor/admin web app. Next.js App Router, and the first client of the platform API.

## The browser never holds a token

This is the single decision the rest of the app is shaped around.

The browser posts to **this app's own routes** under `app/api/auth/`, which call the
platform API server-side and put the returned tokens into httpOnly cookies. Nothing in
`document.cookie` and nothing in `localStorage` is a credential, so a script injected into
any page here cannot lift the refresh token — and therefore cannot turn a momentary XSS
into a session that outlives it. For a system holding children's attendance and pastoral
records, that is worth the extra layer.

Two consequences worth stating, because both look like omissions otherwise:

- **The API has no CORS configuration and must not gain one.** The browser never calls it.
  Adding `enableCors()` to "make the frontend work" would move the system to a different
  model in which the browser does hold tokens. See `apps/api/README.md`.
- **`lib/api.ts` and `lib/session.ts` are server-only.** Importing either from a client
  component would mean the token has to reach the browser to be useful, which is the thing
  the design exists to prevent.

## Signing in has three endings, not two

`POST /auth/login` returns one of:

| Outcome | What the app does |
|---|---|
| `success` | Store the pair, go to `/` |
| `mfa_required` | Store the challenge, go to `/login/mfa` |
| `mfa_enrollment_required` | Store the ticket, go to `/login/enrol` |

The third is not an edge case. After REV-004 a `STAFF`, `PASTOR`, `CAMPUS_ADMIN` or
`CHURCH_ADMIN` account that has never enrolled **cannot obtain a session by any other
path**, so an app handling only the first two would be unusable by exactly the people it is
built for.

The branch is chosen by the route handler and obeyed by the form. The client is never told
which credential it holds, and never has to inspect one to work out what happened.

## Recovery codes

`/login/enrol` ends by displaying them, and the Continue button stays disabled until the
user ticks an acknowledgement. They are generated once and cannot be retrieved afterwards;
a screen that lets someone click past them does not fail here, it fails weeks later as a
locked-out administrator nobody can help. The acknowledgement is a tested property, not a
courtesy.

## Refreshing

`callAuthed()` retries a 401 exactly once, after refreshing. Deliberately once: REV-001
made a second concurrent presentation of a refresh token revoke the whole family —
correctly, since that is what a stolen token looks like — so a retry loop here would log
the user out of every device they own while looking like resilience.

## Running it

The UI packages resolve through `dist`, so they are built first. `pnpm run verify` does
this via `build:libs`; locally, do it once by hand:

```bash
pnpm run build:libs
API_BASE_URL=http://localhost:3001/api/v1 pnpm --filter @church/admin-web dev
```

The base URL includes `/api/v1` because the API serves only under it (CORE-018a); without
the prefix every call 404s.

## Imports have no `.js` extension here

The rest of the monorepo is NodeNext ESM, where relative imports must carry `.js`. This app
uses `moduleResolution: bundler`, where they must not — Next's bundler will not rewrite
`./login-form.js` to `./login-form.tsx`, and the build fails with a module-not-found that
points at the import rather than at the convention.

## Tests

`pnpm --filter @church/admin-web test:unit` — the three login branches, the failure and
offline paths, and the enrolment flow including the recovery-code gate.
