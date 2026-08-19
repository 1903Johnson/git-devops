# `@church/module-kit`

The optional-module contract and registry. Specification: [`docs/02-module-system.md`](../../docs/02-module-system.md).

A module is a directory under `modules/` containing a `manifest.ts`. Nothing registers it;
the loader finds it. There is no central list to edit, because a central list is a merge
conflict between two agents on every module they add — and a module that exists but was
never added to the list is exactly the failure this registry is supposed to make
impossible.

## Declaring a module

```ts
// modules/prayer_wall/manifest.ts
import { defineModule } from '@church/module-kit';

export const manifest = defineModule({
  key: 'prayer_wall',           // snake_case, and the mod_<key>_ table prefix
  name: 'Prayer Wall',
  version: '1.0.0',
  minPlan: 'FREE',
  defaultEnabled: true,
  requires: [],
  permissions: ['prayer_wall:read', 'prayer_wall:moderate'],
  dataClasses: [{ name: 'request', sensitivity: 'standard', retention: 'P2Y' }],
  purgePolicy: {
    onDisable: 'retain',
    retentionAfterDisable: 'P90D',
    purgeStrategy: 'hard_delete',
    auditPurge: true,
  },
  nav: [{ label: 'Prayer', path: '/prayer', requiresPermission: 'prayer_wall:read' }],
  events: { publishes: ['prayer_wall.posted'], consumes: [] },
});
```

The directory name must equal the key. It is what boundary rule C3 greps for and what a
reviewer reads; a manifest that disagrees with its directory makes both of them lie.

**TypeScript only.** This repo runs TS directly with no build step, and a `.js` manifest
fails under the API's SWC hook while transforming fine under vitest — a module that passes
every test and cannot be loaded by the server.

## What is checked at boot, and why

Every rule below is validated when the process starts, and the process refuses to start if
any fails. They are all checked rather than trusted because every consequence is silent at
runtime.

| Rule | What goes wrong without it |
|---|---|
| `key` is snake_case | It is the `mod_<key>_` prefix; a hyphen produces tables the purge path never matches |
| Permissions namespaced `<key>:` | Two modules both declaring `read` collide in one open registry — one module's role granting access to another's data |
| At least one data class | Nothing to retain, export or purge; far more likely the author has not thought about it |
| `onDisable: 'retain'` | Disabling would destroy data. Disabling withdraws access, never data |
| Legal-hold classes exist | A hold naming a class that does not exist holds nothing |
| **No `defaultEnabled` with restricted data** | A module holding minors', financial or pastoral data would arrive switched on. Enabling it must be a deliberate act by an admin who has seen the consent screen |
| Nav permissions are declared | A link every user sees and nobody can follow |
| `requires[]` resolves, no cycles | Two modules requiring each other can never be enabled; the symptom is an admin clicking Enable and nothing happening |

## The two tables

`module_definition` is the catalogue of what this deployment can run — the same for every
tenant, projected from manifests at boot, and therefore **not** tenant-scoped and **not**
under RLS. `church_module` is one row per (church, module) and is tenant data like any
other, RLS-enforced.

Getting that split wrong in either direction is a real bug: RLS on the catalogue hides every
module from everybody, and no RLS on the enablement table lets a church read — or flip —
another church's module state. Both directions have tests.

The sync is an upsert and never a merge: the manifest is the source of truth, and a table
that could diverge from it would leave two answers to "what does this module hold?" with no
rule for which wins. A definition whose module has gone is reported, never deleted — a
church may still hold its data, and `church_module` references the row.

## Entitlement vs enablement

Two different questions with two different remedies (docs/01 §5):

- **Entitled** — does this church's plan cover the module? `church.plan` against
  `module_definition.min_plan`.
- **Enabled** — has an admin turned it on? `church_module.status`.

A module runs only when both are true, and `ModuleStateReader.isAvailable` answers that in
one query. Checking enablement alone would leave a downgraded church using a module its
plan no longer covers until Billing got round to switching it off — the invariant would
depend on a background job remembering, rather than being true by construction.

Losing entitlement never changes stored state. The row still says `enabled`, the data is
untouched, and re-upgrading restores the module with nobody re-enabling anything. A
downgrade must never delete.

`church.plan` is a single column rather than a subscription table. Billing (CORE-033) owns
subscriptions, Stripe, trials and proration, and will drive this column from them — at
which point it is a denormalised projection, which is what the check wants anyway: one
value on a row the query is already reading.

## Consent

Enabling a module that declares **restricted** data requires an explicit
`acknowledgeRestrictedData`. The requirement is derived from the declared data classes
rather than a separate manifest flag, so a module that starts collecting restricted data
starts requiring consent in the same commit, with nothing to remember.

The acknowledgement can obviously be sent blindly by a script; that is what the audit trail
is for. The point is that no church starts collecting minors' or pastoral data because
someone flipped a toggle with no prompt.

## Lifecycle

`ModuleLifecycle` owns the state machine in docs/02 §3: which transitions are legal, that
`requires[]` is satisfied both ways, and when the purge clock starts.

```
enabled ──disable──▶ disabled ──grace──▶ pending_purge ──▶ purged
   ▲                    │                      │
   └────────enable──────┴──────────────────────┘   (re-enabling stops the clock)
```

It checks entitlement and consent as preconditions on `enable`, and reports entitlement
first — a church on the wrong plan should be told that, not walked through requirement
errors for a module it cannot have either way.

It deliberately does **not** own the purge job (CORE-024): this class decides whether a
transition is coherent, not what happens to the rows afterwards.

Every method runs inside a tenant context. Without one, RLS returns nothing rather than
everything: the safe direction, but still a bug, so callers establish the context.

## Reaching a module's routes

`ModuleGuard` in `apps/api` returns **404 `MODULE_NOT_ENABLED`** for any state that is not
`enabled` — disabled, pending purge, purged, and never-heard-of all answer the same way.

It runs after `PolicyGuard`, so permission is checked before existence is revealed: a caller
without the permission gets a 403 that says nothing about the module. The lookup is
deliberately not cached, because docs/02 §3 requires that disabling withdraws routes
immediately and "off" is sometimes a safeguarding decision.

## Tests

| Suite | Covers |
|---|---|
| `test:unit` | Manifest validation and discovery |
| `test:integration` | Catalogue sync against a real database |
| `test:isolation` | `church_module` tenant isolation; the catalogue staying readable |
| `test:module-lifecycle` | The state machine, and the constraints backing it in SQL |

`test:module-lifecycle` is the suite CI demands once any `modules/*` package exists. It runs
against fixture modules so the machinery is covered from the day it was written; a real
module adds its own data-level lifecycle tests on top.
