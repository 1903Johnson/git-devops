import createClient, { type Middleware } from 'openapi-fetch';
import { API_ERROR_CODES, ModuleNotEnabledError, type paths } from '@church/contracts';
import { ApiRequestError, parseErrorBody } from './errors.js';

export interface ClientOptions {
  /** Base URL including the version prefix, e.g. https://api.example.org/api/v1 */
  readonly baseUrl: string;
  /**
   * Called before every request. A function rather than a string because access tokens are
   * short-lived (15 minutes, per docs/01 §2.5) — a captured token would silently start
   * failing partway through a session.
   */
  readonly getAccessToken?: () => string | undefined | Promise<string | undefined>;
  readonly fetch?: typeof globalThis.fetch;
}

export type ChurchClient = ReturnType<typeof createChurchClient>;

/**
 * Builds the typed client.
 *
 * Errors are raised rather than returned. openapi-fetch hands back `{ data, error }`, but
 * that shape makes the unhappy path easy to ignore — and here the unhappy path includes a
 * module being disabled, which the UI must render deliberately.
 */
export function createChurchClient(options: ClientOptions) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const auth: Middleware = {
    async onRequest({ request }) {
      const token = await options.getAccessToken?.();
      if (token) request.headers.set('Authorization', `Bearer ${token}`);
      return request;
    },
  };

  client.use(auth);

  return {
    raw: client,

    /** Unwraps a response, converting a failure into a typed throw. */
    unwrap<T>(result: { data?: T; error?: unknown; response: Response }, path: string): T {
      if (result.error !== undefined || !result.response.ok) {
        const body = parseErrorBody(result.error);
        if (body?.code === API_ERROR_CODES.MODULE_NOT_ENABLED) {
          throw new ModuleNotEnabledError(path, body.requestId);
        }
        throw new ApiRequestError(result.response.status, path, body);
      }
      return result.data as T;
    },
  };
}
