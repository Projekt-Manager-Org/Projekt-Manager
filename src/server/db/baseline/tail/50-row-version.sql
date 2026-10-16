-- ---------------------------------------------------------------
-- Row version — optimistic-concurrency token (data-model.md §6.4).
--
-- Every UPDATE of a project, customer, invoice or the company profile
-- advances `version`, whatever the write path: a field edit, a
-- transition, archive / restore, the issuance flip. Owning the bump
-- here means a new write path cannot forget it. The version check
-- itself lives in the services (lock the row, compare, write).
--
-- Exceptions (§6.4):
--   - database cascades (FK `ON DELETE SET NULL` on `created_by` /
--     `updated_by`) keep the version — they run inside the RI
--     trigger, so `pg_trigger_depth()` is above 1;
--   - an issued or cancelled invoice is frozen — its version no
--     longer changes (the cancel flip included).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION row_version_bump_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    NEW.version := OLD.version;
  ELSE
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invoices_version_bump_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR OLD.status <> 'draft' THEN
    NEW.version := OLD.version;
  ELSE
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER projects_version_bump
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION row_version_bump_fn();
--> statement-breakpoint
CREATE TRIGGER customers_version_bump
BEFORE UPDATE ON customers
FOR EACH ROW
EXECUTE FUNCTION row_version_bump_fn();
--> statement-breakpoint
CREATE TRIGGER company_profile_version_bump
BEFORE UPDATE ON company_profile
FOR EACH ROW
EXECUTE FUNCTION row_version_bump_fn();
--> statement-breakpoint
CREATE TRIGGER invoices_version_bump
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION invoices_version_bump_fn();
