-- Authentication identities.
--
-- app_user is tenant-scoped like every other table, but authentication itself is not: the
-- email lookup that begins a login happens before any church is known. That tension is
-- resolved in the application layer (packages/identity/README.md), never by weakening the
-- policy here.

CREATE TABLE app_user (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id            uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  email                text NOT NULL,
  -- Null for SSO-only accounts, which carry no local credential to verify.
  password_hash        text,
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disabled')),
  failed_login_count   integer NOT NULL DEFAULT 0,
  -- Set while a lockout is in force. Null means never locked; a past value means expired.
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Globally unique, deliberately: one email is one account at one church. A unique index is
-- not subject to RLS, so a duplicate registration would otherwise reveal that an address
-- exists *somewhere* on the platform. The registration service returns a neutral result
-- instead of surfacing the violation, so the leak stops at the database boundary.
CREATE UNIQUE INDEX app_user_email_key ON app_user (lower(email));
CREATE INDEX app_user_church_id_idx ON app_user (church_id);

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app_user
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON app_user TO @app_role@;
