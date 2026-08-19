import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Pool } from 'pg';
import { type LoadedModule, loadModules, syncModuleDefinitions } from '@church/module-kit';
import { registerPermissions, type Permission } from '@church/policy';
import { AuditController } from './audit/audit.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { ModulesController } from './module-admin/modules.controller.js';
import { ModulesService } from './module-admin/modules.service.js';
import { API_CONFIG, LOADED_MODULES, PG_POOL } from './common/tokens.js';
import type { ApiConfig } from './config.js';

/**
 * Reads every module manifest at boot, registers their permissions, and projects them into
 * `module_definition`.
 *
 * Boot-time rather than lazy on purpose. An invalid manifest, a requirement no module
 * provides, a permission that is not namespaced — every one of those is silent at runtime
 * and obvious at startup, so the process refuses to start rather than serving requests that
 * quietly deny or quietly allow.
 *
 * The sync is an idempotent upsert, so several replicas booting at once is fine.
 */
@Injectable()
export class ModuleBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(ModuleBootstrap.name);

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LOADED_MODULES) private readonly modules: LoadedModule[],
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const { manifest } of this.modules) {
      registerPermissions(manifest.permissions as Permission[]);
    }

    const client = await this.pool.connect();
    try {
      const result = await syncModuleDefinitions(
        client,
        this.modules.map((module) => module.manifest),
      );
      this.logger.log(
        `modules: ${result.inserted.length} added, ${result.updated.length} updated` +
          (result.orphaned.length > 0 ? `, ${result.orphaned.length} orphaned` : ''),
      );
      for (const key of result.orphaned) {
        // Not an error — a deployment may legitimately be retiring a module — but it means
        // churches may still hold data for something no code can serve any more.
        this.logger.warn(`module_definition "${key}" has no manifest in this deployment`);
      }
    } finally {
      client.release();
    }
    void this.config;
  }
}

@Module({
  providers: [
    {
      provide: LOADED_MODULES,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => loadModules(config.modulesDir),
    },
    ModuleBootstrap,
    ModulesService,
    AuthService,
  ],
  controllers: [ModulesController, AuthController, AuditController],
  exports: [LOADED_MODULES],
})
export class ModulesModule {}
