import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../common/tokens.js';
import { Public } from '../common/public.decorator.js';

/**
 * Liveness and readiness.
 *
 * `/health` answers whether the process is up; `/health/ready` answers whether it can
 * actually serve, which means reaching the database. Load balancers need the difference:
 * a process that is alive but cannot reach Postgres should be taken out of rotation, not
 * restarted.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Public()
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; database: 'up' }> {
    await this.pool.query('SELECT 1');
    return { status: 'ok', database: 'up' };
  }
}
