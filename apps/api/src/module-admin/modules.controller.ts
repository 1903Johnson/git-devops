import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import type { ChurchModule, ModuleEnableRequest } from '@church/contracts';
import { ModuleLifecycleError } from '@church/module-kit';
import { CORE_PERMISSIONS } from '@church/policy';
import { currentTenant } from '@church/tenancy';
import { RequiresPermission } from '../common/requires-permission.decorator.js';
import { ModulesService } from './modules.service.js';
import { PlanUpgradeRequiredException } from '../common/plan-upgrade.exception.js';

/**
 * Administering which modules a church runs.
 *
 * The directory is `module-admin`, not `modules`, deliberately. Both boundary checkers key
 * on the word "modules" to enforce C1 — core must not import from an optional module — and
 * ESLint's version is a glob on the literal import string, so it cannot tell
 * `./modules/x` (core, fine) from `../../modules/x` (an optional module, not fine). Naming
 * this directory after what it does removes the ambiguity for the tooling and the reader
 * at once.
 *
 * Core routes, not module routes: they carry no `@RequiresModule()`, because the endpoint
 * that turns a module on obviously cannot require it to already be on.
 */
@Controller('churches/:churchId/modules')
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  @RequiresPermission(CORE_PERMISSIONS.module_manage)
  @Get()
  async list(): Promise<{ data: ChurchModule[] }> {
    return { data: await this.modules.list() };
  }

  @RequiresPermission(CORE_PERMISSIONS.module_manage)
  @Post(':moduleKey/enable')
  async enable(
    @Param('moduleKey') moduleKey: string,
    @Body() body: ModuleEnableRequest | undefined,
  ): Promise<ChurchModule> {
    const { userId } = currentTenant();
    return this.run(() =>
      this.modules.enable(moduleKey, {
        ...(userId ? { enabledBy: userId } : {}),
        ...(body?.acknowledgeRestrictedData !== undefined
          ? { acknowledgeRestrictedData: body.acknowledgeRestrictedData }
          : {}),
        ...(body?.settings ? { settings: body.settings } : {}),
      }),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.module_manage)
  @Post(':moduleKey/disable')
  async disable(@Param('moduleKey') moduleKey: string): Promise<ChurchModule> {
    return this.run(() => this.modules.disable(moduleKey));
  }

  /**
   * Maps the lifecycle's refusals onto HTTP.
   *
   * Each code gets the status whose remedy matches: an upgrade, a prompt, or turning
   * something else on first. Collapsing them into one 400 would leave the client unable to
   * tell the admin what to actually do.
   */
  private async run(action: () => Promise<ChurchModule>): Promise<ChurchModule> {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ModuleLifecycleError)) throw error;
      switch (error.code) {
        case 'UNKNOWN_MODULE':
          throw new NotFoundException('No such module');
        case 'NOT_ENTITLED':
          throw new PlanUpgradeRequiredException(error.message);
        case 'CONSENT_REQUIRED':
          throw new BadRequestException(error.message);
        case 'MISSING_REQUIREMENT':
        case 'REQUIRED_BY_ANOTHER':
        case 'INVALID_TRANSITION':
          throw new ConflictException(error.message);
        default:
          throw new ForbiddenException('Not permitted');
      }
    }
  }
}
