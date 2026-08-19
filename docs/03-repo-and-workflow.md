# 03 — Repo Layout & the Two-Agent Workflow

How Claude and Codex build this repo at the same time without stepping on each other.

---

## 1. Monorepo layout

```
/
├── apps/
│   ├── api/                  # NestJS modular monolith (core only) — lifecycle in its README
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

Directory boundaries mattered when two agents wrote code at once. With one build queue they
are no longer a coordination mechanism, but they remain how the module system stays honest —
see §5 and the boundary checks in CI.

## 2. Division of labour

**The table lives in [`AGENTS.md`](../AGENTS.md) §2 and only there.** Both agents read that
file at the start of every session, so it is the copy that has to be right. This section
explains *why* it says what it does.

**Claude builds everything. Codex reviews what lands and reports defects.**

The original arrangement split the work by directory — Claude took the risky half, Codex
took throughput — and it did not survive contact with reality. Codex shipped two tickets and
then spent longer blocked than building: first by a dependency rule only Claude could lift,
then by a sandbox whose proxy could not reach GitHub, which left it fourteen merges behind
its own work. The coordination overhead of contract handoffs, ownership zones and merge
sequencing was being paid in full while the parallelism it bought was mostly theoretical.

Meanwhile, every genuine defect found in this repository was found by Claude testing its own
work. That sounds like a success and is actually the risk: an author's tests encode the
author's assumptions, so the bug that survives is always the one nobody thought to write a
test for. Several were caught here only because a sabotage check was run deliberately —
removing a safety clause to see whether anything went red. That habit is good and it is not
a substitute for someone who wants the code to be wrong.

So the second agent is pointed at disagreement instead of throughput. Codex has no deadline,
no directory to defend, and no reason to conclude the code is fine. The trade is explicit: a
slower build queue in exchange for an adversary. See `docs/04` §"The review loop" for how a
finding becomes a fix, and `docs/05` for Codex's standing brief.

What did not change: security-critical paths — `packages/tenancy`, `packages/policy`,
`packages/audit`, `modules/children-checkin`, `modules/giving`, `infra/` — still get the
heaviest scrutiny, and are now first in Codex's review order rather than restricted by
author.

## 3. Contract-first protocol

Contract-first outlived the two-queue arrangement it was designed for, because its second
job turned out to matter more than its first. It was meant to let two agents work at once; it
also forces the shapes to be decided, written down and reviewed before any implementation
argues for itself. That is worth keeping with one builder:

```
1. Claude writes the contract         → packages/contracts (OpenAPI + types)
                                        + migration for shared tables
                                        + failing integration test skeletons
2. Contract PR merges to main         → this is the sync point
3. Implementation builds against the frozen types
4. Integration PR                     → wired together, tests go green
5. Codex reviews the merged result adversarially
```

**Contract changes mid-sprint:** still their own PR, still announced. The reason is no longer
a second agent's in-flight branch — it is that a contract edited in passing, inside a feature
PR, is a contract nobody reviewed as a contract.

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
- **Review happens after the merge, not on the branch.** Codex reviews `main`, so there is
  no arguing about work in progress and no ambiguity about what actually shipped. Findings
  come back as reports; fixes land as `REV-nnn` tickets (`docs/04` §"The review loop").

## 5. Conflict-avoidance rules that actually matter

| Hazard | Rule |
|---|---|
| Migration filename collisions | Migrations are timestamp-prefixed and live in the owning package/module. Two agents never write into the same migrations dir in the same sprint. |
| Lockfile churn | Dependency **versions** live in the `catalog:` block of `pnpm-workspace.yaml`, which only Claude edits; packages reference them as `"react": "catalog:"`. A lockfile diff that only adds an importer for your own new package is expected and should be committed; a diff that adds packages or changes versions is not. Codex requests new dependencies in the sprint issue and they land in one batched PR. |
| Central registration files | There are none by design — the module registry discovers manifests by convention. If a file starts accumulating one line per feature, that is a bug in the architecture, not a merge problem to manage. |
| Generated code | `packages/sdk` is generated, never hand-edited, and regenerated in CI. Conflicts there are resolved by regenerating, never by hand-merging. |
| Shared test fixtures | `packages/testing` is Claude-owned; Codex adds module-local fixtures inside its own module. |
| Same-ticket collisions | Gone with the second build queue. Kept here because the rule returns the moment anyone else writes code. |

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
contracts   → node scripts/check-contracts.mjs   ← runs from day one, inside verify
ci          → aggregating gate; the single required status check for branch protection
```

`quality`, `integration`, and `security` are gated on the presence of `package.json` and
report *skipped* until Sprint 0 lands the workspace — a gated job is honest, a job whose
steps silently no-op is a false green.

For the same reason the two mandatory suites are asserted from the point their subject
exists, each keyed on that subject rather than on one shared milestone: `test:isolation` is
required once `apps/api` exists, and `test:module-lifecycle` once any `modules/*` package
does. Demanding a suite before there is anything for it to test can only be satisfied by a
vacuous one, and a vacuous suite is worse than a missing suite — it reports green.

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
