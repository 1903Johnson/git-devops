# 04 — Delivery Plan with Agent Assignments

Sprint-by-sprint plan. Claude builds every ticket; Codex reviews what lands and reports
defects (`AGENTS.md` §2).
Sprints are one week. Tickets marked ⛓ are blockers for the other agent — they get built
first in the sprint.

Legend: **C** Claude builds it · 🔍 Codex reviews it adversarially · 🔒 security-critical

**Every ticket is Claude's.** Codex builds nothing; it attacks what has been merged and
reports what it finds, and Claude fixes it (`AGENTS.md` §2). The ⛓ marker is gone with the
second build queue — nothing blocks another agent any more, only itself.

---

## Sprint 0 — Foundations (both agents, day 1 parallel)

| ID | Ticket | Owner |
|---|---|---|
| INF-001 | Monorepo scaffold (pnpm workspaces, TS config, ESLint, Prettier, commit hooks) | **C** |
| INF-002 | CI pipeline skeleton: lint → typecheck → test → build | **C** |
| INF-003 | Boundary-check ESLint rule + CI job (core ⇸ modules) | **C** |
| INF-004 | Docker Compose dev env (Postgres, Redis, MinIO, Mailpit) | **C** (reassigned: needs a Docker host, which Codex's sandbox lacks) |
| INF-005 | Terraform skeleton: VPC, RDS, ElastiCache, S3, ECS/Fargate, secrets | **C** 🔒 |
| INF-006 | `packages/testing` harness: containerised Postgres, factories, RLS test helpers | **C** |
| DEP-001 | Dependency window: React, Storybook, component test stack into the lockfile | **C** |
| INF-007a | `packages/ui-tokens` — shared design tokens, zero dependencies, web + native | **C** |
| INF-007b | `packages/ui` — React web components on those tokens (needs DEP-001) | **C** |
| DOC-001 | ADR template + `docs/adr/0001-modular-monolith.md`, `0002-optional-modules.md` | **C** |

**Sync point:** INF-001/002 must merge before Codex opens any app PR.

---

## Sprint 1 — Tenancy & Identity core

| ID | Ticket | Owner |
|---|---|---|
| CORE-010 🔒 | `packages/tenancy`: TenantContext, request-scoped `app.current_church_id`, RLS-injecting base repository | **C** |
| CORE-011 🔒 | RLS policies + migration conventions; isolation test harness proving cross-tenant reads fail | **C** |
| CORE-012 | `packages/contracts` bootstrap: OpenAPI pipeline, type generation, `packages/sdk` codegen | **C** |
| CORE-013 🔒 | Identity: registration, login, password policy, breach-list check, lockout | **C** |
| CORE-014 🔒 | JWT access + rotating refresh tokens, token-family revocation table, "log out all devices" | **C** |
| CORE-015 🔒 | MFA (TOTP) — enforced for STAFF/PASTOR/ADMIN roles | **C** |
| CORE-016 | Church & Campus services (`@church/church`) — HTTP layer deferred until `apps/api` exists | **C** |
| CORE-017a 🔒 | People/family contract + migration: OpenAPI shapes, RLS, tenant-carrying foreign keys | **C** |
| CORE-017 | Person & Family services, membership status history, milestones (against CORE-017a) | **C** |
| CORE-018 🔒 | `apps/api` scaffold: NestJS + Fastify, auth → policy → tenant → error-envelope lifecycle | **C** |
| CORE-019 🔒 | Auth API + role assignment: `user_role`, roles into the token, `/auth/*`, `/me` | **C** |
| DEP-002 | Dependency window: Next.js + its ESLint config into the catalog (blocks WEB-010) | **C** |
| WEB-010 | Admin web shell: routing, auth flow against CORE-019, layout, nav-from-API stub (needs DEP-002) | **C** |

Sprint 1 is complete apart from WEB-010. CORE-016 and CORE-017 were Codex's and are now
Claude's; both have shipped. DEP-002 has landed, so WEB-010 is unblocked — `next` and
`eslint-config-next` are in the catalog and a package may reference them as `catalog:`.

---

## Sprint 2 — Authorization, Audit, Module Registry

| ID | Ticket | Owner |
|---|---|---|
| CORE-020 🔒 | `packages/policy`: RBAC + resource-scoped policy engine, `@RequiresPermission()` | **C** |
| CORE-021 🔒 | Audit service: append-only log, before/after diff, queryable by church admin | **C** |
| CORE-021a 🔒 | Audit failed logins — needs `@church/identity` to attribute a known-user failure to its church | **C** |
| CORE-022 | **Module registry**: manifest loader, `module_definition` / `church_module`, `ModuleGuard`, 404 `MODULE_NOT_ENABLED` | **C** |
| CORE-023 | Module enable/disable API + entitlement check against plan | **C** |
| CORE-024 | Module purge job (`apps/worker`) + purge audit records; scheduling is deployment config (INF-005) | **C** |
| CORE-025 | `GET /me/modules` — enabled modules, nav, settings payload | **C** |
| CORE-026 | Groups & Ministries module (core) | **C** |
| CORE-027 | Events (free events, occurrences, RSVP) | **C** |
| CORE-028 | General Attendance (`attendance_event` primitive, headcount + individual) | **C** |
| WEB-020 | Admin web: nav rendered from `/me/modules`, module settings page, locked-state UI | **C** |
| WEB-021 | People/Family/Groups admin screens | **C** |

---

## Sprint 3 — First optional module (proves the system) + Comms

| ID | Ticket | Owner |
|---|---|---|
| MOD-030 | `modules/prayer-wall`: full module — manifest, domain, API, lifecycle, purge, isolation tests | **C** |
| MOD-031 | Prayer wall admin + member UI | **C** |
| CORE-030 🔒 | Communications: provider abstraction (Twilio/SES), `CommunicationPreference`, opt-in/opt-out, transactional vs. bulk split | **C** |
| CORE-031 | Audience segmentation query builder for comms | **C** |
| CORE-032 | Notification worker: push/SMS/email consumers, bounce/complaint feedback into preferences | **C** |
| CORE-033 | Billing: Plan/Subscription model, Stripe Billing integration, trial → paid, entitlement sync into `church.plan` (added in CORE-023) | **C** 🔒 |
| MOB-030 | Member mobile app shell: auth, module-aware nav, directory, events | **C** |
| DOC-030 | Module authoring guide, written from the prayer-wall experience | **C** |

**Gate:** prayer-wall must enable/disable/purge cleanly on staging before Sprint 4 opens.
If the module contract needs changes, this is the cheap moment to find out.

---

## Sprint 4 — Giving (optional module, money)

| ID | Ticket | Owner |
|---|---|---|
| MOD-040 🔒 | `modules/giving`: manifest, Fund/Pledge/Donation model, purge policy with legal-hold carve-out | **C** |
| MOD-041 🔒 | `PaymentProvider` interface + Stripe implementation, hosted fields / tokenization (SAQ A) | **C** |
| MOD-042 🔒 | Webhook receiver: signature verification, idempotency keys, status state machine | **C** |
| MOD-043 | Recurring giving + dunning schedule + `at_risk` pledge surfacing | **C** |
| MOD-044 | Refunds, disputes, receipt correction | **C** |
| MOD-045 | Country-aware receipt templates (US 501(c)(3) first) | **C** |
| MOD-046 | Giving admin UI: funds, donation list, reconciliation, reports | **C** |
| MOD-047 | Member give flow (mobile + web), saved methods, giving history | **C** |
| CORE-040 | Data export endpoint (tenant portability bundle, incl. module data) | **C** |

Claude owns every path where money can be double-charged or a card can touch our servers.
Codex owns the surfaces around it. Clean seam, no shared files.

---

## Sprint 5–6 — Children's Check-in (the flagship optional module)

Two sprints. This is the highest-risk module and gets the most careful split.

### Sprint 5 — domain & safety core

| ID | Ticket | Owner |
|---|---|---|
| MOD-050 🔒 | Manifest, data classes, purge policy, safeguarding consent gate on enable | **C** |
| MOD-051 🔒 | Rooms, sessions, `GuardianAuthorisation` model + migrations | **C** |
| MOD-052 🔒 | Check-in / checkout service: two-part security code, guardian-auth enforcement, force-close with mandatory reason | **C** |
| MOD-053 🔒 | Medical notes: field-level encryption, `view_medical` permission, audited reads | **C** |
| MOD-054 🔒 | Offline sync endpoint: `client_event_id` idempotency, duplicate-checkout resolution, reconciliation report | **C** |
| MOD-055 | Contracts + SDK for the whole module (unblocks Codex's kiosk work) | **C** |
| MOD-056 | Room/session/roster admin UI | **C** |
| MOD-057 | Guardian authorisation management UI (grant, revoke, audit view) | **C** |
| MOD-058 | Ratio checking + over-ratio staff warning | **C** |

### Sprint 6 — kiosk, offline, lifecycle

| ID | Ticket | Owner |
|---|---|---|
| MOD-060 | Kiosk app: pairing, church binding, refuse-to-start when module disabled | **C** |
| MOD-061 | Kiosk check-in/checkout flows, search, family multi-child check-in | **C** |
| MOD-062 🔒 | Encrypted local roster cache, end-of-day wipe, wipe-on-unpair | **C** |
| MOD-063 | Offline queue + drain-on-reconnect against MOD-054 | **C** |
| MOD-064 | Label printing (2-part security label), printer integration | **C** |
| MOD-065 | Auto-checkout sweep job + `open_session_alert` to campus admin | **C** |
| MOD-066 🔒 | Disable path: force-close open sessions, stop jobs, withdraw routes; purge path + tests | **C** |
| MOD-067 | Mobile: parent-side check-in, child pickup code display | **C** |
| MOD-068 | Full safety-rule test matrix from `02-module-system.md` §5.3 | **C** |
| SEC-060 🔒 | Threat model + internal security review of the module before it goes near real data | **C** |

**Gate:** SEC-060 sign-off is required before `children_checkin` is enabled for any real
tenant. No exceptions, including for pilot churches.

---

## Sprint 7 — Volunteer Scheduling + Facilities

| ID | Ticket | Owner |
|---|---|---|
| MOD-070 | `modules/volunteer-scheduling`: teams, roles, schedules, blackout dates | **C** |
| MOD-071 | Conflict detection (overlapping slots) + serving reminders via comms | **C** |
| MOD-072 | Volunteer mobile: my schedule, accept/decline, set unavailability | **C** |
| MOD-073 | `modules/facilities`: rooms/resources, bookings, overlap prevention | **C** |
| MOD-074 | Facilities admin UI + calendar | **C** |
| CORE-070 🔒 | GDPR workflows: consent capture, right-to-access export, right-to-erasure with legal-hold exceptions | **C** |
| CORE-071 | Retention policy engine driven by module `dataClasses` | **C** |
| INF-070 | Observability: OpenTelemetry traces, Grafana dashboards, Sentry, alerting | **C** |
| INF-071 | Backup/PITR, restore drill runbook, RPO/RTO validation | **C** |

Codex carries this sprint almost alone — these two modules are well-specified CRUD with
conflict rules, exactly the shape it is fastest at. Claude spends the sprint on compliance
and operational maturity, which is unspecified, cross-cutting, and legally consequential.

---

## Sprint 8 — Pastoral Care + Media + hardening

| ID | Ticket | Owner |
|---|---|---|
| MOD-080 🔒 | `modules/pastoral-care`: cases, sensitivity classification, restricted access, audited reads | **C** |
| MOD-081 | Pastoral care UI (staff-only, sensitivity-aware) | **C** |
| MOD-082 | `modules/media-library`: sermons, series, external streaming metadata, podcast feed | **C** |
| MOD-083 | Media UI: web + mobile player, series browse | **C** |
| CORE-080 | Analytics: attendance/giving trends, engagement scoring, at-risk report | **C** |
| CORE-081 | CDC pipeline to analytics warehouse | **C** |
| INF-080 | Canary release + per-tenant rollout tooling on top of the module registry | **C** |
| SEC-080 🔒 | Full-platform pen-test prep, dependency audit, responsible-disclosure policy | **C** |

---

## Assignment principles (for tickets not yet written)

Route a new ticket to **Claude** if any of these are true:

- it touches tenancy, authN/authZ, encryption, secrets, or audit;
- money moves, or a payment provider is involved;
- minors' data or pastoral confidentiality is involved;
- it defines a contract, migration, or interface another workstream depends on;
- the requirement is ambiguous and needs a design decision before code;
- it is infrastructure, CI, release, or DR.

Codex is not a route any more. Every ticket is Claude's, and Codex reviews what lands —
see §"The review loop" below and [docs/tasks/SEC-REVIEW.md](tasks/SEC-REVIEW.md) for the
standing brief.

**Two consequences worth stating.** The critical path is now the only path, so the plan is
longer in wall-clock terms and the sprint boundaries are softer. And the quality bar stops
depending on one agent reviewing its own work, which is the trade being made: a slower build
queue in exchange for an adversary who has no incentive to conclude the code is fine.

## The review loop

```
Claude merges a ticket
        │
        ▼
Codex reviews main adversarially ──▶ report: findings, severity, reproduction
        │                                        │
        │                                        ▼
        │                            Claude triages every one
        │                                        │
        │                    ┌───────────────────┼──────────────────┐
        │                    ▼                   ▼                  ▼
        │              real → fix + test    not a defect →     needs a decision →
        │              in a REV- ticket     reply with why     raise with the owner
        └────────────────────┴───────────────────┴──────────────────┘
```

Rules that make it work rather than theatre:

- **A finding is not closed by disagreement alone.** Dismissing one requires saying, in
  writing, why the described sequence cannot happen. "Looks fine" is not a reason.
- **Every real finding gets a regression test**, and the test must fail against the commit
  that was reported. A fix with no failing test first is a guess.
- **Codex reviews merged `main`, not open PRs.** Reviewing a branch invites arguing about
  work in progress; reviewing what shipped is unambiguous about what is real.
- **Fixes land as `REV-nnn` tickets** referencing the report, so the history shows what was
  found, when, and what it cost.

### Findings so far

Pass 1 reviewed `549567c` and returned three findings, all confirmed on inspection.

| ID | From | Severity | What | Status |
|---|---|---|---|---|
| REV-001 | SEC-002 | high | Refresh rotation consumed a token without a guard, so two concurrent presentations both succeeded and theft detection never fired | **fixed** |
| REV-002 | SEC-001 | high | Campus scoping is applied on single-record reads and writes only; collection, create and campus-management paths pass no resource, so a CAMPUS_ADMIN is not confined | open |
| REV-003 | SEC-003 | medium | TOTP counter is read outside the write transaction and advanced unconditionally, so one code can complete two concurrent logins | open |

Two things that pass is worth remembering for:

- **Its reproductions were not executed** — the reviewing sandbox could not run the suites,
  so all three findings came from reading. They were right anyway, but an unexecuted
  reproduction is a hypothesis, and REV-001 is why that distinction matters: the obvious
  way to write its regression test passes against the defect, because two racing requests
  serialise on their own most of the time. The failing test had to force the interleaving.
- **The "sound" list needs the same scepticism as the findings.** The purge path was
  cleared partly because `WHERE church_id = $1` is present — which is the right conclusion
  from the wrong evidence, since that clause was absent while twelve tests passed, and only
  an owner-connection test caught it.

## Milestones

| Milestone | Ends | Ships |
|---|---|---|
| **M1 — Core platform** | Sprint 2 | Multi-tenant core, auth+MFA, RBAC, audit, module registry |
| **M2 — Module system proven** | Sprint 3 | Prayer wall enable/disable/purge on staging, comms, billing |
| **M3 — Money** | Sprint 4 | Giving module, live payments, receipts |
| **M4 — Check-in** | Sprint 6 | Children's Check-in + kiosk, security-reviewed |
| **M5 — Breadth** | Sprint 8 | Volunteer scheduling, facilities, pastoral care, media, analytics |

## Top risks for this particular arrangement

| Risk | Mitigation |
|---|---|
| One build queue means one point of failure | Nothing blocks on a second agent any more; the cost is wall-clock, and the plan says so rather than pretending otherwise |
| Claude reviews its own work and finds nothing | The whole reason for the change. Codex's brief is adversarial and its success is measured in defects found, not in agreeing |
| Codex reports noise, and triage becomes the bottleneck | Findings require a reproduction; a report without one is returned, not argued with |
| A real finding is dismissed for convenience | Dismissal requires a written reason why the sequence cannot happen, in the ticket, where it can be re-read later |
| Module boundary erodes silently | Boundary check is a blocking CI job, never `continue-on-error` |
| Check-in module ships with a custody bug | SEC-060 gate + the §5.3 test matrix, plus a dedicated Codex review pass before it ships |
| Codex's sandbox cannot reach the repository | Already happened once and cost it fourteen merges of drift. Its environment must be able to fetch `main` before a review pass is meaningful |
