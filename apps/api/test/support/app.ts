import { Controller, Get, Param } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { CORE_PERMISSIONS } from '@church/policy';
import { TenantDatabase, currentTenant } from '@church/tenancy';
import { type AccessTokenClaims, type KeyRing, issueAccessToken } from '@church/identity';
import { APP_ROLE } from '@church/testing';
import { loadModules } from '@church/module-kit';
import { AuthGuard } from '../../src/common/auth.guard.js';
import { ModuleGuard } from '../../src/common/module.guard.js';
import { ErrorFilter } from '../../src/common/error.filter.js';
import { PolicyGuard } from '../../src/common/policy.guard.js';
import { Public } from '../../src/common/public.decorator.js';
import { RequiresModule } from '../../src/common/requires-module.decorator.js';
import { RequiresPermission } from '../../src/common/requires-permission.decorator.js';
import { TenantInterceptor } from '../../src/common/tenant.interceptor.js';
import { API_CONFIG, LOADED_MODULES, PG_POOL } from '../../src/common/tokens.js';
import { ModulesController } from '../../src/module-admin/modules.controller.js';
import { ModulesService } from '../../src/module-admin/modules.service.js';
import type { ApiConfig } from '../../src/config.js';

export const TEST_KEYS: KeyRing = {
  active: { kid: 'test-1', secret: new Uint8Array(32).fill(7) },
  accepted: [],
};

/**
 * Routes that exist only to exercise the lifecycle. They live here rather than in `src`
 * because the scaffold should not ship endpoints nobody asked for — but the guards,
 * interceptor and filter are the real ones, wired exactly as `AppModule` wires them.
 */
@Controller('probe')
class ProbeController {
  constructor(private readonly db: TenantDatabase) {}

  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }

  /** Reports the tenant the handler is running under, to prove the interceptor works. */
  @RequiresPermission(CORE_PERMISSIONS.church_read)
  @Get('tenant')
  tenant(): { churchId: string; userId?: string } {
    const context = currentTenant();
    return { churchId: context.churchId, ...(context.userId ? { userId: context.userId } : {}) };
  }

  /** A real tenant-scoped read, so RLS is genuinely in the path. */
  @RequiresPermission(CORE_PERMISSIONS.campus_read)
  @Get('campuses')
  async campuses(): Promise<{ ids: string[] }> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>('SELECT id FROM campus ORDER BY id');
      return { ids: rows.map((row) => row.id) };
    });
  }

  @RequiresPermission(CORE_PERMISSIONS.church_manage)
  @Get('privileged')
  privileged(): { ok: true } {
    return { ok: true };
  }

  /** Declares neither @Public() nor @RequiresPermission() — must be refused, not allowed. */
  @Get('undeclared')
  undeclared(): { ok: true } {
    return { ok: true };
  }

  @RequiresPermission(CORE_PERMISSIONS.church_read)
  @Get('boom/:kind')
  boom(@Param('kind') kind: string): never {
    throw kind === 'plain'
      ? new Error('a plain failure with SELECT secrets internals')
      : new Error(kind);
  }
}

/** A module-scoped controller, to exercise ModuleGuard the way a real module would. */
@Controller('probe/module')
@RequiresModule('good_module')
class ModuleProbeController {
  @RequiresPermission(CORE_PERMISSIONS.church_read)
  @Get('thing')
  thing(): { ok: true } {
    return { ok: true };
  }
}

export interface TestApp {
  app: NestFastifyApplication;
  pool: Pool;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString, max: 4 });
  const config: ApiConfig = {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: connectionString,
    appRole: APP_ROLE,
    keys: TEST_KEYS,
    modulesDir: new URL('../../../../packages/module-kit/test/fixtures/', import.meta.url).pathname,
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController, ModuleProbeController, ModulesController],
    providers: [
      { provide: API_CONFIG, useValue: config },
      { provide: LOADED_MODULES, useFactory: () => loadModules(config.modulesDir) },
      ModulesService,
      { provide: PG_POOL, useValue: pool },
      {
        provide: TenantDatabase,
        useFactory: () => new TenantDatabase(pool, { appRole: APP_ROLE }),
      },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_GUARD, useClass: PolicyGuard },
      { provide: APP_GUARD, useClass: ModuleGuard },
      { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    // Quiet by default; TEST_LOGS=1 turns Nest's logger back on. Without it a handler that
    // 500s in a test reports only the status, and the ErrorFilter's whole job is to keep
    // the cause out of the response body.
    ...(process.env.TEST_LOGS ? {} : { logger: false as const }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export async function tokenFor(claims: AccessTokenClaims): Promise<string> {
  return issueAccessToken(claims, TEST_KEYS);
}

/** Fastify's inject: a real request through the real pipeline, no socket needed. */
export async function get(
  app: NestFastifyApplication,
  url: string,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'GET',
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  return { status: response.statusCode, body: JSON.parse(response.body || '{}') };
}
