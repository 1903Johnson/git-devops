# 01 — Revised Architecture

Everything in the incoming architecture document stands unless contradicted here. This doc
records the deltas: the core/optional split, where the module registry sits, and how a
request is resolved end-to-end when modules can be absent.

---

## 1. System diagram (revised)

```
                                    CLIENTS
   ┌────────────────┬─────────────────┬────────────────┬─────────────────┐
   │ Member Mobile  │ Pastor/Admin    │ Kiosk App      │ Super Admin     │
   │ (React Native) │ Web (Next.js)   │ (optional mod) │ Portal          │
   └───────┬────────┴────────┬────────┴───────┬────────┴────────┬────────┘
           └─────────────────┴────────┬───────┴─────────────────┘
                                      │ HTTPS / WSS
                            ┌─────────▼─────────┐
                            │    CDN / WAF      │
                            └─────────┬─────────┘
                            ┌─────────▼──────────────────────────┐
                            │  API Gateway / BFF                 │
                            │  AuthN · RateLimit · Routing       │
                            │  TenantContext · ModuleGuard  ◀── new
                            └─────────┬──────────────────────────┘
                                      │
 ┌────────────────────────────────────┴─────────────────────────────────────┐
 │                     MODULAR MONOLITH (NestJS)                            │
 │                                                                          │
 │  CORE — always present, every tenant                                     │
 │  ┌────────────┬────────────┬────────────┬────────────┬────────────────┐  │
 │  │ Identity & │ Church &   │ People &   │ Groups /   │ Events         │  │
 │  │ Access     │ Campus     │ Families   │ Ministries │ (free)         │  │
 │  ├────────────┼────────────┼────────────┼────────────┼────────────────┤  │
 │  │ Attendance │ Comms /    │ Audit &    │ Billing /  │ Platform Admin │  │
 │  │ (general)  │ Notify     │ Compliance │ Subs       │                │  │
 │  └────────────┴────────────┴────────────┴────────────┴────────────────┘  │
 │                                                                          │
 │  ┌────────────────────────────────────────────────────────────────────┐  │
 │  │  MODULE REGISTRY  ◀── new                                          │  │
 │  │  manifest catalogue · per-tenant enablement · plan entitlement     │  │
 │  │  route mounting · permission registration · nav emission · purge   │  │
 │  └────────────────────────────────────────────────────────────────────┘  │
 │                                                                          │
 │  OPTIONAL — installed per tenant                                         │
 │  ┌────────────────┬────────────────┬────────────────┬─────────────────┐  │
 │  │ Children's     │ Volunteer      │ Giving &       │ Pastoral Care   │  │
 │  │ Check-in ★     │ Scheduling     │ Finance        │                 │  │
 │  ├────────────────┼────────────────┼────────────────┼─────────────────┤  │
 │  │ Facilities &   │ Sermon / Media │ Prayer Wall    │ Ticketing       │  │
 │  │ Rooms          │ Library        │                │ (paid events)   │  │
 │  └────────────────┴────────────────┴────────────────┴─────────────────┘  │
 │  ★ reference implementation of the optional-module contract              │
 └────────────────────────────────┬─────────────────────────────────────────┘
                                  │ publishes / consumes
                         ┌────────▼────────┐
                         │   Event Bus     │  (SQS/RabbitMQ → Kafka later)
                         └────────┬────────┘
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
        Notification          Analytics          Background
          Worker               Worker            Job Worker
   (module events are namespaced: children_checkin.checked_in, …)

                               DATA LAYER
   ┌──────────────┬──────────────┬────────────────┬──────────────┐
   │ PostgreSQL   │ Redis        │ Object Storage │ OpenSearch   │
   │ primary +    │ cache,       │ S3-compatible  │ post-MVP     │
   │ replica, RLS │ sessions,    │ (labels, media)│              │
   │              │ queues       │                │              │
   └──────────────┴──────────────┴────────────────┴──────────────┘
```

---

## 2. Core vs. optional — the rule

A module belongs in **core** if any of these hold:

- another core module has a hard compile-time dependency on it;
- disabling it would leave the product unusable (auth, people, church setup);
- it is a platform obligation rather than a customer feature (audit, billing).

Everything else is **optional**. When in doubt, optional — the cost of an unnecessary
module boundary is a little indirection; the cost of a missing one is a rewrite.

### Dependency direction

```
optional module ──depends on──▶ core
optional module ──depends on──▶ another optional module   (declared, checked at enable time)
core ───────────X──────────────▶ optional module           (FORBIDDEN — enforced in CI)
```

Core never imports from `modules/*`. This is enforced by an ESLint boundary rule and by a
CI check that fails the build on violation. It is the single most important structural
invariant in the codebase: break it and the module system silently stops working.

Cross-module dependencies are declared in the manifest (`requires: []`) and validated when
a tenant enables the module. `children_checkin` requires nothing but core. `ticketing`
requires `giving`.

---

## 3. Request lifecycle with modules

```
1. TLS terminate at CDN/WAF
2. API Gateway: verify JWT → extract { user_id, church_id, campus_id?, roles[] }
3. TenantContext: SET LOCAL app.current_church_id = <church_id>   (RLS enforcement)
4. ModuleGuard:  is the route's module enabled for this church?
                 ├─ not enabled → 404 { code: "MODULE_NOT_ENABLED" }
                 └─ enabled → continue
5. PolicyGuard:  does this user hold the required module-scoped permission?
                 └─ no → 403 { code: "FORBIDDEN" }
6. Handler runs → repository injects church_id → RLS is the backstop, not the plan
7. AuditInterceptor: writes the access record for audited resource classes
8. Response
```

Steps 3–5 are the tenancy/entitlement/authorisation stack, in that order. Order matters:
we resolve the tenant before we ask what that tenant has enabled, and we check entitlement
before we check permission, so a user can never learn from an error code that a module
exists but they lack rights to it.

**A disabled module returns 404, not 403.** A 403 tells an attacker the feature exists for
that tenant; a 404 tells them nothing. This also means the client must handle 404 on a
route it "knows" exists — the SDK maps `MODULE_NOT_ENABLED` to a typed error so UI can
degrade gracefully rather than showing a crash.

---

## 4. Data layer changes

Three additions to the incoming data design:

**Module registry tables (core):**

```sql
-- Catalogue of modules known to this deployment (seeded from manifests at boot)
module_definition(key PK, name, version, min_plan, default_enabled,
                  requires jsonb, data_classes jsonb, purge_policy jsonb)

-- Per-tenant enablement. RLS-scoped by church_id.
church_module(church_id, module_key, status, enabled_at, enabled_by,
              disabled_at, purge_after, settings jsonb,
              PRIMARY KEY (church_id, module_key))
-- status: enabled | disabled | pending_purge | purged
```

**Table naming:** optional-module tables are prefixed `mod_<key>_`, e.g.
`mod_children_checkin_session`. This is not cosmetic — it makes the purge path a
mechanical operation over a known table set, it keeps migration files from two different
agents in different directories, and it makes an accidental core→module foreign key
obvious in review.

**Foreign keys across the boundary:** module tables may reference core tables
(`person.id`, `event.id`); core tables may **never** reference module tables. Where core
needs to know something a module produced (e.g. attendance counts), the module writes into
a core-owned table through a core-published service interface, or emits an event.

---

## 5. Entitlement vs. enablement

Two different things, deliberately separated:

- **Entitlement** — "may this church's *plan* have this module?" Owned by Billing. Derived
  from `subscription.plan` and `module_definition.min_plan`.
- **Enablement** — "has this church's admin *turned it on*?" Owned by the Module Registry.
  Stored in `church_module`.

A module runs only when entitled **and** enabled. On downgrade, entitlement is lost, the
module moves to `disabled` (data retained, per §2.14 of the incoming doc: downgrade never
deletes), and the UI shows a locked state with an upgrade path. On upgrade, the module
becomes available but stays off until an admin enables it — no surprise activation of a
module that starts collecting children's data.

---

## 6. What this changes in the roadmap

| Phase | Incoming plan | Revised |
|---|---|---|
| MVP | Core + basic notifications | Core + **module registry with one trivial optional module** (`prayer_wall`) to prove the machinery end-to-end |
| V2 | Giving, Children's Check-in, Volunteer Scheduling | `giving`, `volunteer_scheduling`, **`children_checkin` as the flagship optional module** |
| V3 | Pastoral Care, Facilities, Media, Analytics | Unchanged, all as optional modules |
| V4 | Multi-region payments, streaming, public API, AI | Unchanged, plus **third-party module SDK** if the registry has proven out |

Proving the module system in MVP with a low-risk module (`prayer_wall`: small schema, no
sensitive data, no offline requirement) is deliberate. We find out whether the abstraction
holds *before* betting the highest-risk subsystem on it.
