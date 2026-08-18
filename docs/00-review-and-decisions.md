# 00 — Architecture Review Response & Decision Log

This folder is the buildable plan for the Church Management Platform. It takes the
architecture document that was handed over (`Church_Platform_Architecture_1.md`) and turns
it into something two agents — **Claude** and **Codex** — can build in parallel in this
GitHub repo.

| Doc | What it covers |
|---|---|
| `00-review-and-decisions.md` | What I changed in the architecture and why (this file) |
| `01-architecture.md` | Revised architecture: core vs. optional modules |
| `02-module-system.md` | The optional-module contract; Children's Check-in as reference implementation |
| `03-repo-and-workflow.md` | Monorepo layout, branching, CI, the dual-agent collaboration protocol |
| `04-delivery-plan.md` | Sprint-by-sprint plan with per-ticket ownership (Claude vs Codex) |

---

## 1. What the incoming architecture got right

Keep all of it. The multi-tenant-from-day-one stance, RLS as the isolation floor, modular
monolith before microservices, PostgreSQL as system of record, webhook-as-source-of-truth
for payments, and the security/compliance section are all correct and non-negotiable. None
of the changes below weaken them.

## 2. What I changed

### 2.1 The headline change: Children's Check-in becomes an optional module

The original document treats Children's Check-in as a fixed box inside the monolith,
present in every deployment, with the roadmap slotting it into V2 for everyone. That is
wrong for this product for four reasons:

1. **Legal exposure is opt-in, not default.** Children's check-in is the only subsystem
   that collects minors' PII, medical/allergy notes, and guardian custody relationships.
   A church that does not run a kids' ministry should not have that data model
   instantiated, that surface exposed, or that compliance obligation attached to their
   tenant. Data you never collect is data you can never leak.
2. **Not every tenant wants it.** Church plants, campus ministries, small congregations,
   and non-Sunday-school traditions have no use for it. Forcing it on them is UI noise and
   an onboarding tax.
3. **It is the natural PRO-tier lever.** The subscription model in §2.14 of the incoming
   doc already puts child check-in behind PRO. That entitlement needs a real enforcement
   mechanism, not a UI `if`.
4. **It is the hardest module to build.** Offline kiosk mode, label printing, two-part
   security codes, guardian binding, custody edge cases. Making it optional lets the MVP
   ship without it and lets the two agents build it on a separate track without blocking
   core delivery.

**Decision:** Children's Check-in ships as an *optional module* behind the module
registry, enabled per church, gated by plan entitlement, with its own permission scope,
its own migration namespace, its own audit category, and a documented disable/purge path.

### 2.2 Generalising the change: optional modules are a first-class concept

Making one module optional and leaving the rest hard-wired would be a one-off hack. So the
architecture now has a real **module system** (`02-module-system.md`) with a small set of
core modules that are always on, and a set of optional modules that are installed per
tenant. Optional at launch:

| Module | Key | Default | Min. plan |
|---|---|---|---|
| Children's Check-in | `children_checkin` | **off** | PRO |
| Volunteer Scheduling | `volunteer_scheduling` | off | PRO |
| Pastoral Care | `pastoral_care` | off | PRO |
| Giving & Finance | `giving` | off | BASIC |
| Facilities & Rooms | `facilities` | off | PRO |
| Sermon / Media Library | `media_library` | off | BASIC |
| Prayer Wall | `prayer_wall` | off | FREE |
| Events & Ticketing (paid events) | `ticketing` | off | BASIC |

Always-on core: Identity & Access, Church/Campus, People & Families, Groups, Events
(free), Attendance, Communications, Audit, Billing, Platform Admin.

This is a bigger change than "one checkbox," and it is the right one: it turns the
subscription tiers into something the code actually enforces, it makes per-tenant canary
rollout of new modules trivial (§2.12 of the incoming doc asked for exactly this), and it
gives us a clean seam for the two agents to work behind.

### 2.3 Smaller corrections

- **Attendance vs. Check-in split.** The incoming doc has "Attendance / Check-in" and
  "Children's Check-in" as separate boxes with overlapping responsibility. Adult/general
  attendance recording is core; *supervised child custody check-in* is the optional
  module. They share an `attendance_event` primitive, defined in core, extended by the
  module.
- **Guardian relationship needs to be explicit.** `Family.members[].relationship` in the
  incoming model is not sufficient for custody decisions — "parent" is not the same as
  "authorised pickup." The module adds an explicit `GuardianAuthorisation` record, and the
  core `Family` model stays as-is. See `02-module-system.md` §5.
- **Module lifecycle was missing.** Enable, disable, and *purge* are now specified,
  including what happens to child data when a church turns the module off (retention
  window, then hard delete, with the deletion itself audited).
- **Roadmap re-phased.** MVP no longer contains check-in at all; V2 is "first optional
  modules, proving the module system"; check-in lands in V2 as the reference optional
  module rather than as a monolith feature.

## 3. Decision log

| # | Decision | Rationale | Reversible? |
|---|---|---|---|
| D-01 | Children's Check-in is optional, off by default | Legal exposure, tier lever, build risk | Yes (flip default) |
| D-02 | Generic per-tenant module registry, not per-feature flags | Avoids flag sprawl; enforces plan entitlements in one place | Hard |
| D-03 | Optional modules own their tables in a `mod_<key>_` prefix | Enables clean purge on disable; keeps migrations conflict-free between agents | Hard |
| D-04 | Module code lives in `modules/<key>/` packages, not in core | Directory-level ownership = parallel agents without merge conflicts | Medium |
| D-05 | Disabled module returns `404 MODULE_NOT_ENABLED`, never a partial 200 | No information leakage about tenant configuration | Yes |
| D-06 | Core defines `attendance_event`; check-in module extends it | Avoids duplicate attendance truth | Medium |
| D-07 | Backend TypeScript + NestJS, per incoming recommendation | Unchanged — module system maps onto NestJS dynamic modules | Hard |
| D-08 | Contract-first development (`packages/contracts` is the handoff artifact) | Two agents cannot work in parallel without a frozen interface between them | Medium |
