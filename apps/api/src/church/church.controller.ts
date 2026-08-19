import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Campus, CampusCreate, CampusUpdate, Church, ChurchUpdate } from '@church/contracts';
import { CampusService, ChurchService, LastCampusError, NotFoundError } from '@church/church';
import { CORE_PERMISSIONS } from '@church/policy';
import { TenantDatabase } from '@church/tenancy';
import { RequiresPermission } from '../common/requires-permission.decorator.js';
import { subjectOf } from '../common/subject.js';

/**
 * Church and campus over HTTP.
 *
 * Thin on purpose. Every decision — what a caller may do, what a church may change about
 * itself, whether a campus can be removed — lives in `@church/church`, so a worker or a job
 * gets the same answers as a request. What is here is the mapping: path to service call,
 * domain error to status code.
 *
 * `churchId` in the path is for routing and validation only. The tenant comes from the
 * token, and the services read it from the ambient context; a caller naming someone else's
 * church in the URL gets their own church's data, not a 403, because there was never a
 * decision to make.
 */
@Controller()
export class ChurchController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly churches: ChurchService,
    private readonly campuses: CampusService,
  ) {}

  @RequiresPermission(CORE_PERMISSIONS.church_read)
  @Get('churches/:churchId')
  async get(): Promise<Church> {
    return this.run(() => this.db.transaction((tx) => this.churches.get(tx, subjectOf())));
  }

  @RequiresPermission(CORE_PERMISSIONS.church_manage)
  @Patch('churches/:churchId')
  async update(@Body() body: ChurchUpdate): Promise<Church> {
    return this.run(() =>
      this.db.transaction((tx) => this.churches.update(tx, subjectOf(), body ?? {})),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.campus_read)
  @Get('churches/:churchId/campuses')
  async listCampuses(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ data: Campus[]; page: { hasMore: boolean; nextCursor?: string } }> {
    const page = await this.run(() =>
      this.db.transaction((tx) =>
        this.campuses.list(tx, subjectOf(), {
          ...(limit ? { limit: Number(limit) } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      ),
    );
    return {
      data: page.data,
      page: {
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      },
    };
  }

  @RequiresPermission(CORE_PERMISSIONS.campus_manage)
  @Post('churches/:churchId/campuses')
  async createCampus(@Body() body: CampusCreate): Promise<Campus> {
    if (!body?.name?.trim()) throw new BadRequestException('name is required');
    return this.run(() => this.db.transaction((tx) => this.campuses.create(tx, subjectOf(), body)));
  }

  @RequiresPermission(CORE_PERMISSIONS.campus_read)
  @Get('campuses/:campusId')
  async getCampus(@Param('campusId') campusId: string): Promise<Campus> {
    return this.run(() =>
      this.db.transaction((tx) => this.campuses.get(tx, subjectOf(), campusId)),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.campus_manage)
  @Patch('campuses/:campusId')
  async updateCampus(
    @Param('campusId') campusId: string,
    @Body() body: CampusUpdate,
  ): Promise<Campus> {
    return this.run(() =>
      this.db.transaction((tx) => this.campuses.update(tx, subjectOf(), campusId, body ?? {})),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.campus_manage)
  @Delete('campuses/:campusId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCampus(@Param('campusId') campusId: string): Promise<void> {
    await this.run(() =>
      this.db.transaction((tx) => this.campuses.remove(tx, subjectOf(), campusId)),
    );
  }

  /**
   * Domain errors to status codes, in one place so two endpoints cannot disagree about
   * what a missing campus looks like.
   */
  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundException('Not found');
      if (error instanceof LastCampusError) throw new ConflictException(error.message);
      throw error;
    }
  }
}
