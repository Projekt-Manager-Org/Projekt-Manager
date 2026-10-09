-- ---------------------------------------------------------------
-- Invoices — issued-row immutability (data-model.md §6.14, AC-294).
--
-- Persistence-layer backstop on direct SQL writes that bypass the
-- route layer (seed scripts, migrations, manual SQL). The route
-- layer rejects with INVOICE_FROZEN; this trigger is the
-- defense-in-depth layer ADR-0026 names as impl-defined.
--
-- Permitted mutations on an issued row:
--   - status: 'issued' → 'cancelled'  (the cancellation flip)
--   - updated_at, updated_by          (audit metadata bump)
--
-- `cancellation_reason` is NOT in the allow-list. Per
-- data-model.md §5.15 ("null on non-Storno rows; frozen on the
-- Storno row at issuance of the cancellation") and
-- `invoices-cancel.test.ts:313` (`cancellation_reason` is listed in
-- the original's `immutableFields` set), the original invoice's
-- `cancellation_reason` stays NULL forever. The reason text is
-- carried by the Storno sibling row, which is a fresh INSERT — this
-- trigger fires only on UPDATE, so the Storno's `cancellation_reason`
-- is set without touching the trigger.
--
-- Every other column UPDATE on an issued row is rejected. A
-- 'cancelled' row is fully frozen — no further UPDATEs at all.
-- Drafts are unconstrained; the route layer manages their lifecycle.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoices_enforce_immutability_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Drafts: every column is mutable; the route layer is the only
  -- gate. Short-circuit before the per-column comparisons.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Cancelled rows: write-once, no further mutation. The cancel
  -- transaction flips status on the original; once cancelled, the
  -- row is fully frozen.
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'invoices: cancelled rows are write-once at the persistence layer (data-model.md §6.14)',
      ERRCODE = 'P0001';
  END IF;

  -- Issued rows: only the cancellation-flip path (status, updated_at,
  -- updated_by) may mutate. Every other column must be byte-equal
  -- between OLD and NEW.
  IF OLD.status = 'issued' THEN
    -- Status: must stay 'issued' OR flip to 'cancelled'.
    IF NEW.status NOT IN ('issued', 'cancelled') THEN
      RAISE EXCEPTION USING
        MESSAGE = 'invoices: issued rows may only transition status to cancelled (data-model.md §6.14)',
        ERRCODE = 'P0001';
    END IF;

    -- Pin every snapshot column. A regression that adds a new
    -- snapshot column without listing it here would silently
    -- mutate; the column-by-column equality check is the strictest
    -- shape the mechanism can take.
    IF NEW.id              <> OLD.id              THEN RAISE EXCEPTION 'invoices: id frozen on issued rows'              USING ERRCODE = 'P0001'; END IF;
    IF NEW.project_id      <> OLD.project_id      THEN RAISE EXCEPTION 'invoices: project_id frozen on issued rows'      USING ERRCODE = 'P0001'; END IF;
    IF NEW.number          <> OLD.number          THEN RAISE EXCEPTION 'invoices: number frozen on issued rows'          USING ERRCODE = 'P0001'; END IF;
    IF NEW.issue_date      <> OLD.issue_date      THEN RAISE EXCEPTION 'invoices: issue_date frozen on issued rows'      USING ERRCODE = 'P0001'; END IF;
    IF NEW.performance_date IS DISTINCT FROM OLD.performance_date
       THEN RAISE EXCEPTION 'invoices: performance_date frozen on issued rows' USING ERRCODE = 'P0001'; END IF;
    IF NEW.tax_mode        <> OLD.tax_mode        THEN RAISE EXCEPTION 'invoices: tax_mode frozen on issued rows'        USING ERRCODE = 'P0001'; END IF;
    IF NEW.profile         <> OLD.profile         THEN RAISE EXCEPTION 'invoices: profile frozen on issued rows'         USING ERRCODE = 'P0001'; END IF;
    IF NEW.issuer::text    <> OLD.issuer::text    THEN RAISE EXCEPTION 'invoices: issuer frozen on issued rows'          USING ERRCODE = 'P0001'; END IF;
    IF NEW.recipient::text <> OLD.recipient::text THEN RAISE EXCEPTION 'invoices: recipient frozen on issued rows'       USING ERRCODE = 'P0001'; END IF;
    IF NEW.lines::text     <> OLD.lines::text     THEN RAISE EXCEPTION 'invoices: lines frozen on issued rows'           USING ERRCODE = 'P0001'; END IF;
    IF NEW.totals::text    <> OLD.totals::text    THEN RAISE EXCEPTION 'invoices: totals frozen on issued rows'          USING ERRCODE = 'P0001'; END IF;
    IF NEW.cancellation_of IS DISTINCT FROM OLD.cancellation_of
       THEN RAISE EXCEPTION 'invoices: cancellation_of frozen on issued rows' USING ERRCODE = 'P0001'; END IF;
    IF NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
       THEN RAISE EXCEPTION 'invoices: cancellation_reason frozen on the original (written only on the Storno sibling, a fresh INSERT)' USING ERRCODE = 'P0001'; END IF;
    IF NEW.rendered_pdf_binary_descriptor_id IS DISTINCT FROM OLD.rendered_pdf_binary_descriptor_id
       THEN RAISE EXCEPTION 'invoices: rendered_pdf_binary_descriptor_id frozen on issued rows' USING ERRCODE = 'P0001'; END IF;
    IF NEW.created_at      <> OLD.created_at      THEN RAISE EXCEPTION 'invoices: created_at frozen on issued rows'      USING ERRCODE = 'P0001'; END IF;
    IF NEW.created_by      IS DISTINCT FROM OLD.created_by
       THEN RAISE EXCEPTION 'invoices: created_by frozen on issued rows' USING ERRCODE = 'P0001'; END IF;
    -- updated_at, updated_by are the only mutable columns on the
    -- issued→cancelled path; status is checked above.
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_enforce_immutability
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION invoices_enforce_immutability_fn();
