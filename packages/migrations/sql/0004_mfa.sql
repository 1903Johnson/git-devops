-- Multi-factor authentication.
--
-- Required for STAFF, PASTOR, CHURCH_ADMIN, and CAMPUS_ADMIN — the roles that can reach
-- giving records, pastoral cases, and children's data (docs/01 §2.5).

CREATE TABLE mfa_credential (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id          uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,

  -- The shared secret is encrypted at rest, not merely stored. A database dump that
  -- yielded plaintext secrets would let an attacker generate valid codes forever, which
  -- is strictly worse than a password hash leak.
  secret_ciphertext  bytea NOT NULL,
  secret_iv          bytea NOT NULL,
  secret_tag         bytea NOT NULL,

  -- Null until the user proves they can generate a code. Enrolling without confirmation
  -- would lock people out of their own accounts.
  confirmed_at       timestamptz,

  -- Highest time-step already accepted. TOTP codes stay valid for a whole step, so
  -- without this a code observed over a shoulder or phished can be replayed inside its
  -- window.
  last_used_counter  bigint,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mfa_credential_user_key ON mfa_credential (user_id);
CREATE INDEX mfa_credential_church_id_idx ON mfa_credential (church_id);

ALTER TABLE mfa_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_credential FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON mfa_credential
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_credential TO @app_role@;

-- Single-use fallbacks for a lost or wiped device. Hashed, never stored in the clear.
CREATE TABLE mfa_recovery_code (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id   uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_recovery_code_user_idx ON mfa_recovery_code (user_id);
CREATE INDEX mfa_recovery_code_church_id_idx ON mfa_recovery_code (church_id);

ALTER TABLE mfa_recovery_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_code FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON mfa_recovery_code
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_code TO @app_role@;
