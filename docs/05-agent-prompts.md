# 05 — Agent Prompt Library

**Codex's current brief is [docs/tasks/SEC-REVIEW.md](tasks/SEC-REVIEW.md), and it is the
only one.** The plan changed: Claude builds every ticket, Codex reviews what lands and
reports defects (`AGENTS.md` §2). Hand Codex that file; ignore the rest of this library.

The build prompts below (INF-004, DEP-001, INF-007a/b, CORE-016, CORE-017) are kept as a
record of how tickets were specified, and because the shape is worth reusing if the split
ever changes back. INF-004, DEP-001 and INF-007a/b shipped. CORE-016 and CORE-017 were
never handed over and are Claude's now.

`AGENTS.md` at the repo root carries the durable rules, so prompts stay short — they point
at that file rather than repeating it. Keep it that way: rules that live in two places
drift.

---

## Standing header — prepend to every ticket

```text
Repo: 1903Johnson/git-devops — Church Management Platform (multi-tenant SaaS).
You are CODEX, one of two agents building this repo. Claude is the other.

Read AGENTS.md first. It defines ownership zones, the module boundary rules (C1–C5), the
contract-first protocol, and the Definition of Done. Then read any docs/ file it points to
that is relevant to your ticket.

Non-negotiable:
- Work ONLY inside "Files you own" below. Need a change outside it? Do not make it —
  open a GitHub issue titled "needs-owner:claude — <what>" and finish the rest of the ticket.
- Never edit: packages/contracts/**, packages/tenancy/**, packages/policy/**,
  packages/module-kit/**, infra/**, .github/**, scripts/**, docs/adr/**, and the
  `catalog:` block of pnpm-workspace.yaml.
- Dependencies: reference catalog versions ("react": "catalog:"). Never add a dependency
  that is not already in the catalog — open a needs-owner:claude issue instead. Committing
  the lockfile diff caused by adding your OWN workspace package is expected and correct.
- Core (apps/api, apps/worker, packages/*) must never import from modules/*.
- Branch codex/<TICKET>-<slug>; commit "<TICKET>: <imperative summary>"; ONE pull request
  against main with .github/pull_request_template.md filled in; under ~400 changed lines.
  If the ticket is bigger than that, split it and say so in the PR.

Before opening the PR, run this and paste the output into the PR body:
  pnpm install && pnpm run verify

Ambiguity: state your assumption in the PR body and proceed — do not stall. But if the
ambiguity touches tenancy, auth, encryption, payments, or children's data, STOP and open a
needs-owner:claude issue instead of guessing.
```

---

## INF-004 — Local development environment

*Sprint 0 · **completed by Claude**, not Codex*

Reassigned in practice: the ticket's definition of done is `docker compose up -d` reaching
healthy, and the Codex sandbox has no Docker daemon. An agent that cannot run the thing it
is building can only write a plausible-looking compose file, which is the shape of work
most likely to be wrong in ways review does not catch.

Delivered as `docker-compose.yml`, `.env.example`, `infra/local/init-databases.sh`, and
[`docs/local-development.md`](local-development.md).

## DEP-001 — Dependency window for the UI stack (Claude, prerequisite)

*Sprint 0 · Claude · blocks INF-007b*

Codex cannot add dependencies — `pnpm-lock.yaml` is Claude-owned (docs/03 §5), so the
dependency batch lands first, in one PR: `react`, `react-dom`, their types, the Storybook
React renderer, and the component test stack. Until it merges, Codex can only build
zero-dependency packages.

This constraint is why the first INF-007 attempt produced custom elements: with no React in
the workspace and no way to add it, zero-dependency custom elements were the only thing
buildable. The rule worked — it batched the request instead of letting the lockfile churn —
but the ticket had to be sequenced around it, and was not. Hence the split below.

---

## INF-007a — Design tokens (`@church/ui-tokens`)

*Sprint 0 · Codex · depends on INF-001 (merged) · **startable now**, needs no dependencies*

```text
TICKET: INF-007a — Design tokens (@church/ui-tokens)

Goal
One set of design values consumed by every client on every platform. Tokens are the ONLY
layer that can be genuinely shared between the Next.js admin app and the React Native
member app — see "Why two packages" below. Get this layer right and the clients cannot
drift apart visually, whatever renders them.

Files you own
  packages/ui-tokens/**      (new workspace package: @church/ui-tokens)

Scope
- Typed exports for: colour, spacing, typography, radius, elevation, motion durations.
- Colour must carry semantic names (surface, surfaceMuted, textPrimary, textMuted, border,
  danger, warning, success, accent), not raw palette names, and must define light and dark
  values for each. Church volunteers use these on kiosks in dim rooms; dark mode is not a
  nice-to-have here.
- A web adapter that emits the tokens as CSS custom properties, and a plain object export
  that React Native can consume directly.
- ZERO runtime dependencies. No React, no DOM, no browser globals at module scope — this
  package must import cleanly inside a React Native bundle. This is a hard constraint, not
  a preference: touching `document` or `window` anywhere in it breaks the mobile client.
- Scripts: build, lint, typecheck, test:unit. Unit-test the CSS emitter and the light/dark
  pairing (every semantic colour defined in both themes).

Definition of done
- `pnpm --filter @church/ui-tokens build` produces a typed entry point.
- `pnpm run verify` passes from the repo root.
- `grep -r "document\.\|window\." packages/ui-tokens/src` returns nothing.
```

---

## INF-007b — Web component library (`@church/ui`)

*Sprint 0 · Codex · INF-007a and DEP-001 are both merged, so this is ready to start*

```text
TICKET: INF-007b — Web component library (@church/ui)

Goal
React components for the admin web app, built on @church/ui-tokens. Bootstrap only —
breadth of components comes with the feature tickets that need them.

Files you own
  packages/ui/**             (new workspace package: @church/ui)

Scope
- REACT function components. Not custom elements, not web components: they must compose
  with Next.js SSR, accept typed props, forward refs, and take standard React event
  handlers. A previous attempt at this ticket used custom elements; that is the one
  approach explicitly ruled out.
- Primitives: Button, Input, Select, Card, Badge, Spinner, EmptyState. No church-domain
  components (no MemberCard, no GivingSummary) — those belong to feature tickets.
- Storybook (React renderer) with a story per primitive covering the accessibility-relevant
  states: disabled, error, loading, focus-visible. The preview must inject `themeCss` from
  @church/ui-tokens and offer a light/dark switch, so stories exercise both themes.
- Unit tests with vitest + @testing-library/react in a jsdom environment, for anything with
  behaviour: Button loading/disabled, Input error state and its aria wiring, Select
  keyboard navigation.
- Scripts: build, lint, typecheck, test:unit.

How to consume tokens — read this twice
- Style with the CSS custom properties, e.g. `color: var(--church-color-text-primary)` and
  `padding: var(--church-spacing-md)`. @church/ui-tokens emits them via createCssVariables
  / themeCss, keyed by semantic name.
- Do NOT import `colors.light` (or any theme object) into a component. Those are for React
  Native. Baking one theme's values into web components makes the [data-theme="dark"]
  switch a no-op, and nothing in CI would catch it.
- A hardcoded colour, spacing, radius or duration anywhere in this package is a bug. If a
  value you need has no token, stop and open a needs-owner:claude issue — do not invent one
  locally.

Dependencies — this is NOT a zero-dependency package
- Declare what you import in packages/ui/package.json using catalog references:
  "react": "catalog:", "react-dom": "catalog:", and for dev "vitest": "catalog:",
  "jsdom": "catalog:", "@testing-library/react": "catalog:",
  "@testing-library/user-event": "catalog:", "@testing-library/jest-dom": "catalog:",
  "@vitejs/plugin-react": "catalog:", "storybook": "catalog:",
  "@storybook/react-vite": "catalog:", "typescript": "catalog:", "@types/react": "catalog:".
  Referencing a catalog entry is always allowed; it introduces no new resolution.
- What is forbidden is a dependency whose version is NOT already in the catalog. If you
  need one, stop and open a needs-owner:claude issue.
- Run `pnpm install` and COMMIT the resulting pnpm-lock.yaml diff. Adding a workspace
  package writes an importer entry, and that diff is yours to commit — see AGENTS.md.
  Note that `--frozen-lockfile` does not fail without it, so CI will not remind you.

Constraints
- Depends on @church/ui-tokens ONLY, plus the React/test toolchain above. No app, module,
  or backend package — packages/ui is a leaf and the boundary check enforces it.
- Set "type": "module" in package.json. Vite 8 warns when an ESM config file is loaded as
  CommonJS.
- Every interactive primitive is keyboard-navigable with a visible focus state, and every
  interactive target is at least 44x44px. This ships to volunteers on shared touch kiosks,
  not to power users on laptops.
- Write files as UTF-8 with no byte-order mark. Prettier tolerates a BOM, so CI stays green
  while the files carry invisible junk.

Definition of done
- Storybook runs; every primitive has a story in both themes.
- `pnpm run verify` and `pnpm run format:check` pass from the repo root.
- `grep -rE "#[0-9a-fA-F]{3,6}|[0-9]+px" packages/ui/src` finds nothing outside a comment —
  every visual value comes from a token.
```

### Why two packages

React Native cannot render DOM. Any component built for the browser — React DOM or custom
elements alike — is unusable in `member-mobile`, so "one component library for both
clients" is not achievable and pretending otherwise just defers the discovery. What IS
shareable is the token layer, which is plain data.

So: **tokens are shared, components are per-platform.** `@church/ui-tokens` serves
everything; `@church/ui` serves the web; `@church/ui-native` follows when `member-mobile`
starts, against the same tokens. The design system lives in the tokens, not in the
components.

---

## CORE-016 — Church and campus services (`@church/church`)

*Sprint 1 · Codex · **ready to start** — contract, schema, tenancy, and policy all exist*

```text
TICKET: CORE-016 — Church and campus services (@church/church)

Goal
The service layer behind the church and campus contract. Every later feature reaches
churches and campuses through this package rather than writing its own SQL.

Files you own
  packages/church/**          (new workspace package: @church/church)

Read first
- packages/contracts/openapi/openapi.yaml — the shapes are already fixed. Import the
  generated types from @church/contracts; do not redeclare Church, Campus, or the page
  envelope.
- packages/tenancy/README.md — how tenant context and the repository base work.
- packages/policy/README.md — how authorization decisions are made.
- packages/identity/src/service.ts — a worked example of this exact shape.

Scope
- ChurchService: get, update. CampusService: list (cursor paginated), get, create, update,
  delete.
- Extend TenantRepository from @church/tenancy for persistence. Do NOT write church_id
  into a query by hand — the base class injects it, and a hand-written predicate is how
  that guarantee quietly stops being true.
- Every operation runs inside db.transaction() under runWithTenant. Never take a Pool and
  query it directly.
- Authorize with assertCan from @church/policy before acting: church:read / church:manage
  for churches, campus:read / campus:manage for campuses. The caller supplies the Subject;
  the service does not build one.
- Cursor pagination on listCampuses, matching PageInfo in the contract. The cursor is
  opaque to callers — encode it, do not hand back a raw id.
- Map to the contract's camelCase shapes at the service boundary. The database is
  snake_case; nothing outside this package should have to know that.

Tests (all three categories are required)
- test:unit — cursor encode/decode, and the row-to-contract mapping.
- test:integration — each operation against a real PostgreSQL, using @church/testing.
- test:isolation — assertTenantIsolation for every table you touch, plus a test that
  Church A cannot read or modify Church B's campus by guessing its id.

Definition of done
- `pnpm run verify` clean from the repo root (it runs format:check as of #18).
- The isolation suite passes: `pnpm --filter @church/church run test:isolation`.
- `grep -rn "church_id" packages/church/src` shows no hand-written predicates in queries —
  only the repository base and explicit mapping.

Out of scope
- HTTP routes and controllers. There is no apps/api yet; the ticket that adds it will wire
  these services to the contract. Build the services so that wiring is trivial.
```

---

## CORE-017 — People and families (`@church/people`)

*Sprint 1 · Codex · **ready to start** — CORE-017a landed the contract and migration*

```text
TICKET: CORE-017 — People and families (@church/people)

Goal
The service layer for the platform's central record. A Person is the single source of
truth; a User exists only when that person needs to log in (docs/01 §2.4.1).

Files you own
  packages/people/**          (new workspace package: @church/people)

Read first
- packages/contracts/openapi/openapi.yaml — the people and family shapes are fixed. Import
  Person, PersonCreate, PersonUpdate, Family, FamilyMember, Milestone and the rest from
  @church/contracts; do not redeclare them.
- packages/migrations/sql/0005_people.sql — the tables you are mapping, and the reasoning
  behind the ones that look odd.
- packages/migrations/README.md — the four-part RLS recipe and the composite foreign-key
  rule, if you add any table of your own.
- packages/identity/src/service.ts — a worked example of this exact shape. If CORE-016
  has landed, packages/church/** is the closer model; if it has not, do not wait for it —
  the two tickets share no files.

Scope
- PersonService: list (cursor paginated, archived excluded by default), get, create,
  update, archive.
- FamilyService: list, get (with members), create, update, add member, remove member.
- Membership lifecycle: changeStatus writes membership_status_history AND updates
  person.status in ONE transaction. The history is append-only — never update or delete a
  row in it. Churches track how someone became a member, not merely that they are one.
- Milestones: list and record. Type comes from the contract's enum, which matches the
  database CHECK constraint; a value in one and not the other is a 500 at runtime.
- Same rules as CORE-016: TenantRepository, runWithTenant, assertCan, contract types from
  @church/contracts, camelCase at the boundary.

Particular care
- Archive is not delete. `DELETE /people/{personId}` sets archived_at. Giving and
  attendance history reference people, and a hard delete silently rewrites the past.
- Children are Person records with no User (docs/01 §2.4.1). Nothing in this package may
  assume a person has an account.
- person:read_self must let a member read their own record and no one else's. There is a
  policy rule for this; use assertCan rather than an if-statement.
- A family relationship is NOT an authorisation. 'parent' on family_member does not mean
  that person may collect a child — that is a separate GuardianAuthorisation owned by the
  check-in module (docs/02 §5). Do not add a helper that conflates them, however
  convenient; a custody order routinely leaves a parent on one list and off the other.
- person.email is deliberately not unique. Do not add a uniqueness check in the service
  either — a child's contact address is usually a parent's.
- Do not accept churchId in a create or update body. It comes from the tenant context;
  PersonCreate and FamilyCreate omit it on purpose.
- Do not accept status in updatePerson. It moves only through changeStatus, so that every
  change lands in the history with the user who made it.

Tests (all three categories are required)
- test:unit — cursor encode/decode, row-to-contract mapping, and that updatePerson rejects
  a status field if one is passed.
- test:integration — each operation against a real PostgreSQL, using @church/testing.
  Include: changing status writes both the history row and person.status; archiving hides
  the person from list but keeps them fetchable by id.
- test:isolation — assertTenantIsolation for every table you touch. The composite foreign
  keys already stop cross-tenant references at the database; do not remove or work around
  them, and if a write fails with SQLSTATE 23503 the fix is the churchId you passed, not
  the constraint.

Definition of done
- `pnpm run verify` clean from the repo root (it runs format:check as of #18).
- The isolation suite passes: `pnpm --filter @church/people run test:isolation`.
- Register every new test file in the package's test:isolation / test:integration scripts.
  They name files explicitly, so an unregistered suite never runs in CI and the green tick
  means nothing.
- `grep -rn "church_id" packages/people/src` shows no hand-written predicates in queries.

Out of scope
- HTTP routes and controllers. There is no apps/api yet; the ticket that adds it will wire
  these services to the contract. Build the services so that wiring is trivial.
```

---

## SEC-REVIEW — standing brief for Codex

*Ongoing · Codex · **this is now Codex's only job***

Codex builds nothing. It reads what has been merged, attacks it, and reports what it finds.
Claude fixes what is real.

**The brief lives in [docs/tasks/SEC-REVIEW.md](tasks/SEC-REVIEW.md), and that file is the
one to hand over.** It is not reproduced here: this prompt library once carried the same
ownership table as two other files and the three of them drifted apart in two days, which
is a mistake worth making only once. The task file also carries what a prompt block cannot
— the repository coordinates, the check that the checkout is not stale, and how to run the
suites — because a reviewer given only the prose has to guess at all three.

### Handing back a report

Claude triages every finding, fixes what is real as a `REV-nnn` ticket with a regression
test that fails against the reported commit, and replies in writing to anything dismissed
with the reason the described sequence cannot happen. Disagreement alone does not close a
finding.

---

## Writing new ticket prompts

A ticket prompt that works has five parts. Miss one and the agent either stalls or
overreaches:

1. **Goal** — one paragraph on why the ticket exists, not just what to build. An agent
   that knows the intent makes better calls at the edges.
2. **Files you own** — an explicit list. This is the conflict-avoidance mechanism; without
   it, two agents edit the same file and one loses work.
3. **Scope** — what to build, including the decisions already made (versions, names,
   patterns to follow). Every decision left implicit is a decision the agent will make
   differently from you.
4. **Constraints** — the invariants that would be expensive to discover in review.
5. **Definition of done** — the observable end state, phrased so it can be checked.

Route the ticket to **Claude** if it touches tenancy, authN/authZ, encryption, secrets,
audit, money, minors' data, or pastoral confidentiality; if it defines a contract,
migration, or interface others depend on; if the requirement is ambiguous and needs a
design decision before code; or if it is infrastructure, CI, release, or DR.

Route to **Codex** if the contract already exists and is frozen; it is UI against a defined
API; it is a self-contained CRUD module with clear rules; it is test scaffolding, fixtures,
or documentation of existing behaviour; or it is repetitive, high-volume work.
