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

## INF-007 — Design system bootstrap

*Sprint 0 · Codex · depends on INF-001 (merged) · no file overlap with INF-004, so both can run at once*

```text
TICKET: INF-007 — Design system bootstrap (packages/ui)

Goal
A shared component package that admin-web and member-mobile both consume, so the two
clients cannot drift apart visually. Bootstrap only — breadth of components comes later.

Files you own
  packages/ui/**        (new workspace package: @church/ui)

Scope
- Design tokens first: colour, spacing, typography, radius, elevation as typed exports.
  Components consume tokens; they never hardcode values.
- A small primitive set proving the token layer works: Button, Input, Select, Card, Badge,
  Spinner, EmptyState. No church-domain components (no MemberCard, no GivingSummary) —
  those belong to feature tickets.
- Storybook with a story per primitive, covering the accessibility-relevant states:
  disabled, error, loading, focus-visible.
- Unit tests for anything with behaviour (Button loading/disabled, Input error state).
- Must build standalone: `pnpm --filter @church/ui build`, with a typed entry point.
- Add `lint`, `typecheck`, `test:unit`, and `build` scripts to the package so the root
  `pnpm run verify` picks them up.

Constraints
- packages/ui is a leaf: no dependency on any app, module, or backend package.
- Every interactive primitive is keyboard-navigable with a visible focus state. This ships
  to church volunteers on shared kiosks, not to power users.

Definition of done
- Storybook runs; every primitive has a story; `pnpm run verify` passes from the repo root.
```

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
