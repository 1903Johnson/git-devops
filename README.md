# Church Management Platform

A multi-tenant SaaS for churches: people, groups, events, giving, communications, and a set
of **optional modules** — including Children's Check-in — that each church turns on only if
it wants them.

Built collaboratively by two agents, **Claude** and **Codex**, working in parallel in this
repository. The ownership split, contract-first protocol, and per-ticket assignments are
documented below.

## Documentation

| Doc | Read it for |
|---|---|
| [`docs/00-review-and-decisions.md`](docs/00-review-and-decisions.md) | What changed from the original architecture and why; decision log |
| [`docs/01-architecture.md`](docs/01-architecture.md) | Revised system architecture: core vs. optional modules |
| [`docs/02-module-system.md`](docs/02-module-system.md) | The optional-module contract; Children's Check-in as reference implementation |
| [`docs/03-repo-and-workflow.md`](docs/03-repo-and-workflow.md) | Monorepo layout, branching, CI, the two-agent workflow |
| [`docs/04-delivery-plan.md`](docs/04-delivery-plan.md) | Sprint plan with per-ticket ownership (Claude vs Codex) |

## Headline decisions

- **Multi-tenant from day one**, isolated at three layers: PostgreSQL Row-Level Security,
  application tenant context, and mandatory tenant-isolation tests in CI.
- **Modular monolith** (NestJS/TypeScript) — microservices are a scaling decision, not a
  starting architecture.
- **Children's Check-in is an optional module, off by default**, gated by plan entitlement
  and explicit admin opt-in, with its own permission scope, encrypted medical notes, and a
  documented disable/purge path. Data you never collect is data you can never leak.
- **Contract-first development**: `packages/contracts` is the handoff artifact between the
  two agents, so both can build simultaneously without waiting on each other.

## Status

Planning complete; implementation starts at Sprint 0 in
[`docs/04-delivery-plan.md`](docs/04-delivery-plan.md).
