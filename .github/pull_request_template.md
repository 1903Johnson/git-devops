## What & why

<!-- Ticket ID + one paragraph. Link the sprint issue. -->

Ticket: <!-- e.g. MOD-052 -->
Agent: <!-- Claude | Codex -->

## Changes

<!-- Bullet the substantive changes. Skip the noise. -->

## Checks

- [ ] Stays inside my CODEOWNERS zone (or the cross-zone change was agreed in an issue)
- [ ] Rebased on `main`
- [ ] Contract changes (if any) landed in a separate, announced `packages/contracts` PR
- [ ] Unit + integration tests added/updated
- [ ] Tenant-isolation test covers any new tenant-scoped table or endpoint

## Optional-module checklist (delete if not a module PR)

- [ ] No reference to the module key outside `modules/<key>/`
- [ ] Tables prefixed `mod_<key>_`, RLS-scoped by `church_id`
- [ ] Every route behind `@RequiresModule()` + module-scoped permission
- [ ] Disabled tenant gets `404 MODULE_NOT_ENABLED` (tested)
- [ ] Enable / disable / purge paths implemented and tested
- [ ] Nav emitted from manifest, not hardcoded in a client

## Security-sensitive? (delete if not)

- [ ] Touches auth, tenancy, encryption, secrets, payments, minors' data, or pastoral records
- [ ] Audit entries written for restricted-class reads/writes
- [ ] Requires Claude's approval before merge
