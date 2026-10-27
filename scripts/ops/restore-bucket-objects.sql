-- Rows for scripts/ops/restore-bucket-objects.py: one per attachment, in
-- the helper's OBJECTS_TSV column order, absent values as ''. Each
-- object's metadata is rebuilt from these: the original under
-- wrapped_dek, the thumbnail under wrapped_thumb_dek, an invoice PDF with
-- the number of the invoice that renders it (#627).
SELECT a.id                                 AS id,
       a.original_key                       AS original_key,
       COALESCE(a.thumb_key, '')            AS thumb_key,
       COALESCE(a.wrapped_dek, '')          AS wrapped_dek,
       COALESCE(a.wrapped_thumb_dek, '')    AS wrapped_thumb_dek,
       a.wrapped_dek_version                AS wrapped_dek_version,
       COALESCE(i.number, '')               AS invoice_number,
       COALESCE(a.version_id, '')           AS version_id,
       COALESCE(a.thumb_version_id, '')     AS thumb_version_id
  FROM attachments a
  LEFT JOIN invoices i ON i.rendered_pdf_binary_descriptor_id = a.id;
