-- The audit log. Append-only, tenant-scoped, and readable by a church's own administrators.
--
-- Two things make this table different from every other one in the schema:
--
-- 1. The application role holds SELECT and INSERT and nothing else. Not "we don't update
--    it" as a convention — no request this application can serve has the privilege to
--    rewrite or erase a line of it. That is the whole value of an audit log: it is only
--    evidence if the code under investigation could not have edited it.
--
-- 2. A trigger refuses UPDATE outright, including from the table owner. Grants stop the
--    application; the trigger stops a migration, a console session, and anyone who has
--    talked their way into the owner role. There is deliberately no matching DELETE
--    trigger: deleting a church must still cascade, and retention pruning is a real
--    obligation later. Deletion is therefore possible for the operator and impossible for
--    the product, which is the line that matters.

CREATE TABLE audit_entry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Total order, and what pagination walks. Timestamps alone cannot do this job:
  -- `now()` is transaction-start time in Postgres, so every entry written inside one
  -- transaction shares it exactly — and several usually are, because an audit line is
  -- written in the same transaction as the work. Ordering by timestamp then puts them in
  -- arbitrary order, and a timestamp cursor either repeats them or skips them.
  seq           bigserial NOT NULL UNIQUE,

  church_id     uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  -- clock_timestamp(), not now(): the moment this line was written rather than the moment
  -- its transaction opened. Ordering does not depend on it, but a reader does.
  occurred_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- Null for actions the platform took by itself: a scheduled purge, a downgrade applied
  -- by billing. Null means "no human", never "we didn't record who".
  actor_user_id uuid,
  -- Snapshot of the roles held at the time. The role assignment may change afterwards, and
  -- an audit line has to say what was true when it happened, not what is true now.
  actor_roles   text[] NOT NULL DEFAULT '{}',

  -- Dotted and past tense: `module.enabled`, `person.updated`, `medical_note.read`.
  action        text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  resource_type text NOT NULL,
  -- Text rather than uuid: some resources are keyed by string, like a module key.
  resource_id   text,
  campus_id     uuid,

  -- `restricted` marks the classes docs/02 requires an access record for — medical notes,
  -- pastoral records, giving. Reads of those are audited as well as writes.
  sensitivity   text NOT NULL DEFAULT 'standard'
                CHECK (sensitivity IN ('standard', 'restricted')),

  -- The change itself. Both null for a read. Values are redacted before they get here:
  -- an audit log that stores password hashes and TOTP secrets has turned the record of a
  -- breach into a second breach.
  before        jsonb,
  after         jsonb,
  changed_fields text[] NOT NULL DEFAULT '{}',

  -- Free-text justification, for actions that demand one — a staff override, a force
  -- close, a purge.
  reason        text,
  -- Ties a line back to the request that produced it, and to the application logs.
  request_id    text,

  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_entry_church_seq_idx ON audit_entry (church_id, seq DESC);
CREATE INDEX audit_entry_actor_idx ON audit_entry (church_id, actor_user_id, seq DESC);
CREATE INDEX audit_entry_resource_idx ON audit_entry (church_id, resource_type, resource_id);
-- Restricted-class access is what an investigation starts from, so it gets its own index
-- rather than a filter over everything.
CREATE INDEX audit_entry_restricted_idx ON audit_entry (church_id, seq DESC)
  WHERE sensitivity = 'restricted';

CREATE OR REPLACE FUNCTION audit_entry_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_entry is append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_entry_no_update
  BEFORE UPDATE ON audit_entry
  FOR EACH ROW EXECUTE FUNCTION audit_entry_is_append_only();

ALTER TABLE audit_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_entry
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);

-- SELECT and INSERT only. The omission is the feature.
GRANT SELECT, INSERT ON audit_entry TO @app_role@;
GRANT USAGE ON SEQUENCE audit_entry_seq_seq TO @app_role@;
