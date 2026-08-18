// Request-scoped tenant identity.
//
// The identity is carried in AsyncLocalStorage rather than threaded through every
// function signature. That is a deliberate trade: an implicit dependency in exchange for
// making it impossible to *forget* to pass the tenant down a call chain. Forgetting is
// the failure mode that leaks data between churches, and a missing parameter is far
// easier to miss in review than a missing `runWithTenant` at the edge.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  /** The isolation boundary. Every tenant-scoped row belongs to exactly one. */
  readonly churchId: string;
  /** Scoping filter *within* a church, applied by permission — never an isolation boundary. */
  readonly campusId?: string;
  readonly userId?: string;
  readonly roles?: readonly string[];
}

const storage = new AsyncLocalStorage<TenantContext>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MissingTenantContextError extends Error {
  constructor(operation: string) {
    super(
      `${operation} requires a tenant context. Wrap the request in runWithTenant() at the ` +
        'API boundary — see packages/tenancy/README.md.',
    );
    this.name = 'MissingTenantContextError';
  }
}

/** Runs `fn` with `context` as the ambient tenant for everything it awaits. */
export function runWithTenant<T>(context: TenantContext, fn: () => T): T {
  if (!UUID_RE.test(context.churchId)) {
    // A non-UUID church id means the caller derived it from something untrusted, or from
    // nothing. Either way it must not reach a SET LOCAL.
    throw new TypeError(`churchId must be a UUID, received "${context.churchId}"`);
  }
  return storage.run(context, fn);
}

/** The ambient tenant, or undefined outside a tenant scope. */
export function tryCurrentTenant(): TenantContext | undefined {
  return storage.getStore();
}

/** The ambient tenant. Throws rather than defaulting — there is no safe default here. */
export function currentTenant(operation = 'This operation'): TenantContext {
  const context = storage.getStore();
  if (!context) throw new MissingTenantContextError(operation);
  return context;
}
