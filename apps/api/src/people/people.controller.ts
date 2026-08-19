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
import type {
  Family,
  FamilyCreate,
  FamilyMember,
  FamilyMemberCreate,
  MembershipStatus,
  MembershipStatusChange,
  Milestone,
  MilestoneCreate,
  Person,
  PersonCreate,
  PersonUpdate,
} from '@church/contracts';
import {
  AlreadyInFamilyError,
  FamilyNotFoundError,
  FamilyService,
  PersonNotFoundError,
  PersonService,
} from '@church/people';
import { CORE_PERMISSIONS } from '@church/policy';
import { TenantDatabase } from '@church/tenancy';
import { RequiresPermission } from '../common/requires-permission.decorator.js';
import { subjectOf } from '../common/subject.js';

interface PagedPeople {
  data: Person[];
  page: { hasMore: boolean; nextCursor?: string };
}

/**
 * People and families over HTTP.
 *
 * Thin, like the church controller: the rules live in `@church/people`. What this owns is
 * the mapping from path to call and from domain error to status code, in one place so two
 * endpoints cannot disagree about what a missing person looks like.
 */
@Controller()
export class PeopleController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly people: PersonService,
    private readonly families: FamilyService,
  ) {}

  @RequiresPermission(CORE_PERMISSIONS.person_read)
  @Get('churches/:churchId/people')
  async list(@Query() query: Record<string, string | undefined>): Promise<PagedPeople> {
    const page = await this.run(() =>
      this.db.transaction((tx) =>
        this.people.list(tx, subjectOf(), {
          ...(query.limit ? { limit: Number(query.limit) } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.status ? { status: query.status as MembershipStatus } : {}),
          ...(query.campusId ? { campusId: query.campusId } : {}),
          // Absent means false. Only the literal string wins, so `?includeArchived=0`
          // cannot accidentally reveal people who have left.
          ...(query.includeArchived === 'true' ? { includeArchived: true } : {}),
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

  @RequiresPermission(CORE_PERMISSIONS.person_manage)
  @Post('churches/:churchId/people')
  async create(@Body() body: PersonCreate): Promise<Person> {
    if (!body?.firstName?.trim() || !body?.lastName?.trim()) {
      throw new BadRequestException('firstName and lastName are required');
    }
    return this.run(() => this.db.transaction((tx) => this.people.create(tx, subjectOf(), body)));
  }

  @RequiresPermission(CORE_PERMISSIONS.person_read)
  @Get('people/:personId')
  async get(@Param('personId') personId: string): Promise<Person> {
    return this.run(() => this.db.transaction((tx) => this.people.get(tx, subjectOf(), personId)));
  }

  @RequiresPermission(CORE_PERMISSIONS.person_manage)
  @Patch('people/:personId')
  async update(@Param('personId') personId: string, @Body() body: PersonUpdate): Promise<Person> {
    return this.run(() =>
      this.db.transaction((tx) => this.people.update(tx, subjectOf(), personId, body ?? {})),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.person_manage)
  @Delete('people/:personId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archive(@Param('personId') personId: string): Promise<void> {
    await this.run(() =>
      this.db.transaction((tx) => this.people.archive(tx, subjectOf(), personId)),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.person_read)
  @Get('people/:personId/status')
  async history(@Param('personId') personId: string): Promise<MembershipStatusChange[]> {
    return this.run(() =>
      this.db.transaction((tx) => this.people.history(tx, subjectOf(), personId)),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.person_manage)
  @Post('people/:personId/status')
  async changeStatus(
    @Param('personId') personId: string,
    @Body() body: { status?: MembershipStatus; note?: string },
  ): Promise<MembershipStatusChange> {
    if (!body?.status) throw new BadRequestException('status is required');
    return this.run(() =>
      this.db.transaction((tx) =>
        this.people.changeStatus(tx, subjectOf(), personId, body.status!, body.note),
      ),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.person_read)
  @Get('people/:personId/milestones')
  async milestones(@Param('personId') personId: string): Promise<Milestone[]> {
    return this.run(() =>
      this.db.transaction((tx) => this.people.milestones(tx, subjectOf(), personId)),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.person_manage)
  @Post('people/:personId/milestones')
  async recordMilestone(
    @Param('personId') personId: string,
    @Body() body: MilestoneCreate,
  ): Promise<Milestone> {
    if (!body?.type || !body?.occurredOn) {
      throw new BadRequestException('type and occurredOn are required');
    }
    return this.run(() =>
      this.db.transaction((tx) => this.people.recordMilestone(tx, subjectOf(), personId, body)),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.person_read)
  @Get('churches/:churchId/families')
  async listFamilies(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ data: Family[]; page: { hasMore: boolean; nextCursor?: string } }> {
    const page = await this.run(() =>
      this.db.transaction((tx) =>
        this.families.list(tx, subjectOf(), {
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

  @RequiresPermission(CORE_PERMISSIONS.person_manage)
  @Post('churches/:churchId/families')
  async createFamily(@Body() body: FamilyCreate): Promise<Family> {
    if (!body?.name?.trim()) throw new BadRequestException('name is required');
    return this.run(() => this.db.transaction((tx) => this.families.create(tx, subjectOf(), body)));
  }

  @RequiresPermission(CORE_PERMISSIONS.person_read)
  @Get('families/:familyId')
  async getFamily(@Param('familyId') familyId: string): Promise<Family> {
    return this.run(() =>
      this.db.transaction((tx) => this.families.get(tx, subjectOf(), familyId)),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.person_manage)
  @Patch('families/:familyId')
  async renameFamily(
    @Param('familyId') familyId: string,
    @Body() body: { name?: string },
  ): Promise<Family> {
    if (!body?.name?.trim()) throw new BadRequestException('name is required');
    return this.run(() =>
      this.db.transaction((tx) => this.families.rename(tx, subjectOf(), familyId, body.name!)),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.person_manage)
  @Post('families/:familyId/members')
  async addMember(
    @Param('familyId') familyId: string,
    @Body() body: FamilyMemberCreate,
  ): Promise<FamilyMember> {
    if (!body?.personId || !body?.relationship) {
      throw new BadRequestException('personId and relationship are required');
    }
    return this.run(() =>
      this.db.transaction((tx) => this.families.addMember(tx, subjectOf(), familyId, body)),
    );
  }

  @RequiresPermission(CORE_PERMISSIONS.person_manage)
  @Delete('families/:familyId/members/:personId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('familyId') familyId: string,
    @Param('personId') personId: string,
  ): Promise<void> {
    await this.run(() =>
      this.db.transaction((tx) => this.families.removeMember(tx, subjectOf(), familyId, personId)),
    );
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      // A person or family that belongs to another church has already been hidden by RLS,
      // so it arrives here as "not found" — the same answer as one that never existed, and
      // deliberately indistinguishable.
      if (error instanceof PersonNotFoundError || error instanceof FamilyNotFoundError) {
        throw new NotFoundException('Not found');
      }
      if (error instanceof AlreadyInFamilyError) throw new ConflictException(error.message);
      throw error;
    }
  }
}
