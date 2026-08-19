import { ForbiddenException } from '@nestjs/common';

/**
 * A 403 the error filter renders with `PLAN_UPGRADE_REQUIRED` rather than `FORBIDDEN`.
 *
 * Separate from an ordinary denial because the two need different screens: "ask your
 * administrator for access" and "your plan does not include this" are different problems
 * with different remedies, and collapsing them makes the upgrade path unreachable from the
 * UI. Unlike a module's existence, a church's own plan is not a secret from its own admin.
 */
export class PlanUpgradeRequiredException extends ForbiddenException {
  constructor(readonly detail: string) {
    super('Your plan does not include this module');
  }
}
