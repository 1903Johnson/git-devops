import type { PlanTier } from './manifest.js';
import type { QueryLike } from './registry.js';

/**
 * Plans in ascending order. Entitlement is "is my plan at least the module's minimum?",
 * so the order here is the whole rule — a module on PRO is available to PRO and
 * ENTERPRISE, and to nobody below.
 */
export const PLAN_ORDER: readonly PlanTier[] = ['FREE', 'BASIC', 'PRO', 'ENTERPRISE'];

export const planRank = (plan: PlanTier): number => {
  const rank = PLAN_ORDER.indexOf(plan);
  // An unknown plan ranks below everything rather than above it. A typo in a plan name
  // must lose access, never grant it.
  return rank === -1 ? -1 : rank;
};

export const isEntitled = (plan: PlanTier, minPlan: PlanTier): boolean =>
  planRank(plan) >= 0 && planRank(plan) >= planRank(minPlan);

export interface EntitlementView {
  readonly moduleKey: string;
  readonly minPlan: PlanTier;
  readonly plan: PlanTier;
  readonly entitled: boolean;
}

/**
 * Reads the tenant's plan against a module's minimum, in one query.
 *
 * The church is selected by `app.current_church_id` explicitly rather than left to RLS.
 * Relying on the policy to pick the row looks equivalent and is not: RLS does not apply to
 * superusers, so under a migration, an admin tool, or a test running as the owner the same
 * query joins across *every* church and answers from an arbitrary one. Naming the tenant
 * makes the query mean the same thing whoever runs it.
 */
export async function entitlementFor(
  query: QueryLike,
  moduleKey: string,
): Promise<EntitlementView | undefined> {
  const { rows } = await query.query<{ plan: PlanTier; min_plan: PlanTier }>(
    `SELECT c.plan, d.min_plan
       FROM church c
       CROSS JOIN module_definition d
      WHERE d.key = $1
        AND c.id = current_setting('app.current_church_id', true)::uuid`,
    [moduleKey],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    moduleKey,
    minPlan: row.min_plan,
    plan: row.plan,
    entitled: isEntitled(row.plan, row.min_plan),
  };
}
