# 02 — The Optional Module System

The contract every optional module implements, and Children's Check-in as the reference
implementation of it.

---

## 1. Anatomy of a module

```
modules/children-checkin/
├── module.manifest.ts        # declaration: key, plan, permissions, data classes, purge
├── src/
│   ├── children-checkin.module.ts   # NestJS dynamic module, registered by the registry
│   ├── api/                  # controllers — every route carries @RequiresModule()
│   ├── domain/               # entities, services, policies
│   ├── events/               # published/consumed bus events (namespaced)
│   └── jobs/                 # scheduled work (auto-checkout sweep, label GC)
├── migrations/               # OWNED BY THIS MODULE — tables prefixed mod_children_checkin_
├── contracts/                # OpenAPI fragment + generated TS types (published to SDK)
├── test/
│   ├── unit/
│   ├── integration/
│   └── isolation/            # mandatory tenant-isolation tests (see 01 §4, incoming §2.3)
└── README.md                 # what it does, what it collects, how to purge it
```

Nothing outside `modules/children-checkin/` mentions children's check-in — no import, no
route registration, no `if (features.checkin)`. If you have to touch a core file to add a
module, the module system has a hole in it; fix the hole rather than the symptom.

## 2. The manifest

```ts
export const manifest: ModuleManifest = {
  key: 'children_checkin',
  name: "Children's Check-in",
  version: '1.0.0',
  minPlan: 'PRO',
  defaultEnabled: false,
  requires: [],                       // core only

  permissions: [                      // registered into RBAC at boot
    'children_checkin:checkin',
    'children_checkin:checkout',
    'children_checkin:manage_rooms',
    'children_checkin:view_medical',  // narrowest scope in the system
    'children_checkin:admin',
  ],

  dataClasses: [                      // drives retention, export, and purge
    { name: 'minor_pii',      sensitivity: 'restricted', retention: 'P2Y' },
    { name: 'medical_note',   sensitivity: 'restricted', retention: 'P1Y',
      fieldEncrypted: true },
    { name: 'checkin_record', sensitivity: 'standard',   retention: 'P7Y' },
  ],

  purgePolicy: {
    onDisable: 'retain',              // disable never destroys data
    retentionAfterDisable: 'P90D',    // then purge unless re-enabled
    purgeStrategy: 'hard_delete',
    auditPurge: true,
  },

  nav: [ { label: 'Check-in', path: '/checkin', icon: 'kiosk',
           requiresPermission: 'children_checkin:checkin' } ],

  events: {
    publishes: ['children_checkin.checked_in', 'children_checkin.checked_out',
                'children_checkin.open_session_alert'],
    consumes:  ['core.person.deleted', 'core.event.cancelled'],
  },
};
```

The registry reads manifests at boot, upserts `module_definition`, registers permissions,
mounts routes behind `ModuleGuard`, and exposes an enabled-modules + nav payload to
clients via `GET /api/v1/me/modules`.

## 3. Lifecycle

```
                 plan grants entitlement
   [available] ──────────────────────────▶ admin clicks Enable
        ▲                                          │
        │                                          ▼
        │                                     [enabled]
        │                                          │ admin clicks Disable
        │                                          ▼
        │                                    [disabled]  ── data retained, routes 404,
        │                                          │        nav hidden, jobs stopped
        │            re-enable within 90d          │
        └──────────────────────────────────────────┤
                                                   │ 90 days elapse
                                                   ▼
                                            [pending_purge] ── admin + platform notified
                                                   │ 14-day final grace
                                                   ▼
                                              [purged] ── module tables emptied for this
                                                          church_id; purge itself audited
```

**Enable** requires: entitlement check, `requires[]` satisfied, admin confirms a
module-specific consent screen (for `children_checkin`: the safeguarding/data-minimisation
acknowledgement), roles seeded, default settings written, audit entry.

**Disable** requires: confirmation naming what becomes inaccessible, immediate route/nav
withdrawal, scheduled-job cancellation, in-flight session handling (open check-ins must be
closed or force-closed with an audit note before disable completes), audit entry.

**Purge** is the part everyone forgets. It is a background job that deletes all
`mod_<key>_*` rows for that `church_id`, writes an immutable audit record of what was
deleted (counts and classes, never content), and leaves the `church_module` row in
`purged`. Financial records under legal hold are exempt and are moved to core-owned
archival tables before purge — which is precisely why `giving` and `children_checkin` have
different purge policies.

## 4. Client-side degradation

- `GET /api/v1/me/modules` returns enabled modules + nav entries + module settings.
- Admin web and mobile render navigation **from that payload**, never from a hardcoded
  list. A module that is off simply produces no nav.
- The generated SDK throws a typed `ModuleNotEnabledError` on the 404, so a deep link to a
  disabled module's page shows "This feature isn't enabled for your church" (with an
  upgrade or an admin-contact CTA depending on entitlement), not an error boundary.
- The kiosk app is a separate client that refuses to start if `children_checkin` is not
  enabled for the church it is paired with.

---

## 5. Children's Check-in — the reference implementation

### 5.1 Why it is the reference

It exercises every hard part of the contract at once: restricted data classes, field-level
encryption, the narrowest permission scope in the system, offline clients, a separate
device app, scheduled jobs, cross-module events, and a purge policy with real legal weight.
If the module contract survives this module, it survives anything.

### 5.2 Domain model

```
mod_children_checkin_room
 ├── id, church_id, campus_id, name, capacity
 └── age_min_months, age_max_months, ratio_children_per_volunteer

mod_children_checkin_session          -- one service/occurrence a room is open for
 ├── id, church_id, room_id, event_id (→ core event), opens_at, closes_at
 └── status: scheduled | open | closed

mod_children_checkin_guardian_auth    -- explicit, NOT inferred from Family
 ├── id, church_id, child_person_id (→ core person)
 ├── guardian_person_id (→ core person)
 ├── relationship: parent | guardian | grandparent | authorised_adult
 ├── can_checkin: bool, can_checkout: bool
 └── granted_by, granted_at, revoked_at

mod_children_checkin_record
 ├── id, church_id, session_id, child_person_id
 ├── checked_in_at, checked_in_by (person_id), checked_in_device_id
 ├── checked_out_at, checked_out_by, checked_out_device_id
 ├── security_code            -- 2-part: guardian half + child half, both required
 ├── status: open | closed | force_closed
 └── client_event_id          -- client-generated idempotency key for offline sync

mod_children_checkin_medical_note     -- FIELD-LEVEL ENCRYPTED
 ├── child_person_id, church_id
 ├── allergies_ciphertext, conditions_ciphertext, notes_ciphertext
 └── updated_by, updated_at
     (read requires children_checkin:view_medical; every read is audited)
```

`GuardianAuthorisation` is the deliberate correction to the incoming model. `Family` says
who is related; it does not say who is allowed to collect a child. Divorce, custody
orders, foster placement, and "grandma picks up on Wednesdays" are all cases where those
two answers differ, and getting it wrong is the worst failure this product can have.

### 5.3 Safety-critical rules (non-negotiable, each with a named test)

| Rule | Test |
|---|---|
| Checkout requires both halves of the security code to match the open record | `checkout.security-code.spec` |
| Checkout requires an *unrevoked* `guardian_auth` with `can_checkout` | `checkout.guardian-auth.spec` |
| Force-close (staff override) requires `children_checkin:admin` + a mandatory reason, always audited | `checkout.force-close.spec` |
| Medical notes are unreadable without `children_checkin:view_medical`; every read audited | `medical.access-control.spec` |
| Room ratio is checked at check-in; over-ratio warns staff and is recorded | `checkin.ratio.spec` |
| Duplicate offline sync of the same `client_event_id` is idempotent, never a double record | `sync.idempotency.spec` |
| A session still open past `closes_at + grace` raises `open_session_alert` | `jobs.open-session-alert.spec` |
| Church A cannot read Church B's records by ID guessing | `isolation/children-checkin.spec` |
| Disabling the module force-closes open sessions before completing | `lifecycle.disable.spec` |

### 5.4 Offline behaviour

Kiosk and volunteer apps cache the day's roster in an encrypted local store, queue check-in
and check-out events with client timestamps and `client_event_id`, and drain the queue on
reconnect. Server-side, records are append-only and deduped on `(church_id,
client_event_id)`. A conflicting offline checkout (two devices, same child) resolves to the
earliest server-accepted event; the loser is recorded as a duplicate and surfaced in the
day's reconciliation report rather than silently dropped. Roster cache expires at end of
day and is wiped on logout or device unpair — a lost kiosk tablet must not be a data
breach.

---

## 6. Definition of Done for any optional module

A module PR is not mergeable until all of these are true:

- [ ] `module.manifest.ts` complete, including `dataClasses` and `purgePolicy`
- [ ] Zero references to the module key outside `modules/<key>/` (CI-enforced)
- [ ] All tables prefixed `mod_<key>_`, all RLS-scoped by `church_id`
- [ ] Tenant-isolation test present and passing
- [ ] Enable / disable / purge paths implemented and tested, including in-flight state
- [ ] Every route behind `@RequiresModule()` + a module-scoped permission
- [ ] Disabled-tenant request returns 404 `MODULE_NOT_ENABLED` (tested)
- [ ] Nav emitted from manifest; client renders no hardcoded entry
- [ ] Contract fragment published; SDK regenerated
- [ ] Audit categories registered for every restricted-class read/write
- [ ] `README.md` states what data it collects and how to purge it
