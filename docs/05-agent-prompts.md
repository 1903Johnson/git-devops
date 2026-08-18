# 05 — Agent Prompt Library

Ready-to-use prompts for handing tickets to Codex. Copy the **standing header**, then the
ticket block beneath it, into a Codex session.

`AGENTS.md` at the repo root carries the durable rules, so the header stays short — it
points at that file rather than repeating it. Keep it that way: rules that live in two
places drift.

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
  packages/module-kit/**, infra/**, .github/**, scripts/**, docs/adr/**, pnpm-lock.yaml.
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

*Sprint 0 · Codex · depends on INF-001 (merged) · blocks nothing*

```text
TICKET: INF-004 — Local development environment

Goal
One command brings up every backing service the platform needs locally, on the same
versions CI uses, so both agents and any human developer get identical behaviour.

Files you own (create these; touch nothing else)
  docker-compose.yml
  .env.example
  docs/local-development.md

Scope
- PostgreSQL and Redis — read .github/workflows/ci.yml and match the versions it pins.
  Do not pick your own; drift between local and CI is the bug this ticket prevents.
- MinIO (S3-compatible object storage) and Mailpit (SMTP capture), local-only.
- Named volumes for persistence, a healthcheck on every service, and a compose project
  name so the stack does not collide with other work on the same machine.
- .env.example: every variable with a safe local default and a one-line comment. Real
  secrets never go in it. DATABASE_URL and REDIS_URL must match the env var names the CI
  integration job already sets.
- docs/local-development.md: prerequisites, bring-up, teardown, resetting the database,
  and short troubleshooting (port conflicts, stale volumes).

Definition of done
- `docker compose up -d` from a clean clone reaches healthy on every service.
- `docker compose down -v` leaves nothing behind.
- No application code, no migrations, no CI changes.
```

---

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

*Sprint 0 · Codex · depends on INF-007a **and** DEP-001 — do not start before both merge*

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
- Every visual value comes from @church/ui-tokens. A hardcoded colour or spacing value in
  this package is a bug; the whole point of INF-007a is that this layer has no opinions of
  its own about them.
- Storybook (React renderer) with a story per primitive covering the accessibility-relevant
  states: disabled, error, loading, focus-visible.
- Unit tests for anything with behaviour: Button loading/disabled, Input error state and
  its aria wiring, Select keyboard navigation.
- Scripts: build, lint, typecheck, test:unit.

Constraints
- Depends on @church/ui-tokens ONLY. No app, module, or backend package — packages/ui is a
  leaf, and the boundary check enforces it.
- Every interactive primitive is keyboard-navigable with a visible focus state, and every
  interactive target is at least 44x44px. This ships to volunteers on shared touch kiosks,
  not to power users on laptops.
- Do NOT add dependencies. DEP-001 has already put React, Storybook, and the test stack in
  the lockfile. If you need something beyond that, stop and open a needs-owner:claude issue.

Definition of done
- Storybook runs; every primitive has a story; `pnpm run verify` passes from the repo root.
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
