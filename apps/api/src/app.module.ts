import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthGuard } from './common/auth.guard.js';
import { ErrorFilter } from './common/error.filter.js';
import { ModuleGuard } from './common/module.guard.js';
import { PolicyGuard } from './common/policy.guard.js';
import { TenantInterceptor } from './common/tenant.interceptor.js';
import { ConfigModule } from './config.module.js';
import { DatabaseModule } from './database.module.js';
import { HealthController } from './health/health.controller.js';
import { ModulesModule } from './modules.module.js';

/**
 * The composition root, and the place the request lifecycle from docs/01 §3 is actually
 * assembled:
 *
 *   AuthGuard          verify the JWT, build the Subject
 *   PolicyGuard        assertCan for the permission the route declares
 *   ModuleGuard        404 MODULE_NOT_ENABLED unless the tenant enabled the module
 *   TenantInterceptor  run the handler inside runWithTenant, so RLS applies
 *   handler
 *   ErrorFilter        map anything thrown to the contract's error envelope
 *
 * Order is not cosmetic. Guards run before interceptors, which is why tenancy is
 * established after authentication rather than before it — the church id comes from the
 * verified token, and there is nothing trustworthy to scope to until the JWT has been
 * checked.
 *
 * ModuleGuard runs after PolicyGuard, so permission is checked before existence is
 * revealed: a caller without the permission learns nothing about whether the module is on.
 *
 * One stage is still missing, and it is not stubbed. **Audit** (CORE-021) writes the
 * append-only record for restricted reads and writes; it belongs as an interceptor inside
 * TenantInterceptor, so entries are written in the same tenant context — and the same
 * transaction — as the work they describe. A placeholder that logged nothing would be
 * worse than its absence, because it would look enforced.
 */
@Module({
  imports: [ConfigModule, DatabaseModule, ModulesModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
    { provide: APP_GUARD, useClass: ModuleGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
