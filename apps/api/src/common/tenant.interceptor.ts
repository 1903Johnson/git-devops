import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithTenant } from '@church/tenancy';
import { contextOf } from './request-context.js';

/**
 * Runs the handler inside the request's tenant context, so every query underneath it sets
 * `app.current_church_id` and RLS applies.
 *
 * An interceptor rather than middleware, because the church id comes from the verified
 * token and middleware runs before guards — establishing tenancy there would mean parsing
 * the JWT twice, once unverified. Interceptors run after guards and wrap the handler, which
 * is exactly the shape AsyncLocalStorage needs.
 *
 * The subscription is deliberately made *inside* `runWithTenant`: the handler executes on
 * subscribe, so subscribing outside would run it with no context at all.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<object>();
    const { subject } = contextOf(request);
    if (!subject) return next.handle();

    return new Observable((subscriber) => {
      runWithTenant(
        {
          churchId: subject.churchId,
          userId: subject.userId,
          roles: subject.roles,
          ...(subject.campusId ? { campusId: subject.campusId } : {}),
        },
        () => {
          next.handle().subscribe(subscriber);
        },
      );
    });
  }
}
