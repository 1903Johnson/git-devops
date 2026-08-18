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

**The ownership table lives in [`AGENTS.md`](../AGENTS.md) §2 and only there.** Both agents
read that file at the start of every session, so it is the copy that has to be right. This
section explains *why* the split falls where it does; `.github/CODEOWNERS` encodes the same
map as literal paths because GitHub cannot read a table.

Three copies of one map is two copies too many — it drifted within days of being written,
which is what prompted this consolidation. If you change who owns what, change `AGENTS.md`
§2 and update `CODEOWNERS` to match.

The split is by *risk and ambiguity*, not by volume. Claude takes the work where a wrong
decision is expensive and the spec is incomplete — tenancy, authz, payments, child safety,
purge, infra, CI, and anything that defines a contract others build against. Codex takes
the work where the spec can be made complete up front and the value is in throughput —
CRUD modules, screens, components, test scaffolding. Codex is faster per well-specified
ticket; Claude is better where the ticket has to be designed before it can be written. Play
to that.

Two consequences worth stating explicitly:

- **Security-critical paths need Claude's approval regardless of author.** That covers
  `packages/tenancy`, `packages/policy`, `modules/children-checkin`, `modules/giving`, and
  `infra/`.
- **Codex owning the UI inside a Claude-owned module is deliberate**, not an exception to
  patch. Kiosk screens for children's check-in are throughput work; the custody logic
  behind them is not. The boundary runs between them, not around the module.

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
| Lockfile churn | Dependency **versions** live in the `catalog:` block of `pnpm-workspace.yaml`, which only Claude edits; packages reference them as `"react": "catalog:"`. A lockfile diff that only adds an importer for your own new package is expected and should be committed; a diff that adds packages or changes versions is not. Codex requests new dependencies in the sprint issue and they land in one batched PR. |
| Central registration files | There are none by design — the module registry discovers manifests by convention. If a file starts accumulating one line per feature, that is a bug in the architecture, not a merge problem to manage. |
| Generated code | `packages/sdk` is generated, never hand-edited, and regenerated in CI. Conflicts there are resolved by regenerating, never by hand-merging. |
| Shared test fixtures | `packages/testing` is Claude-owned; Codex adds module-local fixtures inside its own module. |
| Same-ticket collisions | One ticket has exactly one owner. Split tickets rather than sharing them. |

## 6. CI pipeline (blocking on every PR)

Implemented in `.github/workflows/ci.yml`.

```
detect      → which parts of the stack exist yet (gates the jobs below)
boundaries  → node scripts/check-boundaries.mjs      ← runs from day one
docs        → node scripts/check-doc-links.mjs       ← runs from day one
hygiene     → no committed .env / key material       ← runs from day one
quality     → lint · typecheck · unit tests                    (from Sprint 0)
integration → containerised Postgres 16 + Redis, real RLS      (from Sprint 1)
              ├─ tenant-isolation suite     ← mandatory, cannot be skipped
              └─ module-lifecycle suite     (enable / disable / purge, every module)
security    → dependency audit                                 (from Sprint 0)
ci          → aggregating gate; the single required status check for branch protection
```

`quality`, `integration`, and `security` are gated on the presence of `package.json` and
report *skipped* until Sprint 0 lands the workspace — a gated job is honest, a job whose
steps silently no-op is a false green.

The boundary check enforces five rules, each mapping to an invariant in
`docs/01-architecture.md` §2 and `docs/02-module-system.md` §6:

| Rule | Invariant |
|---|---|
| **C1** | Backend core must not import from `modules/*` (`packages/sdk`, `packages/contracts` exempt as generated) |
| **C2** | Cross-module imports must be declared in the importing module's manifest `requires[]` |
| **C3** | A module key must not appear outside its own module (narrow, documented exemptions only) |
| **C4** | Module tables must be prefixed `mod_<key>_`, so purge stays mechanical |
| **C5** | Any table carrying `church_id` must `ENABLE ROW LEVEL SECURITY` |

Client shells (`admin-web`, `member-mobile`, `kiosk`) are deliberately outside C1/C3: they
lazy-load module UI, so a compile-time reference is expected. Their invariant — navigation
rendered from `GET /me/modules`, never hardcoded — is a review-checklist item, because grep
cannot prove it.

Two jobs are load-bearing above all others: the **boundary check** is what keeps the module
system real over time, and the **tenant-isolation suite** is what keeps the worst-case
incident from happening. Neither may be marked `continue-on-error`.

**Repo setting, not a file:** `main` should require the `ci` status check plus one approving
review. Configure it in branch protection once this pipeline has run green.

## 7. Cadence

- **Sprint = 1 week.** Sprint issue in GitHub lists tickets with owners; sprint opens with
  the contract PR and the dependency batch, both from Claude.
- **Daily:** each agent rebases, pushes at least one PR, and reviews the other's open PRs
  before starting new work. Review debt is the thing that stalls a two-agent repo.
- **End of sprint:** demo on staging, ADR for any decision made mid-sprint, retro note in
  `docs/retros/`.
