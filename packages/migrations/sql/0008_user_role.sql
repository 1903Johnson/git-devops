-- Role assignment. The missing link between identity and authorization.
--
-- packages/policy has known the roles and their permissions since CORE-020, the API guard
-- has read roles off the access token since CORE-018, and the token has carried an empty
-- array the whole time because nothing stored them. Every permission-guarded route would
-- have denied every real user — an authorization system that is perfectly correct and
-- entirely inert.

CREATE TABLE user_role (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id  uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,

  role       text NOT NULL
             CHECK (role IN ('MEMBER', 'VOLUNTEER', 'GROUP_LEADER', 'STAFF', 'PASTOR',
                             'CAMPUS_ADMIN', 'CHURCH_ADMIN')),

  -- Set for campus-scoped roles. A campus admin holds church-wide permissions but may only
  -- exercise them on their own campus, which is a *filter* and never an isolation boundary
  -- (docs/01 §2.3) — the boundary is church_id and RLS, always.
  campus_id  uuid,

  granted_at timestamptz NOT NULL DEFAULT now(),
  -- Who granted it. Null once that account is gone; the grant outlives the granter.
  granted_by uuid,

  -- A campus-scoped role must name its campus. The policy engine narrows a CAMPUS_ADMIN to
  -- their campus only when the subject *has* one; with no campus it skips the check and the
  -- role reaches the whole church. That is the unsafe direction, so the state is made
  -- unreachable here rather than guarded for downstream.
  CONSTRAINT user_role_campus_scoped_has_campus
    CHECK (role <> 'CAMPUS_ADMIN' OR campus_id IS NOT NULL),

  CONSTRAINT user_role_user_fk FOREIGN KEY (church_id, user_id)
    REFERENCES app_user (church_id, id) ON DELETE CASCADE,
  CONSTRAINT user_role_campus_fk FOREIGN KEY (church_id, campus_id)
    REFERENCES campus (church_id, id) ON DELETE SET NULL (campus_id),
  CONSTRAINT user_role_granted_by_fk FOREIGN KEY (church_id, granted_by)
    REFERENCES app_user (church_id, id) ON DELETE SET NULL (granted_by)
);

-- One row per (user, role, campus). COALESCE because NULL campus_id would otherwise slip
-- past a plain unique index every time — NULLs are never equal to each other.
CREATE UNIQUE INDEX user_role_unique
  ON user_role (user_id, role, COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- At most one campus-scoped role per user. The access token and the policy Subject both
-- carry a single campus_id, so a user administering two campuses cannot be represented
-- truthfully — and the way that failure lands today is the token omitting the campus, which
-- *widens* their reach to the whole church. Refusing the second grant makes the limitation
-- visible to whoever is granting it, at the moment they do it. Supporting genuine
-- multi-campus admins means changing the claim and Subject shape, which is a contract
-- change and its own ticket.
CREATE UNIQUE INDEX user_role_one_campus_scope ON user_role (user_id)
  WHERE role = 'CAMPUS_ADMIN';
CREATE INDEX user_role_church_id_idx ON user_role (church_id);
CREATE INDEX user_role_user_idx ON user_role (user_id);

ALTER TABLE user_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_role
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON user_role TO @app_role@;
