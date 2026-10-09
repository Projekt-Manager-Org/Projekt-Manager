-- ---------------------------------------------------------------
-- Project storage usage — trigger-maintained side table
-- (data-model.md §5.14, ARCHITECTURE.md "Storage usage —
-- trigger-maintained side table", AC-263).
-- ---------------------------------------------------------------

-- Trigger 1: seed a zero usage row for every new project so the
-- delta trigger only ever issues UPDATEs (no upsert path needed).
CREATE OR REPLACE FUNCTION projects_storage_usage_init_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO project_storage_usage (project_id) VALUES (NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER projects_storage_usage_init
AFTER INSERT ON projects
FOR EACH ROW
EXECUTE FUNCTION projects_storage_usage_init_fn();
--> statement-breakpoint
-- Trigger 2: maintain the four-bucket view in lockstep with the
-- attachment lifecycle. Every transition (init pending, complete to
-- ready, hide ready→hidden, restore hidden→ready, orphan-reaper
-- delete pending, hidden-reaper delete hidden) lands on the
-- attachments table; a single AFTER row trigger covers all of them
-- by computing OLD-vs-NEW deltas and applying them in one UPDATE.
--
-- Cascade short-circuit: a project hard-delete cascades to
-- attachments via FK. While that cascade runs, this trigger fires
-- with TG_OP='DELETE' at depth 2 (the projects DELETE is at depth
-- 1, the cascaded attachments DELETE is the nested call). The
-- side-table row is being cascade-removed in the same transaction,
-- so the UPDATE would target a row that no longer exists; skip it.
-- Narrowed to TG_OP='DELETE' so any future nested non-DELETE
-- context still updates the counter — drift on a missed nested
-- update is recoverable via reconciliation; silent corruption on a
-- nested update we tried to skip is not.
CREATE OR REPLACE FUNCTION attachments_storage_usage_delta_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  d_space_ready bigint := 0;
  d_space_hidden bigint := 0;
  d_ciphertext_ready bigint := 0;
  d_ciphertext_hidden bigint := 0;
  old_plain bigint := 0;
  new_plain bigint := 0;
  old_cipher bigint := 0;
  new_cipher bigint := 0;
  target_project uuid;
BEGIN
  -- Cascade short-circuit: project DELETE → cascades to attachments.
  -- The side-table row is being removed via FK cascade in the same
  -- transaction, so the UPDATE is wasted work and would fail to
  -- match. Pinned at TG_OP='DELETE' (data-model.md §5.14).
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  -- OLD-side contribution (status before the change). Pending rows
  -- contribute zero on every axis; only ready/hidden carry bytes.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.status IN ('ready', 'hidden') THEN
      old_plain := OLD.size_bytes + COALESCE(OLD.thumb_size_bytes, 0);
      old_cipher := COALESCE(OLD.ciphertext_size_bytes, 0)
                  + COALESCE(OLD.ciphertext_thumb_size_bytes, 0);
      IF OLD.status = 'ready' THEN
        d_space_ready := d_space_ready - old_plain;
        d_ciphertext_ready := d_ciphertext_ready - old_cipher;
      ELSE
        d_space_hidden := d_space_hidden - old_plain;
        d_ciphertext_hidden := d_ciphertext_hidden - old_cipher;
      END IF;
    END IF;
  END IF;

  -- NEW-side contribution (status after the change). Same exclusion
  -- of pending rows as the OLD branch.
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.status IN ('ready', 'hidden') THEN
      new_plain := NEW.size_bytes + COALESCE(NEW.thumb_size_bytes, 0);
      new_cipher := COALESCE(NEW.ciphertext_size_bytes, 0)
                  + COALESCE(NEW.ciphertext_thumb_size_bytes, 0);
      IF NEW.status = 'ready' THEN
        d_space_ready := d_space_ready + new_plain;
        d_ciphertext_ready := d_ciphertext_ready + new_cipher;
      ELSE
        d_space_hidden := d_space_hidden + new_plain;
        d_ciphertext_hidden := d_ciphertext_hidden + new_cipher;
      END IF;
    END IF;
  END IF;

  -- No-op statements (label rename, pending insert, pending delete)
  -- compute zero deltas across all four counters; skip the UPDATE.
  IF d_space_ready = 0 AND d_space_hidden = 0
     AND d_ciphertext_ready = 0 AND d_ciphertext_hidden = 0 THEN
    RETURN NULL;
  END IF;

  -- INSERT/UPDATE keys on NEW.project_id; DELETE keys on OLD. The
  -- single UPDATE atomically applies all four deltas — partial
  -- application is impossible (data-model.md §5.14).
  IF TG_OP = 'DELETE' THEN
    target_project := OLD.project_id;
  ELSE
    target_project := NEW.project_id;
  END IF;

  UPDATE project_storage_usage
  SET space_ready_bytes = space_ready_bytes + d_space_ready,
      space_hidden_bytes = space_hidden_bytes + d_space_hidden,
      ciphertext_ready_bytes = ciphertext_ready_bytes + d_ciphertext_ready,
      ciphertext_hidden_bytes = ciphertext_hidden_bytes + d_ciphertext_hidden
  WHERE project_id = target_project;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attachments_storage_usage_delta
AFTER INSERT OR UPDATE OR DELETE ON attachments
FOR EACH ROW
EXECUTE FUNCTION attachments_storage_usage_delta_fn();
