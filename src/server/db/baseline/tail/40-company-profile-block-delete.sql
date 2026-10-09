-- ---------------------------------------------------------------
-- Company profile — singleton DELETE guard (AC-300).
--
-- The CHECK on (singleton = true) plus the UNIQUE on `singleton`
-- caps the row count at one, but a DELETE leaves zero rows — also
-- not a valid state for the singleton invariant (data-model.md
-- §5.17). The application API exposes only GET + PUT; this trigger
-- is the DB-layer backstop on direct DELETEs (seed scripts,
-- migrations, manual SQL).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION company_profile_block_delete_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = 'company_profile: the singleton row cannot be deleted (data-model.md §5.17, ADR-0026)',
    ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_profile_block_delete
BEFORE DELETE ON company_profile
FOR EACH ROW
EXECUTE FUNCTION company_profile_block_delete_fn();
