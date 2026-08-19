-- The optional-module registry (docs/01 §2.5, docs/02 §3).
--
-- Two tables with deliberately different shapes. `module_definition` is a catalogue of what
-- this deployment knows how to run — the same for every tenant, seeded from manifests at
-- boot, and therefore NOT tenant-scoped and NOT under RLS. `church_module` is one row per
-- (church, module) and is tenant data like any other.
--
-- Getting that split wrong in either direction is a real bug: RLS on the catalogue would
-- hide modules from everyone, and no RLS on the enablement table would let a church read —
-- or flip — another church's module state.

CREATE TABLE module_definition (
  key             text PRIMARY KEY
                  CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name            text NOT NULL,
  version         text NOT NULL,
  min_plan        text NOT NULL
                  CHECK (min_plan IN ('FREE', 'BASIC', 'PRO', 'ENTERPRISE')),

  -- Whether a newly provisioned, entitled church gets this on. Modules touching minors,
  -- money, or confidential records are always false: enabling them is a deliberate act.
  default_enabled boolean NOT NULL DEFAULT false,

  -- Kept as jsonb rather than normalised into child tables. These are a projection of the
  -- manifest, which is the source of truth and lives in the module's own directory; giving
  -- them relational structure here would invite writing to them, and a divergence between
  -- this row and the manifest is a bug with no obvious winner.
  requires        jsonb NOT NULL DEFAULT '[]'::jsonb,
  permissions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_classes    jsonb NOT NULL DEFAULT '[]'::jsonb,
  purge_policy    jsonb NOT NULL,
  nav             jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Readable by the application role, writable only by the migrator/boot process. A running
-- request has no business editing the catalogue, and withholding the grant is how that
-- stays true rather than merely intended.
GRANT SELECT ON module_definition TO @app_role@;

CREATE TABLE church_module (
  church_id     uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  module_key    text NOT NULL REFERENCES module_definition (key) ON DELETE RESTRICT,

  status        text NOT NULL DEFAULT 'disabled'
                CHECK (status IN ('enabled', 'disabled', 'pending_purge', 'purged')),

  enabled_at    timestamptz,
  enabled_by    uuid,
  disabled_at   timestamptz,

  -- When the purge job becomes eligible to run. Set on disable from the module's own
  -- retentionAfterDisable, cleared on re-enable. Disabling never destroys data; this is
  -- the clock that starts, and CORE-024 is what reads it.
  purge_after   timestamptz,
  purged_at     timestamptz,

  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (church_id, module_key),

  CONSTRAINT church_module_enabled_by_fk FOREIGN KEY (church_id, enabled_by)
    REFERENCES app_user (church_id, id) ON DELETE SET NULL (enabled_by),

  -- An enabled row must say when and a purged row must say when. Without this the state
  -- column drifts from the timestamps and every later audit question becomes guesswork.
  CONSTRAINT church_module_enabled_has_timestamp
    CHECK (status <> 'enabled' OR enabled_at IS NOT NULL),
  CONSTRAINT church_module_purged_has_timestamp
    CHECK (status <> 'purged' OR purged_at IS NOT NULL)
);

CREATE INDEX church_module_church_id_idx ON church_module (church_id);
-- Drives the purge job's "what is due?" scan without a sequential scan over every tenant.
CREATE INDEX church_module_purge_due_idx ON church_module (purge_after)
  WHERE status IN ('disabled', 'pending_purge');

ALTER TABLE church_module ENABLE ROW LEVEL SECURITY;
ALTER TABLE church_module FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON church_module
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON church_module TO @app_role@;
