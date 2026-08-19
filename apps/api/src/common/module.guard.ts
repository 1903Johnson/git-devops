import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModuleStateReader } from '@church/module-kit';
import { TenantDatabase, runWithTenant } from '@church/tenancy';
import { REQUIRED_MODULE } from './requires-module.decorator.js';
import { contextOf } from './request-context.js';

/**
 * Withholds a module's routes from tenants that have not enabled it.
 *
 * **404, never 403** (docs/01 §3). A 403 says "this exists and you may not have it", which
 * tells a caller which modules a deployment supports and which of them their church has
 * not bought. 404 says "there is nothing here", and is indistinguishable from a route that
 * does not exist — the same answer a disabled module and an imaginary one both deserve.
 *
 * Runs after `PolicyGuard`, so permission is checked before existence is revealed.
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const moduleKey = this.reflector.getAllAndOverride<string>(REQUIRED_MODULE, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Core routes carry no module key and are unaffected.
    if (!moduleKey) return true;

    const request = context.switchToHttp().getRequest<object>();
    const { subject } = contextOf(request);
    if (!subject) throw new NotFoundException('Not found');

    // Guards run before TenantInterceptor, so this establishes its own context rather than
    // reading church_module unscoped. Doing it the other way — querying by church id
    // outside RLS — would put a cross-tenant read in the one place that decides access.
    const enabled = await runWithTenant({ churchId: subject.churchId }, () =>
      this.db.transaction(async (tx) => new ModuleStateReader(tx).isEnabled(moduleKey)),
    );

    if (!enabled) {
      // Deliberately not cached. docs/02 §3 requires that disabling withdraws routes
      // immediately; a TTL cache would leave a module reachable for the length of the TTL
      // after an admin turned it off, and "off" is sometimes a safeguarding decision.
      throw new ModuleNotEnabledException(moduleKey);
    }
    return true;
  }
}

/**
 * A 404 that the error filter renders with `MODULE_NOT_ENABLED` rather than `NOT_FOUND`.
 *
 * The distinction is for the client, not the attacker: both get 404, but the SDK turns this
 * code into "this feature isn't enabled for your church" instead of a dead end. The status
 * line is identical either way.
 */
export class ModuleNotEnabledException extends NotFoundException {
  constructor(readonly moduleKey: string) {
    super('Not found');
  }
}
