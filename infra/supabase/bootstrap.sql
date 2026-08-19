-- One-time bootstrap for a Supabase-hosted database.
--
-- Run this ONCE per project, as `postgres`, BEFORE the migrations. It creates the login
-- role the application connects as; the migrations create the privilege-holding role and
-- grant it every table (see the `@app_role@` lines in packages/migrations/sql).
--
-- Why two roles rather than one:
--
--   church_app   logs in. Holds no privileges of its own.
--   app_church   holds the table grants. Cannot log in at all.
--
-- TenantDatabase issues `SET LOCAL ROLE app_church` inside every transaction, which
-- Postgres permits only between roles that are members of one another — hence the GRANT
-- at the end. Splitting them means a leaked connection string is not by itself a leaked
-- set of privileges, and it keeps the deployed shape identical to the one the isolation
-- suites run against, where the tests also assume a role rather than connect as one.
--
-- What must NOT be true of either role: superuser, or BYPASSRLS. Row-level security is
-- simply not applied to those, so the entire tenant boundary would silently cease to
-- exist while every query kept working. `TenantDatabase.assertNotRlsExempt()` refuses to
-- boot in that state; the final block here checks it before you ever get that far.

\set ON_ERROR_STOP on

-- Replace before running. A generated value, not one anybody types from memory.
\set app_password 'CHANGE-ME-BEFORE-RUNNING'

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'church_app') THEN
    EXECUTE format('CREATE ROLE church_app LOGIN PASSWORD %L', :'app_password');
  ELSE
    EXECUTE format('ALTER ROLE church_app LOGIN PASSWORD %L', :'app_password');
  END IF;
END $$;

-- Neither role may create objects in public: the schema belongs to the migrations, and an
-- application that can create a table can create one without RLS on it.
REVOKE CREATE ON SCHEMA public FROM church_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO church_app;

COMMIT;

-- The migrations create app_church (as APP_DB_ROLE) and grant it the tables. Run them
-- now, then come back and run the rest of this file:
--
--   APP_DB_ROLE=app_church DATABASE_URL='postgresql://postgres:...@...:5432/postgres' \
--     pnpm --filter @church/migrations run migrate:test
--
-- Everything below fails loudly if that has not happened yet, which is the point.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_church') THEN
    RAISE EXCEPTION 'app_church does not exist — run the migrations with APP_DB_ROLE=app_church first';
  END IF;
END $$;

GRANT app_church TO church_app;

-- Refuse to finish in a configuration where RLS would not apply. Cheaper to fail here
-- than to discover it from one church reading another church's children's records.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO offending
    FROM pg_roles
   WHERE rolname IN ('church_app', 'app_church')
     AND (rolsuper OR rolbypassrls);

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'RLS would not apply to: %. Remove SUPERUSER/BYPASSRLS before deploying.', offending;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public'
       AND tableowner IN ('church_app', 'app_church')
  ) THEN
    RAISE EXCEPTION 'The application roles own tables. An owner bypasses RLS unless the table is FORCE''d; do not rely on that here.';
  END IF;
END $$;
