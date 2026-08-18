// Tenant-policy coverage, checked against the live database.
//
// This is the layer the boundary check cannot reach. `scripts/check-boundaries.mjs` rule C5
// greps migration SQL for `ENABLE ROW LEVEL SECURITY`, which catches the obvious omission
// and nothing else: a policy that is enabled but not FORCE'd, a USING clause comparing the
// wrong column, or a policy dropped by a later migration all pass C5 and fail in
// production. Here the questions are asked of pg_catalog after the migrations have run,
// so what is checked is what actually exists.

import type { PoolClient } from 'pg';

/**
 * Tables that are tenant-scoped by their own `id` rather than a `church_id` column.
 *
 * `church` is the tenant root: its primary key *is* the tenant boundary. It still needs a
 * policy — a church must not read another church's row — but keyed on `id`.
 */
export const TENANT_ROOT_TABLES = new Set(['church']);

/**
 * Tables exempt from tenant scoping entirely. Each entry needs a reason, and the reason
 * must be "this data is genuinely platform-wide", never "the test was failing".
 */
export const PLATFORM_TABLES = new Set([
  'schema_migrations', // deployment metadata, not customer data
]);

export interface PolicyGap {
  readonly table: string;
  readonly problem: string;
}

interface TableRow {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  has_church_id: boolean;
  policy_count: number;
  policies_with_check: number;
  policy_expressions: string | null;
}

/**
 * Returns every tenant-scoped table whose protection is incomplete. Empty means every
 * table in the schema either carries a correct policy or is a documented exemption.
 */
export async function findPolicyGaps(client: PoolClient): Promise<PolicyGap[]> {
  const { rows } = await client.query<TableRow>(`
    SELECT
      c.relname AS table_name,
      c.relrowsecurity AS rls_enabled,
      c.relforcerowsecurity AS rls_forced,
      EXISTS (
        SELECT 1 FROM information_schema.columns col
         WHERE col.table_name = c.relname AND col.column_name = 'church_id'
      ) AS has_church_id,
      (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policy_count,
      (SELECT count(*) FROM pg_policy p
        WHERE p.polrelid = c.oid AND p.polwithcheck IS NOT NULL)::int AS policies_with_check,
      (SELECT string_agg(pg_get_expr(p.polqual, p.polrelid), ' ')
         FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_expressions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const gaps: PolicyGap[] = [];

  for (const row of rows) {
    const table = row.table_name;
    if (PLATFORM_TABLES.has(table)) continue;

    const isTenantRoot = TENANT_ROOT_TABLES.has(table);
    if (!row.has_church_id && !isTenantRoot) {
      gaps.push({
        table,
        problem:
          'has no church_id column and is not a declared tenant-root or platform table. ' +
          'Add church_id, or declare the exemption in policy-check.ts with a reason.',
      });
      continue;
    }

    if (!row.rls_enabled) gaps.push({ table, problem: 'row level security is not enabled' });
    if (!row.rls_forced)
      gaps.push({
        table,
        problem: "row level security is not FORCE'd, so the table owner bypasses every policy",
      });
    if (row.policy_count === 0) {
      gaps.push({
        table,
        problem: 'RLS is on but no policy is defined, so the table is unreadable',
      });
      continue;
    }
    if (row.policies_with_check === 0)
      gaps.push({
        table,
        problem: 'no policy carries a WITH CHECK clause, so a tenant can write rows it cannot read',
      });

    // The policy must actually compare the tenant column to the session setting. A policy
    // of USING (true) satisfies every structural check above and protects nothing.
    const expressions = row.policy_expressions ?? '';
    const expectedColumn = isTenantRoot ? 'id' : 'church_id';
    if (!expressions.includes('app.current_church_id')) {
      gaps.push({
        table,
        problem: `policy does not reference current_setting('app.current_church_id')`,
      });
    } else if (!expressions.includes(expectedColumn)) {
      gaps.push({ table, problem: `policy does not constrain ${expectedColumn}` });
    }
  }

  return gaps;
}

export async function assertPolicyCoverage(client: PoolClient): Promise<void> {
  const gaps = await findPolicyGaps(client);
  if (gaps.length > 0) {
    throw new Error(
      `tenant policy coverage failed for ${gaps.length} table(s):\n` +
        gaps.map((g) => `  ${g.table}: ${g.problem}`).join('\n'),
    );
  }
}
