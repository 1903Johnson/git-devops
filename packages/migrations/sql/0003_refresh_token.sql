-- Refresh tokens, with rotation and family-based theft detection.
--
-- Rows are never deleted on use, only marked: the used and revoked history is what makes
-- reuse detection possible. A presented token that was already rotated means either a
-- replay or a stolen copy, and the only safe response is to kill the whole family.

CREATE TABLE refresh_token (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id      uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,

  -- Every token descended from one login shares a family. Revoking the family logs out
  -- that device without touching the user's other sessions.
  family_id      uuid NOT NULL,

  -- SHA-256 of the opaque secret. The secret itself is never stored, so a database dump
  -- does not hand over live sessions.
  token_hash     text NOT NULL,

  -- Free-form label from the client, for "log out this device" in the UI. Not trusted for
  -- anything security-relevant: a client can claim any value.
  device_label   text,

  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  -- Set when this token is exchanged for its successor.
  used_at        timestamptz,
  revoked_at     timestamptz,
  revoked_reason text CHECK (revoked_reason IN
                   ('rotated', 'reuse_detected', 'logout', 'logout_all', 'admin', 'expired'))
);

CREATE UNIQUE INDEX refresh_token_hash_key ON refresh_token (token_hash);
CREATE INDEX refresh_token_user_idx ON refresh_token (user_id);
CREATE INDEX refresh_token_family_idx ON refresh_token (family_id);
CREATE INDEX refresh_token_church_id_idx ON refresh_token (church_id);

ALTER TABLE refresh_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_token FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON refresh_token
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_token TO @app_role@;
