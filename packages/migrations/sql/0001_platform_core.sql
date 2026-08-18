-- Core platform schema: the tenant root and its campuses.
--
-- Every tenant-scoped table in this system follows the shape below. It is not optional
-- decoration: ENABLE without FORCE is bypassed by the table's owner, and a policy without
-- WITH CHECK lets a tenant write rows it cannot read. `pnpm --filter @church/migrations
-- run migrate:test` verifies both against pg_catalog after applying, so a table that skips
-- any part of it fails the build rather than shipping.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tenant root. Scoped by its own id: a church is the isolation boundary, so it has no
-- church_id column of its own (see TENANT_ROOT_TABLES in policy-check.ts).
CREATE TABLE church (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  country      text NOT NULL,
  timezone     text NOT NULL DEFAULT 'UTC',
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('trialing', 'active', 'suspended', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE church ENABLE ROW LEVEL SECURITY;
ALTER TABLE church FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON church
  USING (id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_church_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON church TO @app_role@;

-- A campus is a scoping filter *within* a church, applied by permission. It is never an
-- isolation boundary — that is church_id's job alone (docs/01 §2.3).
CREATE TABLE campus (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id    uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  name         text NOT NULL,
  timezone     text,
  is_primary   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campus_church_id_idx ON campus (church_id);

ALTER TABLE campus ENABLE ROW LEVEL SECURITY;
ALTER TABLE campus FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campus
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON campus TO @app_role@;
