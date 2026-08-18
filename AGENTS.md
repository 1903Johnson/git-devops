# AGENTS.md — working agreement for Claude and Codex

This repo is built by two agents in parallel: **Claude** and **Codex**. This file is the
standing contract both follow. Read it before your first edit in any session.

Full detail lives in `docs/`. This is the operational summary.

## 1. What this is

A multi-tenant church management SaaS. Core modules ship to every church; **optional
modules** (Children's Check-in, Giving, Volunteer Scheduling, Pastoral Care, Facilities,
Media Library, Prayer Wall) are enabled per church, gated by subscription plan.

The product stores children's data, payment data, and pastoral counselling records. Three
things follow from that, and they outrank convenience every time: tenant isolation is
enforced in the database, not just in application code; sensitive data is collected only
where a church has deliberately opted in; and every access to restricted data is audited.

## 2. Who owns what

**This table is the single source of truth for ownership zones.** `.github/CODEOWNERS`
encodes it for GitHub's review routing and `docs/03-repo-and-workflow.md` §2 explains the
reasoning behind it — but when they disagree with this table, this table is right and the
other two are stale. Change ownership here first.

| Zone | Owner |
|---|---|
| `packages/contracts`, `packages/tenancy`, `packages/policy`, `packages/module-kit` | Claude |
| `packages/testing` | Claude |
| `apps/api` core: identity, church, audit, billing | Claude |
| `apps/api` core: people, groups, events, attendance | Codex |
| `modules/giving`, `modules/pastoral-care` | Claude |
| `modules/children-checkin` — domain, policy, sync, purge | Claude |
| `modules/children-checkin` — kiosk UI, roster cache, labels | Codex |
| `modules/prayer-wall`, `volunteer-scheduling`, `facilities`, `media-library` | Codex |
| `apps/admin-web`, `apps/member-mobile`, `apps/kiosk`, `packages/ui` | Codex |
| `infra/`, `.github/`, `scripts/`, `docs/adr/` | Claude |

`.github/CODEOWNERS` enforces review routing. The split is by **risk and ambiguity**, not
volume: Claude takes work where a wrong decision is expensive and the spec is incomplete;
Codex takes work where the spec can be frozen up front and the value is throughput.

**Never edit outside your zone.** Need a change there? Open an issue titled
`needs-owner:<claude|codex> — <what>` and continue with the rest of your ticket.

## 3. Boundary rules (CI-enforced, `scripts/check-boundaries.mjs`)

| Rule | Invariant |
|---|---|
| **C1** | Backend core (`apps/api`, `apps/worker`, `packages/*`) must never import from `modules/*` |
| **C2** | A module may import another module only if declared in its manifest `requires[]` |
| **C3** | A module key must not appear outside its own module |
| **C4** | Module tables are prefixed `mod_<key>_` — this is what makes purge mechanical |
| **C5** | Any table carrying `church_id` must `ENABLE ROW LEVEL SECURITY` |

Dependency direction is one-way: modules depend on core, core never depends on modules. If
you find yourself needing a core→module import, the design is wrong — publish an interface
from core or emit an event.

## 4. Contract-first protocol

`packages/contracts` (OpenAPI + generated types) is the handoff artifact between the two
agents. Claude writes contracts; Codex builds against them. Both compile against the same
frozen types, so neither waits on the other.

**Codex never edits `packages/contracts`.** Need a contract change? Open a
`needs-owner:claude` issue describing the shape you need. A contract that changes without
announcement silently breaks the other agent's in-flight branch — that is the single most
likely way this collaboration goes wrong.

## 5. Branches, commits, PRs

```
Branch:   claude/<TICKET>-<slug>   |   codex/<TICKET>-<slug>
Commit:   <TICKET>: imperative summary
PR:       one per ticket, against main, template filled in, under ~400 changed lines
```

`main` is protected: PR + green CI + one approving review. Cross-review is mandatory —
each agent reviews the other's PRs. Anything touching `packages/tenancy`,
`packages/policy`, `modules/children-checkin`, `modules/giving`, or `infra/` needs
Claude's approval regardless of author.

Rebase on `main` before every push.

**Dependencies.** Never introduce a new external dependency *version*. Versions live in the
`catalog:` block of `pnpm-workspace.yaml`; declare `"react": "catalog:"` in your package and
pnpm resolves it to the already-locked version. Need something not in the catalog? Stop and
open a `needs-owner:claude` issue — adding a catalog entry is Claude's call.

The `pnpm-lock.yaml` diff produced by adding your own workspace package (a new importer
entry, no new resolutions) is expected and must be committed. What is forbidden is a
lockfile diff that adds packages or changes versions. Request
dependencies in the sprint issue and they land in one batched PR.

## 6. Verify before you push

```bash
pnpm install
pnpm run verify     # boundaries + doc links + lint + typecheck + unit tests
```

Individually: `pnpm run check:boundaries`, `pnpm run check:docs`, `pnpm run lint`,
`pnpm run format:check`, `pnpm run typecheck`, `pnpm run test:unit`.

A push that turns CI red costs a cycle and the reviewers' trust. Reproduce the failure
before you fix it, and re-read your own diff adversarially before you push.

## 7. Definition of Done for an optional module

- [ ] `module.manifest.ts` complete, including `dataClasses` and `purgePolicy`
- [ ] Zero references to the module key outside `modules/<key>/`
- [ ] Tables prefixed `mod_<key>_`, all RLS-scoped by `church_id`
- [ ] Tenant-isolation test present and passing
- [ ] Enable / disable / purge implemented and tested, including in-flight state
- [ ] Every route behind `@RequiresModule()` + a module-scoped permission
- [ ] Disabled tenant gets `404 MODULE_NOT_ENABLED` (tested)
- [ ] Nav emitted from the manifest; no hardcoded entry in any client
- [ ] Audit categories registered for every restricted-class read/write
- [ ] `README.md` states what data the module collects and how to purge it

## 8. When to stop and ask

State an assumption in the PR body and keep moving for ordinary ambiguity. **Stop and open
a `needs-owner:claude` issue** when the ambiguity touches tenancy, authentication or
authorization, encryption, payments, minors' data, or pastoral records. Guessing in those
areas is how this product hurts someone.

## 9. Where to read more

| Doc | Contents |
|---|---|
| `docs/00-review-and-decisions.md` | Decision log and rationale |
| `docs/01-architecture.md` | Core vs. optional split, request lifecycle, data layer |
| `docs/02-module-system.md` | Module contract, lifecycle, check-in reference spec |
| `docs/03-repo-and-workflow.md` | Repo layout, ownership, CI pipeline |
| `docs/04-delivery-plan.md` | Sprint plan and per-ticket ownership |
| `docs/05-agent-prompts.md` | Ready-to-use ticket prompts |
