/**
 * The path prefix every route is served under.
 *
 * This is not a preference: `packages/contracts/openapi/openapi.yaml` declares
 * `servers: [{ url: /api/v1 }]`, and `packages/sdk` documents a base URL ending the same
 * way. The contract is the handoff artifact in this repo — generated types are never
 * edited to match the code — and the same rule applies to the paths the server answers on.
 *
 * It lives in its own file so that `bootstrap()` and the test harness apply the identical
 * value. They previously agreed on nothing, because the harness builds its Nest app
 * directly and never calls `bootstrap()` at all: main.ts is exercised by no test, which is
 * how the server came to serve `/auth/login` while the contract promised
 * `/api/v1/auth/login` for months without anything noticing.
 *
 * Changing this means changing the contract in the same commit.
 */
export const API_PREFIX = 'api/v1';

/** Prefixes a contract path for a request. `/auth/login` → `/api/v1/auth/login`. */
export const apiPath = (path: string): string =>
  `/${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
