import { Controller, Get, Query } from '@nestjs/common';
import type { AuditEntry } from '@church/contracts';
import { AUDIT_PAGE_SIZE, AuditService, type AuditQuery, type Sensitivity } from '@church/audit';
import { CORE_PERMISSIONS } from '@church/policy';
import { TenantDatabase } from '@church/tenancy';
import { RequiresPermission } from '../common/requires-permission.decorator.js';

/**
 * A church reading its own history.
 *
 * `audit:read` rather than a platform-only permission on purpose: a church administrator
 * should be able to answer "who changed this?" without filing a support ticket. RLS keeps
 * the answer to their own church.
 */
@Controller('churches/:churchId/audit')
export class AuditController {
  constructor(private readonly db: TenantDatabase) {}

  @RequiresPermission(CORE_PERMISSIONS.audit_read)
  @Get()
  async list(
    @Query() query: Record<string, string | undefined>,
  ): Promise<{ data: AuditEntry[]; nextCursor?: string }> {
    const limit = Math.min(Number(query.limit) || AUDIT_PAGE_SIZE.default, AUDIT_PAGE_SIZE.max);
    const filters: AuditQuery = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.sensitivity ? { sensitivity: query.sensitivity as Sensitivity } : {}),
      ...(query.since ? { since: new Date(query.since) } : {}),
      ...(query.until ? { until: new Date(query.until) } : {}),
      ...(query.beforeSeq ? { beforeSeq: query.beforeSeq } : {}),
      limit,
    };

    const entries = await this.db.transaction((tx) => new AuditService(tx).list(filters));
    // A cursor only when the page was full. Offering one on a short page invites a client
    // to keep paging past the end of the log.
    const nextCursor = entries.length === limit ? entries.at(-1)?.seq : undefined;
    return { data: entries as AuditEntry[], ...(nextCursor ? { nextCursor } : {}) };
  }
}
