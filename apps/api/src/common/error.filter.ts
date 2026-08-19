import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { components } from '@church/contracts';
import { ForbiddenError } from '@church/policy';
import {
  CrossTenantWriteError,
  MissingTenantContextError,
  RlsExemptConnectionError,
} from '@church/tenancy';
import { InvalidAccessTokenError } from '@church/identity';
import { ModuleNotEnabledException } from './module.guard.js';
import { contextOf } from './request-context.js';
import { UndeclaredRouteError } from './policy.guard.js';

type ApiError = components['schemas']['Error'];
type ErrorCode = ApiError['code'];

/**
 * Turns everything thrown anywhere in the app into the one error shape the contract
 * declares, so clients can branch on `code` instead of parsing prose.
 *
 * Two rules this file exists to keep:
 *
 * 1. **Nothing internal reaches the client.** A stack trace, a SQL fragment, or a table
 *    name in a 500 body tells an attacker about the schema. Unmapped failures become a
 *    bare INTERNAL and the detail goes to the log with the request id.
 * 2. **A tenancy bug is never a 4xx.** `CrossTenantWriteError` and
 *    `MissingTenantContextError` mean the server is wrong, not the caller. Reporting them
 *    as 400 would let them sit in a dashboard as client noise for months.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<object>();
    const reply = http.getResponse<{
      status: (code: number) => { send: (body: unknown) => void };
    }>();
    const { requestId } = contextOf(request);

    const { status, code, message, internal } = classify(exception);
    if (status >= 500) {
      this.logger.error(`${code} [${requestId}] ${internal ?? message}`, stackOf(exception));
    }

    const body: ApiError = { code, message, requestId };
    reply.status(status).send(body);
  }
}

interface Classified {
  status: number;
  code: ErrorCode;
  /** Safe to return to the caller. */
  message: string;
  /** Logged, never sent. */
  internal?: string;
}

export function classify(exception: unknown): Classified {
  if (exception instanceof ForbiddenError) {
    // The decision's rule and detail stay in the log: telling a caller *why* they were
    // denied maps out the permission model for them one request at a time.
    return {
      status: 403,
      code: 'FORBIDDEN',
      message: 'You do not have permission to do that',
      internal: `${exception.permission}: ${exception.decision.rule}`,
    };
  }

  if (exception instanceof InvalidAccessTokenError) {
    return { status: 401, code: 'UNAUTHENTICATED', message: 'Invalid or expired credentials' };
  }

  if (
    exception instanceof CrossTenantWriteError ||
    exception instanceof MissingTenantContextError ||
    exception instanceof RlsExemptConnectionError ||
    exception instanceof UndeclaredRouteError
  ) {
    // Server bugs, every one. A cross-tenant write that got as far as the repository is
    // the most serious thing this application can log.
    return {
      status: 500,
      code: 'INTERNAL',
      message: 'Something went wrong',
      internal: `${exception.name}: ${exception.message}`,
    };
  }

  if (exception instanceof ModuleNotEnabledException) {
    // 404 like any other, but with the code the SDK turns into "this feature isn't enabled
    // for your church". Same status line as a route that does not exist, so nothing about
    // the deployment's module set leaks.
    return {
      status: 404,
      code: 'MODULE_NOT_ENABLED',
      message: 'Not found',
      internal: `module ${exception.moduleKey} is not enabled for this tenant`,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      status,
      code: codeForStatus(status),
      message: safeMessage(exception),
      ...(status >= 500 ? { internal: exception.message } : {}),
    };
  }

  return {
    status: 500,
    code: 'INTERNAL',
    message: 'Something went wrong',
    internal:
      exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception),
  };
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
  }
}

/** Nest's own messages are safe; a 5xx body is not. */
function safeMessage(exception: HttpException): string {
  if (exception.getStatus() >= 500) return 'Something went wrong';
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'message' in response) {
    const { message } = response as { message: unknown };
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('; ');
  }
  return exception.message;
}

function stackOf(exception: unknown): string | undefined {
  return exception instanceof Error ? exception.stack : undefined;
}
