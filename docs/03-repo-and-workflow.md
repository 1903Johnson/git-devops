# 03 — Repo Layout & the Two-Agent Workflow

How Claude and Codex build this repo at the same time without stepping on each other.

---

## 1. Monorepo layout

```
/
├── apps/
│   ├── api/                  # NestJS modular monolith (core only)
│   ├── worker/               # queue consumers, scheduled jobs
│   ├── admin-web/            # Next.js pastor/admin app
│   ├── member-mobile/        # React Native member app
│   └── kiosk/                # RN check-in kiosk (ships with children_checkin)
├── modules/                  # optional modules, one dir each
│   ├── prayer-wall/
│   ├── giving/
│   ├── volunteer-scheduling/
│   ├── children-checkin/
│   ├── pastoral-care/
│   ├── facilities/
│   └── media-library/
├── packages/
│   ├── contracts/            # OpenAPI + generated TS types  ← THE HANDOFF ARTIFACT
│   ├── sdk/                  # generated typed client (web + mobile)
│   ├── module-kit/           # ModuleManifest, RequiresModule, registry interfaces
│   ├── tenancy/              # TenantContext, RLS session mgmt, base repository
│   ├── policy/               # RBAC + resource-level policy engine
│   ├── ui/                   # shared design-system components
│   └── testing/              # isolation-test harness, fixtures, factories
├── infra/                    # Terraform, Docker, environment config
├── docs/                     # this folder — ADRs, plans, module specs
└── .github/                  # workflows, CODEOWNERS, templates
```

Directory boundaries are the collaboration mechanism. Two agents editing two directories
never conflict; two agents editing one file always do.

## 2. Ownership model

| Zone | Primary owner | Notes |
|---|---|---|
| `packages/contracts` | **Claude** | Codex may propose changes via issue, not direct edit |
| `packages/tenancy`, `packages/policy`, `packages/module-kit` | **Claude** | Security-critical foundation |
| `apps/api` core modules — identity, church, audit, billing | **Claude** | |
| `apps/api` core modules — people, groups, events, attendance | **Codex** | Against frozen contracts |
| `modules/giving`, `modules/pastoral-care` | **Claude** | Money + confidential records |
| `modules/children-checkin` — domain, policy, sync, purge | **Claude** | Safety-critical core |
| `modules/children-checkin` — kiosk UI, roster cache, labels | **Codex** | Behind Claude's interfaces |
| `modules/prayer-wall`, `volunteer-scheduling`, `facilities`, `media-library` | **Codex** | |
| `apps/admin-web`, `apps/member-mobile` | **Codex** | Claude owns auth/session/crypto paths |
| `packages/ui` | **Codex** | |
| `infra/`, `.github/workflows` | **Claude** | |
| `docs/` | **Claude** writes ADRs; **Codex** writes module READMEs | |

The split is by *risk and ambiguity*, not by volume. Claude takes the work where a wrong
decision is expensive and the spec is incomplete — tenancy, authz, payments, child safety,
purge, infra. Codex takes the work where the spec can be made complete up front and the
value is in throughput — CRUD modules, screens, components, test scaffolding. Codex is
faster per well-specified ticket; Claude is better where the ticket has to be designed
before it can be written. Play to that.

`.github/CODEOWNERS` encodes this so GitHub enforces review routing automatically.

## 3. Contract-first protocol

This is the part that makes parallelism work. For every feature that spans the two agents:

```
1. Claude writes the contract         → packages/contracts (OpenAPI + types)
                                        + migration for shared tables
                                        + failing integration test skeletons
2. Contract PR merges to main         → this is the sync point
3. Both agents work simultaneously:
     Claude  → server implementation of the risky half
     Codex   → client implementation + the well-specified server half
   Both compile against the same frozen types. Neither waits for the other.
4. Integration PR                     → wired together, tests go green
```

**Contract changes mid-sprint:** allowed, but only via a contract PR from Claude, and the
change must be announced in the sprint issue before either side writes code against it.
A contract that changes without announcement silently breaks the other agent's in-flight
branch — that is the single most likely way this collaboration goes wrong.

## 4. Branch, commit, PR conventions

```
Branch:   claude/<ticket-id>-<slug>      codex/<ticket-id>-<slug>
Example:  claude/CORE-014-rls-base-repo  codex/MOD-031-prayer-wall-api
Commit:   <ticket-id>: imperative summary
PR title: [CORE-014] RLS-enforcing base repository
```

Rules:
- **Small PRs.** Target < 400 changed lines. A large PR from one agent blocks the other's
  rebase for longer than the review saves.
- **Rebase on `main` before every push.** Both agents pull at the start of each work
  session. `main` is protected: PR + green CI + one approving review.
- **Cross-review is mandatory.** Codex reviews Claude's PRs; Claude reviews Codex's. Any PR
  touching `packages/tenancy`, `packages/policy`, `modules/children-checkin`,
  `modules/giving`, or `infra/` requires Claude's approval regardless of author.
- **Never edit a file outside your ownership zone.** Need a change there? Open an issue
  tagged `needs-owner:claude` / `needs-owner:codex` and keep moving on something else.

## 5. Conflict-avoidance rules that actually matter

| Hazard | Rule |
|---|---|
| Migration filename collisions | Migrations are timestamp-prefixed and live in the owning package/module. Two agents never write into the same migrations dir in the same sprint. |
| Lockfile churn | Only Claude updates the root lockfile. Codex requests dependencies in the sprint issue; they land in one batched PR at sprint start. |
| Central registration files | There are none by design — the module registry discovers manifests by convention. If a file starts accumulating one line per feature, that is a bug in the architecture, not a merge problem to manage. |
| Generated code | `packages/sdk` is generated, never hand-edited, and regenerated in CI. Conflicts there are resolved by regenerating, never by hand-merging. |
| Shared test fixtures | `packages/testing` is Claude-owned; Codex adds module-local fixtures inside its own module. |
| Same-ticket collisions | One ticket has exactly one owner. Split tickets rather than sharing them. |

## 6. CI pipeline (blocking on every PR)

```
lint · typecheck
  → boundary check     (core must not import modules/*; modules must not import each other
                        outside declared requires[])
  → unit tests
  → integration tests  (containerised Postgres, real RLS)
  → tenant-isolation suite      ← mandatory category, cannot be skipped
  → module-lifecycle suite      (enable / disable / purge for every module)
  → dependency + secret scan
  → build
  → deploy to staging (main only) → smoke tests → manual promote to prod
```

Two of these are unusual and both are load-bearing: the **boundary check** is what keeps
the module system real over time, and the **tenant-isolation suite** is what keeps the
worst-case incident from happening. Neither may be marked `continue-on-error`.

## 7. Cadence

- **Sprint = 1 week.** Sprint issue in GitHub lists tickets with owners; sprint opens with
  the contract PR and the dependency batch, both from Claude.
- **Daily:** each agent rebases, pushes at least one PR, and reviews the other's open PRs
  before starting new work. Review debt is the thing that stalls a two-agent repo.
- **End of sprint:** demo on staging, ADR for any decision made mid-sprint, retro note in
  `docs/retros/`.
