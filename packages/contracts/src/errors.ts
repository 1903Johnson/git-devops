import type { components } from './generated/schema.js';

export type ApiError = components['schemas']['Error'];
export type ApiErrorCode = ApiError['code'];

/**
 * Every error code the API may return, as values rather than only as a type — clients
 * branch on these, and a string literal typo is otherwise invisible until runtime.
 */
export const API_ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  MODULE_NOT_ENABLED: 'MODULE_NOT_ENABLED',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const satisfies Record<ApiErrorCode, ApiErrorCode>;

/**
 * Thrown by the SDK when a route belongs to a module this church has not enabled.
 *
 * The wire format is a 404, deliberately indistinguishable from "no such resource", so a
 * caller cannot discover which modules a tenant runs (docs/01 §3). Clients still need to
 * tell the two apart to show "this feature isn't enabled" instead of a crash, which is
 * what this type is for — the distinction lives in the client, never on the wire.
 */
export class ModuleNotEnabledError extends Error {
  readonly code = API_ERROR_CODES.MODULE_NOT_ENABLED;
  constructor(
    readonly path: string,
    readonly requestId?: string,
  ) {
    super(`This feature is not enabled for your church (${path})`);
    this.name = 'ModuleNotEnabledError';
  }
}

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ApiError>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    candidate.code in API_ERROR_CODES
  );
}

export const isModuleNotEnabled = (value: unknown): boolean =>
  isApiError(value) && value.code === API_ERROR_CODES.MODULE_NOT_ENABLED;
