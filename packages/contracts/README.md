# @church/contracts

`openapi/openapi.yaml` is the contract between the backend and every client, and the
handoff artifact of the two-agent workflow (`docs/03` §3). Claude changes it; both agents
build against the types generated from it; neither waits for the other.

## Changing the contract

```bash
# edit openapi/openapi.yaml, then
pnpm run contracts:generate     # rewrites src/generated/schema.ts
pnpm run verify                 # includes contracts:check
```

`src/generated/` is machine-written. `pnpm run contracts:check` regenerates into a temp
directory and fails on any difference, which catches both ways this drifts: a hand-edited
generated file, and a spec change committed without regenerating. Either one leaves the two
agents compiling against different contracts — the exact failure the protocol exists to
prevent, and one that produces no error until integration.

**A contract change is announced in the sprint issue before either agent writes code
against it** (`docs/03` §3). The check catches drift inside the repo; it cannot catch an
agent halfway through a branch built on yesterday's shape.

## Decisions encoded here

**`MODULE_NOT_ENABLED` is a 404, never a 403.** A 403 tells a caller the feature exists for
a tenant that has not enabled it. The client reconstructs the distinction locally, via
`ModuleNotEnabledError`, so the UI can say "not enabled" without the wire format leaking
tenant configuration.

**`CampusCreate` has no `churchId`.** It comes from the authenticated tenant context. A
client that could name the church could create a campus inside another one.

**`ChurchUpdate` has no `status`.** Status is owned by Billing; a church must not be able to
lift its own suspension through the CRUD endpoint.

**Error codes are exported as values, not only types.** Clients compare against string
literals, and a typo in one is invisible until it silently fails to match. A test asserts
the exported set matches the spec's enum exactly.

## What lives where

| Path | |
|---|---|
| `openapi/openapi.yaml` | The contract. The only file to edit. |
| `src/generated/` | Generated types. Never edit. |
| `src/errors.ts` | Error codes as values, `ModuleNotEnabledError`, type guards. |
| `src/helpers.ts` | Convenience aliases and the shared page envelope. |
