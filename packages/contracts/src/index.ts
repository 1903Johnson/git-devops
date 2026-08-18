// The contract between the backend and every client, and the handoff artifact between the
// two agents (docs/03 §3). Claude changes `openapi/openapi.yaml`; both agents build
// against what is generated from it.
//
// `src/generated/` is machine-written and must never be hand-edited — `pnpm run
// contracts:check` regenerates and fails on any difference.

export type { components, operations, paths } from './generated/schema.js';
export * from './errors.js';
export * from './helpers.js';
