-- ---------------------------------------------------------------
-- audit_log — append-only below the services (AC-642).
--
-- Backstop for writes that bypass `mutate()`: raw SQL, a migration, a
-- careless `TRUNCATE … CASCADE` over `users`. Two exceptions:
--
--   - deleting a user clears `actor_id` (FK `ON DELETE SET NULL`,
--     AC-567). It runs inside the RI trigger, so `pg_trigger_depth()`
--     is above 1 (as in 50-row-version.sql); a direct
--     `SET actor_id = NULL` is depth 1 and fails. Every other column
--     must stay equal; the jsonb comparison covers columns added later.
--   - DELETE / TRUNCATE pass once the transaction set
--     `pm.audit_log_removal` (`withAuditLogRemoval`,
--     src/server/db/auditLogRemoval.ts). Transaction-local, so it never
--     outlives the call.
--
-- Not a security boundary: any session may set the flag, and `pm`
-- (superuser, ARCHITECTURE.md § Design Decisions, "One DB role") may
-- drop the triggers. It stops accidents, not an attacker holding the role.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_append_only_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() > 1
       AND OLD.actor_id IS NOT NULL
       AND NEW.actor_id IS NULL
       AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      MESSAGE = 'audit_log: entries are append-only; only a user delete may clear actor_id (AC-642)',
      ERRCODE = 'P0001';
  END IF;

  -- DELETE (row level) or TRUNCATE (statement level).
  IF current_setting('pm.audit_log_removal', true) = 'on' THEN
    RETURN OLD; -- NULL for TRUNCATE, ignored at statement level
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('audit_log: %s outside retention (AC-642)', TG_OP),
    ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION audit_log_append_only_fn();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT
EXECUTE FUNCTION audit_log_append_only_fn();
