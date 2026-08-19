-- Make `updated_at` true.
--
-- Every table in this schema declares `updated_at timestamptz NOT NULL DEFAULT now()`, and
-- until now that default was the only thing that ever set it: TenantRepository.update writes
-- exactly the columns it was handed, so a row's updated_at recorded when it was *created*
-- and never moved again. The column has been exposed on Person and Family in the contract,
-- where a client would reasonably use it for caching or sync — and would have cached stale
-- data forever.
--
-- Fixed with a trigger rather than in the repository, because the repository is not the only
-- writer. A migration, a maintenance script, a service issuing its own UPDATE, and any code
-- written after this all get it right without knowing the rule exists. A convention that
-- needs remembering is a convention that eventually is not.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  -- clock_timestamp(), not now(): the moment of the write rather than of the transaction.
  -- Two updates in one transaction should not claim to have happened simultaneously.
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Applied by discovery rather than by a list, so a table added later cannot be forgotten —
-- as long as it follows the naming convention, which the boundary checks already require.
DO $$
DECLARE
  target text;
BEGIN
  FOR target IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_name = c.relname AND col.column_name = 'updated_at'
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND col.table_schema = 'public'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      target || '_set_updated_at',
      target
    );
  END LOOP;
END;
$$;
