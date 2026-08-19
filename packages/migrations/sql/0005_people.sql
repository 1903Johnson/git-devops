-- People, families, membership lifecycle, and milestones.
--
-- Person is the platform's central record and the single source of truth (docs/01 §2.4.1).
-- A User exists only when a person needs to log in; children are Person records with no
-- account at all, so nothing here may assume one exists.
--
-- Every foreign key in this file that crosses tenant-scoped tables is composite —
-- (church_id, id) rather than (id) — and that is the load-bearing decision. Postgres runs
-- referential-integrity checks as the owner of the referenced table, which bypasses row-level
-- security: a plain `REFERENCES person (id)` lets one tenant attach another church's person to
-- its own family knowing nothing but the UUID. RLS still hides the person row on read, so no
-- data leaks, but the insert succeeding is an existence oracle, and the row left behind is a
-- dangling reference the owning church can delete out from under. Composite keys make
-- same-tenant a constraint rather than a convention. Verified against a live database before
-- and after: the cross-tenant insert succeeded with simple keys and is rejected with these.

-- Reference targets for the composite keys below. Redundant against each table's primary key
-- taken alone, which is exactly the point — a composite FK needs a unique key of matching
-- shape to point at.
ALTER TABLE campus   ADD CONSTRAINT campus_tenant_key   UNIQUE (church_id, id);
ALTER TABLE app_user ADD CONSTRAINT app_user_tenant_key UNIQUE (church_id, id);

CREATE TABLE person (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id     uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  campus_id     uuid,

  first_name    text NOT NULL,
  last_name     text NOT NULL,
  preferred_name text,

  -- Deliberately unconstrained. Churches record this for ministry grouping, and a rigid
  -- enum here would be a product decision made in a migration.
  gender        text,

  -- Stored in the clear rather than encrypted: children's check-in grades by age, and
  -- age-range queries are the point. Encrypting it would break the queries that justify
  -- collecting it. It is minor PII, so it is covered by the retention and export policies
  -- instead (docs/01 §2.6).
  date_of_birth date,

  -- Contact details. NOT unique: families routinely share one address, and a child's
  -- contact email is usually a parent's. A unique constraint here would reject the most
  -- ordinary family in the congregation.
  email         text,
  phone         text,
  address_line1 text,
  address_line2 text,
  city          text,
  region        text,
  postal_code   text,
  -- ISO 3166-1 alpha-2, matching church.country.
  country       text,

  photo_url     text,

  -- Denormalised current status; membership_status_history is the record of how it got
  -- there. Both are written in one transaction.
  status        text NOT NULL DEFAULT 'visitor'
                CHECK (status IN ('visitor', 'attendee', 'member', 'inactive', 'transferred')),

  -- Archived rather than deleted: giving and attendance history reference people, and a
  -- hard delete would silently rewrite the past. Right-to-erasure is a separate, deliberate
  -- purge path (CORE-070), not this column.
  archived_at   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT person_tenant_key UNIQUE (church_id, id),
  -- Column-list SET NULL (Postgres 15+) so closing a campus nulls campus_id without trying
  -- to null the NOT NULL church_id alongside it.
  CONSTRAINT person_campus_fk FOREIGN KEY (church_id, campus_id)
    REFERENCES campus (church_id, id) ON DELETE SET NULL (campus_id)
);

CREATE INDEX person_church_id_idx ON person (church_id);
CREATE INDEX person_campus_id_idx ON person (campus_id);
CREATE INDEX person_last_name_idx ON person (church_id, lower(last_name));
CREATE INDEX person_status_idx ON person (church_id, status) WHERE archived_at IS NULL;

ALTER TABLE person ENABLE ROW LEVEL SECURITY;
ALTER TABLE person FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON person
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON person TO @app_role@;

-- Links app_user to the person it represents. Nullable on app_user rather than required,
-- because staff accounts are sometimes created before the person record exists.
ALTER TABLE app_user ADD COLUMN person_id uuid;
ALTER TABLE app_user ADD CONSTRAINT app_user_person_fk
  FOREIGN KEY (church_id, person_id) REFERENCES person (church_id, id)
  ON DELETE SET NULL (person_id);
CREATE UNIQUE INDEX app_user_person_key ON app_user (person_id) WHERE person_id IS NOT NULL;

CREATE TABLE family (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id   uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT family_tenant_key UNIQUE (church_id, id)
);

CREATE INDEX family_church_id_idx ON family (church_id);

ALTER TABLE family ENABLE ROW LEVEL SECURITY;
ALTER TABLE family FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON family
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON family TO @app_role@;

-- Many-to-many on purpose. A person belongs to more than one family after a remarriage,
-- and an adult child appears in both their parents' household and their own. Modelling
-- this as a column on person would force the church to pick one, which is a real
-- pastoral problem rather than a data-modelling nicety.
--
-- `relationship` is a description of a household, NOT an authorisation. Nothing may read
-- 'parent' here as permission to collect a child at check-in — that is an explicit
-- GuardianAuthorisation owned by the children's check-in module (docs/02 §5), and a custody
-- order routinely leaves a parent on this list and off that one.
CREATE TABLE family_member (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id     uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  family_id     uuid NOT NULL,
  person_id     uuid NOT NULL,
  relationship  text NOT NULL
                CHECK (relationship IN ('parent', 'guardian', 'child', 'spouse', 'other')),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT family_member_family_fk FOREIGN KEY (church_id, family_id)
    REFERENCES family (church_id, id) ON DELETE CASCADE,
  CONSTRAINT family_member_person_fk FOREIGN KEY (church_id, person_id)
    REFERENCES person (church_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX family_member_unique ON family_member (family_id, person_id);
CREATE INDEX family_member_person_idx ON family_member (person_id);
CREATE INDEX family_member_church_id_idx ON family_member (church_id);

ALTER TABLE family_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON family_member
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON family_member TO @app_role@;

-- Append-only. Churches track how someone became a member, not merely that they are one:
-- "attended for two years, then joined" and "transferred in last month" are different
-- pastoral facts, and overwriting a status erases the difference.
CREATE TABLE membership_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id   uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  person_id   uuid NOT NULL,
  status      text NOT NULL
              CHECK (status IN ('visitor', 'attendee', 'member', 'inactive', 'transferred')),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  -- The person who made the change, not the one it is about. Null for imports, and for a
  -- staff account since deleted — the history outlives the account that wrote it.
  changed_by  uuid,
  note        text,

  CONSTRAINT membership_status_history_person_fk FOREIGN KEY (church_id, person_id)
    REFERENCES person (church_id, id) ON DELETE CASCADE,
  CONSTRAINT membership_status_history_changed_by_fk FOREIGN KEY (church_id, changed_by)
    REFERENCES app_user (church_id, id) ON DELETE SET NULL (changed_by)
);

CREATE INDEX membership_status_history_person_idx ON membership_status_history (person_id, changed_at DESC);
CREATE INDEX membership_status_history_church_id_idx ON membership_status_history (church_id);

ALTER TABLE membership_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership_status_history
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON membership_status_history TO @app_role@;

-- Sacraments, rites, and milestones. Core denominational data that the original
-- architecture omitted entirely (docs/00 §1.4).
CREATE TABLE milestone (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id   uuid NOT NULL REFERENCES church (id) ON DELETE CASCADE,
  person_id   uuid NOT NULL,
  campus_id   uuid,
  type        text NOT NULL
              CHECK (type IN ('baptism', 'confirmation', 'membership_class', 'marriage', 'dedication')),
  -- A date, not a timestamp: a baptism in 1974 has a date and no defensible time of day.
  occurred_on date NOT NULL,
  officiant   text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT milestone_person_fk FOREIGN KEY (church_id, person_id)
    REFERENCES person (church_id, id) ON DELETE CASCADE,
  CONSTRAINT milestone_campus_fk FOREIGN KEY (church_id, campus_id)
    REFERENCES campus (church_id, id) ON DELETE SET NULL (campus_id)
);

CREATE INDEX milestone_person_idx ON milestone (person_id, occurred_on DESC);
CREATE INDEX milestone_church_id_idx ON milestone (church_id);

ALTER TABLE milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestone FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON milestone
  USING (church_id = current_setting('app.current_church_id', true)::uuid)
  WITH CHECK (church_id = current_setting('app.current_church_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON milestone TO @app_role@;
