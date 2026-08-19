# 04 — Delivery Plan with Agent Assignments

Sprint-by-sprint plan. Every ticket has exactly one owner: **C** = Claude, **X** = Codex.
Sprints are one week. Tickets marked ⛓ are blockers for the other agent — they get built
first in the sprint.

Legend: **C** Claude · **X** Codex · ⛓ blocks the other agent · 🔒 security-critical

---

## Sprint 0 — Foundations (both agents, day 1 parallel)

| ID | Ticket | Owner |
|---|---|---|
| INF-001 ⛓ | Monorepo scaffold (pnpm workspaces, TS config, ESLint, Prettier, commit hooks) | **C** |
| INF-002 ⛓ | CI pipeline skeleton: lint → typecheck → test → build | **C** |
| INF-003 | Boundary-check ESLint rule + CI job (core ⇸ modules) | **C** |
| INF-004 | Docker Compose dev env (Postgres, Redis, MinIO, Mailpit) | **C** (reassigned: needs a Docker host, which Codex's sandbox lacks) |
| INF-005 | Terraform skeleton: VPC, RDS, ElastiCache, S3, ECS/Fargate, secrets | **C** 🔒 |
| INF-006 | `packages/testing` harness: containerised Postgres, factories, RLS test helpers | **C** |
| DEP-001 ⛓ | Dependency window: React, Storybook, component test stack into the lockfile | **C** |
| INF-007a | `packages/ui-tokens` — shared design tokens, zero dependencies, web + native | **X** |
| INF-007b | `packages/ui` — React web components on those tokens (needs DEP-001) | **X** |
| DOC-001 | ADR template + `docs/adr/0001-modular-monolith.md`, `0002-optional-modules.md` | **C** |

**Sync point:** INF-001/002 must merge before Codex opens any app PR.

---

## Sprint 1 — Tenancy & Identity core

| ID | Ticket | Owner |
|---|---|---|
| CORE-010 ⛓ 🔒 | `packages/tenancy`: TenantContext, request-scoped `app.current_church_id`, RLS-injecting base repository | **C** |
| CORE-011 🔒 | RLS policies + migration conventions; isolation test harness proving cross-tenant reads fail | **C** |
| CORE-012 ⛓ | `packages/contracts` bootstrap: OpenAPI pipeline, type generation, `packages/sdk` codegen | **C** |
| CORE-013 🔒 | Identity: registration, login, password policy, breach-list check, lockout | **C** |
| CORE-014 🔒 | JWT access + rotating refresh tokens, token-family revocation table, "log out all devices" | **C** |
| CORE-015 🔒 | MFA (TOTP) — enforced for STAFF/PASTOR/ADMIN roles | **C** |
| CORE-016 | Church & Campus services (`@church/church`) — HTTP layer deferred until `apps/api` exists | **X** |
| CORE-017a ⛓ 🔒 | People/family contract + migration: OpenAPI shapes, RLS, tenant-carrying foreign keys | **C** |
| CORE-017 | Person & Family services, membership status history, milestones (against CORE-017a) | **X** |
| CORE-018 ⛓ 🔒 | `apps/api` scaffold: NestJS + Fastify, auth → policy → tenant → error-envelope lifecycle | **C** |
| WEB-010 | Admin web shell: routing, auth flow against CORE-013/014, layout, nav-from-API stub | **X** |

Claude is the bottleneck this sprint by design — tenancy and auth must be right before
anything sits on top. Codex works against contracts merged on day 1–2 and builds the web
shell and people/church CRUD in parallel.

---

## Sprint 2 — Authorization, Audit, Module Registry

| ID | Ticket | Owner |
|---|---|---|
| CORE-020 ⛓ 🔒 | `packages/policy`: RBAC + resource-scoped policy engine, `@RequiresPermission()` | **C** |
| CORE-021 🔒 | Audit service: append-only log, before/after diff, queryable by church admin | **C** |
| CORE-022 ⛓ | **Module registry**: manifest loader, `module_definition` / `church_module`, `ModuleGuard`, 404 `MODULE_NOT_ENABLED` | **C** |
| CORE-023 | Module enable/disable API + entitlement check against plan | **C** |
| CORE-024 | Module purge job + scheduler + purge audit records | **C** |
| CORE-025 | `GET /me/modules` — enabled modules, nav, settings payload | **C** |
| CORE-026 | Groups & Ministries module (core) | **X** |
| CORE-027 | Events (free events, occurrences, RSVP) | **X** |
| CORE-028 | General Attendance (`attendance_event` primitive, headcount + individual) | **X** |
| WEB-020 | Admin web: nav rendered from `/me/modules`, module settings page, locked-state UI | **X** |
| WEB-021 | People/Family/Groups admin screens | **X** |

---

## Sprint 3 — First optional module (proves the system) + Comms

| ID | Ticket | Owner |
|---|---|---|
| MOD-030 | `modules/prayer-wall`: full module — manifest, domain, API, lifecycle, purge, isolation tests | **X** |
| MOD-031 | Prayer wall admin + member UI | **X** |
| CORE-030 🔒 | Communications: provider abstraction (Twilio/SES), `CommunicationPreference`, opt-in/opt-out, transactional vs. bulk split | **C** |
| CORE-031 | Audience segmentation query builder for comms | **C** |
| CORE-032 | Notification worker: push/SMS/email consumers, bounce/complaint feedback into preferences | **C** |
| CORE-033 | Billing: Plan/Subscription model, Stripe Billing integration, trial → paid, entitlement sync to module registry | **C** 🔒 |
| MOB-030 | Member mobile app shell: auth, module-aware nav, directory, events | **X** |
| DOC-030 | Module authoring guide, written from the prayer-wall experience | **X** |

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
| MOD-045 | Country-aware receipt templates (US 501(c)(3) first) | **X** |
| MOD-046 | Giving admin UI: funds, donation list, reconciliation, reports | **X** |
| MOD-047 | Member give flow (mobile + web), saved methods, giving history | **X** |
| CORE-040 | Data export endpoint (tenant portability bundle, incl. module data) | **X** |

Claude owns every path where money can be double-charged or a card can touch our servers.
Codex owns the surfaces around it. Clean seam, no shared files.

---

## Sprint 5–6 — Children's Check-in (the flagship optional module)

Two sprints. This is the highest-risk module and gets the most careful split.

### Sprint 5 — domain & safety core

| ID | Ticket | Owner |
|---|---|---|
| MOD-050 ⛓ 🔒 | Manifest, data classes, purge policy, safeguarding consent gate on enable | **C** |
| MOD-051 🔒 | Rooms, sessions, `GuardianAuthorisation` model + migrations | **C** |
| MOD-052 🔒 | Check-in / checkout service: two-part security code, guardian-auth enforcement, force-close with mandatory reason | **C** |
| MOD-053 🔒 | Medical notes: field-level encryption, `view_medical` permission, audited reads | **C** |
| MOD-054 🔒 | Offline sync endpoint: `client_event_id` idempotency, duplicate-checkout resolution, reconciliation report | **C** |
| MOD-055 | Contracts + SDK for the whole module (unblocks Codex's kiosk work) ⛓ | **C** |
| MOD-056 | Room/session/roster admin UI | **X** |
| MOD-057 | Guardian authorisation management UI (grant, revoke, audit view) | **X** |
| MOD-058 | Ratio checking + over-ratio staff warning | **X** |

### Sprint 6 — kiosk, offline, lifecycle

| ID | Ticket | Owner |
|---|---|---|
| MOD-060 | Kiosk app: pairing, church binding, refuse-to-start when module disabled | **X** |
| MOD-061 | Kiosk check-in/checkout flows, search, family multi-child check-in | **X** |
| MOD-062 🔒 | Encrypted local roster cache, end-of-day wipe, wipe-on-unpair | **C** |
| MOD-063 | Offline queue + drain-on-reconnect against MOD-054 | **X** |
| MOD-064 | Label printing (2-part security label), printer integration | **X** |
| MOD-065 | Auto-checkout sweep job + `open_session_alert` to campus admin | **C** |
| MOD-066 🔒 | Disable path: force-close open sessions, stop jobs, withdraw routes; purge path + tests | **C** |
| MOD-067 | Mobile: parent-side check-in, child pickup code display | **X** |
| MOD-068 | Full safety-rule test matrix from `02-module-system.md` §5.3 | **C** |
| SEC-060 🔒 | Threat model + internal security review of the module before it goes near real data | **C** |

**Gate:** SEC-060 sign-off is required before `children_checkin` is enabled for any real
tenant. No exceptions, including for pilot churches.

---

## Sprint 7 — Volunteer Scheduling + Facilities

| ID | Ticket | Owner |
|---|---|---|
| MOD-070 | `modules/volunteer-scheduling`: teams, roles, schedules, blackout dates | **X** |
| MOD-071 | Conflict detection (overlapping slots) + serving reminders via comms | **X** |
| MOD-072 | Volunteer mobile: my schedule, accept/decline, set unavailability | **X** |
| MOD-073 | `modules/facilities`: rooms/resources, bookings, overlap prevention | **X** |
| MOD-074 | Facilities admin UI + calendar | **X** |
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
| MOD-081 | Pastoral care UI (staff-only, sensitivity-aware) | **X** |
| MOD-082 | `modules/media-library`: sermons, series, external streaming metadata, podcast feed | **X** |
| MOD-083 | Media UI: web + mobile player, series browse | **X** |
| CORE-080 | Analytics: attendance/giving trends, engagement scoring, at-risk report | **X** |
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

Route to **Codex** if:

- the contract already exists and is frozen;
- it is UI against a defined API;
- it is a self-contained CRUD module with clear rules;
- it is test scaffolding, fixtures, or documentation of existing behaviour;
- it is repetitive and high-volume (screens, forms, admin tables).

**Rough split across the plan: Claude ≈ 45% of tickets (concentrated in risk), Codex ≈ 55%
(concentrated in throughput).** Codex's ticket count is higher; Claude's tickets are on the
critical path more often, which is why every sprint front-loads Claude's ⛓ items.

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
| Contract churn breaks the other agent's in-flight branch | Contract changes only via Claude's PR, announced in the sprint issue first |
| Review debt stalls both agents | Reviewing the other's open PRs precedes starting new work, daily |
| Codex builds against a module interface Claude hasn't finished | ⛓ tickets land first; Claude ships contracts + failing test skeletons before implementation |
| Module boundary erodes silently | Boundary check is a blocking CI job, never `continue-on-error` |
| Check-in module ships with a custody bug | SEC-060 gate + the §5.3 test matrix, both owned by Claude |
| Merge conflicts in shared dirs | Strict CODEOWNERS zones; cross-zone changes go through an issue, not a drive-by edit |
