/**
 * Self-describing objects (data-model.md §5.13, ADR-0024): every object
 * the app writes carries the wrapped envelope of its own DEK, the envelope
 * format version and — for a rendered invoice PDF — its invoice number,
 * as S3 user metadata (`x-amz-meta-<name>`). With the binary identity the
 * object decrypts without its `attachments` row; the recovery tool
 * (`recoverObjects.ts`) reads these fields back.
 *
 * This module owns the wire names and the encode/decode pair so the write
 * paths and the recovery path cannot drift apart.
 */

/** Metadata names as S3 user-metadata keys (no `x-amz-meta-` prefix). */
export const OBJECT_METADATA_KEYS = {
  wrappedDek: 'wrapped-dek',
  wrappedDekVersion: 'wrapped-dek-version',
  invoiceNumber: 'invoice-number',
} as const;

export interface ObjectEnvelopeMetadata {
  /** base64 of the age-wrapped DEK that encrypts this object. */
  wrappedDek: string;
  wrappedDekVersion: number;
  /** Only on rendered invoice PDFs. */
  invoiceNumber?: string;
}

/** Encode for the SDK's `Metadata` field / presigned PUT headers. */
export function toObjectMetadata(meta: ObjectEnvelopeMetadata): Record<string, string> {
  return {
    [OBJECT_METADATA_KEYS.wrappedDek]: meta.wrappedDek,
    [OBJECT_METADATA_KEYS.wrappedDekVersion]: String(meta.wrappedDekVersion),
    ...(meta.invoiceNumber !== undefined
      ? { [OBJECT_METADATA_KEYS.invoiceNumber]: meta.invoiceNumber }
      : {}),
  };
}

/**
 * Decode metadata read back from storage. The two envelope fields are
 * independent of the invoice number: a version whose envelope is missing
 * or malformed may still carry a readable number, and the post-restore
 * numbering bump needs it (AC-368).
 */
export function fromObjectMetadata(raw: Record<string, string> | undefined): {
  envelope: { wrappedDek: string; wrappedDekVersion: number } | null;
  invoiceNumber: string | undefined;
} {
  const wrappedDek = raw?.[OBJECT_METADATA_KEYS.wrappedDek];
  const versionText = raw?.[OBJECT_METADATA_KEYS.wrappedDekVersion];
  const wrappedDekVersion = versionText !== undefined ? Number(versionText) : NaN;
  const envelope =
    wrappedDek && Number.isInteger(wrappedDekVersion) ? { wrappedDek, wrappedDekVersion } : null;
  return { envelope, invoiceNumber: raw?.[OBJECT_METADATA_KEYS.invoiceNumber] || undefined };
}
