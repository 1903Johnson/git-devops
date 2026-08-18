import { type ApiError, isApiError } from '@church/contracts';

/** A non-2xx response, carrying the parsed error envelope when the server sent one. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body?: ApiError,
  ) {
    super(body?.message ?? `Request to ${path} failed with ${status}`);
    this.name = 'ApiRequestError';
  }

  get code(): string | undefined {
    return this.body?.code;
  }

  get requestId(): string | undefined {
    return this.body?.requestId;
  }
}

export const parseErrorBody = (body: unknown): ApiError | undefined =>
  isApiError(body) ? body : undefined;
