import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { TenantDatabase } from '@church/tenancy';
import { API_CONFIG, PG_POOL } from './common/tokens.js';
import type { ApiConfig } from './config.js';

/** Closes the pool on shutdown so a redeploy does not leave connections behind. */
@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * The database, as the rest of the app sees it: a `TenantDatabase`, never a bare `Pool`.
 *
 * The pool is provided too, because migrations and health checks legitimately need a
 * connection with no tenant, but nothing that serves a request should inject it — going
 * around `TenantDatabase` means going around `SET LOCAL app.current_church_id`, and RLS
 * stops applying.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => new Pool({ connectionString: config.databaseUrl }),
    },
    {
      provide: TenantDatabase,
      inject: [PG_POOL, API_CONFIG],
      useFactory: (pool: Pool, config: ApiConfig) =>
        new TenantDatabase(pool, { appRole: config.appRole }),
    },
    PoolLifecycle,
  ],
  exports: [PG_POOL, TenantDatabase],
})
export class DatabaseModule {}
