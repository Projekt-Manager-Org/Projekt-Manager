/**
 * Invoice binary persistence + download — leaf service, no service deps.
 *
 * Split off `InvoiceService` per C-SIZE. Encapsulates two responsibilities:
 *   - `persistRendered` — write a rendered ZUGFeRD PDF/A-3 through the
 *     attachment binary-descriptor pipeline (called from inside the
 *     issuance / cancellation transactions).
 *   - `downloadPdf` — resolve, decrypt and return the plaintext bytes of
 *     the rendered PDF for a given issued / cancelled invoice.
 *
 * The orchestrator (`InvoiceService`) handles the `get()` triage so
 * permission / scope stay in the orchestration layer; this service
 * receives an already-resolved `Invoice` and applies only the draft
 * `INVOICE_NOT_ISSUED` rejection.
 */

import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database, MutatingDatabase } from '../db/connection.js';
import { attachments } from '../db/schema.js';
import { WRAPPED_DEK_CURRENT_VERSION } from '../../domain/attachments.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import { StorageObjectNotFoundError } from '../storage/client.js';
import type { Invoice } from '../../domain/invoice.js';
import { buildInvoiceDownloadFilename } from '../../domain/invoice.js';
import type { RenderedInvoice } from './InvoiceRenderer.js';
import { encryptInvoicePayload, decryptInvoicePayload } from './invoice/payloadCrypto.js';
import { KeyEnvelopeService, KeyEnvelopeUnwrapError } from './KeyEnvelopeService.js';
import { notFound, invoiceNotIssued, dekUnwrapFailed } from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { insertRenderedInvoiceBinary } from '../repositories/attachment.js';

/**
 * Binary-pipeline dependencies. `persistRendered` uses these to
 * write the rendered ZUGFeRD PDF/A-3 through the existing attachment
 * binary-descriptor pipeline:
 *
 *   1. Generate fresh 32-byte AES-256-GCM DEK.
 *   2. Encrypt the plaintext PDF bytes (`nonce(12) || ct || tag(16)`).
 *   3. Wrap the DEK against the operator-loaded `age` recipient via
 *      `KeyEnvelopeService.wrap()` — parity with attachment init.
 *   4. `putObject(key, ciphertext, "application/octet-stream")` —
 *      server-side direct PUT, no presign round-trip. The bucket's
 *      default-retention envelope (`INVOICE_OBJECT_LOCK_DAYS`,
 *      asserted at boot per AC-296) attaches Object Lock to the PUT.
 *   5. Insert an `attachments` row at `status='ready'` carrying the
 *      ciphertext key + size + the wrapped DEK + MIME `application/pdf`
 *      + label `'rechnung'`. The row id is returned and stored on
 *      `invoices.renderedPdfBinaryDescriptorId`.
 *
 * Required at construction time. The route wiring builds these from
 * env (`STORAGE_*`, `BINARY_AGE_RECIPIENT`, `BINARY_AGE_IDENTITY_PATH`),
 * which `assertAppServerEnv` enforces at boot — so the deps are always
 * present in any process that registers the invoice routes.
 */
export interface InvoiceBinaryDeps {
  storage: AttachmentStorageClient;
  binaryAgeRecipient: string;
  binaryAgeIdentityPath: string;
}

export class InvoiceBinaryService {
  constructor(
    private db: Database,
    private deps: InvoiceBinaryDeps,
  ) {}

  /**
   * Persist the rendered ZUGFeRD bytes through the existing binary
   * descriptor pipeline (parity with `AttachmentService.initUpload` +
   * `completeUpload` collapsed into a single server-side write because
   * the bytes are mint-fresh in memory and not user-supplied).
   *
   * Sequence:
   *   1. Generate a fresh 32-byte AES-256-GCM DEK.
   *   2. Encrypt the plaintext PDF bytes (`nonce(12) || ct || tag(16)`
   *      — the same envelope shape the browser uses for attachments).
   *   3. Wrap the DEK against the operator-loaded `age` recipient
   *      (`BINARY_AGE_RECIPIENT`) via `KeyEnvelopeService`.
   *   4. `putObject` the ciphertext to the bucket under
   *      `invoices/<projectId>/<descriptorId>.orig`. The bucket's
   *      default-retention envelope (`INVOICE_OBJECT_LOCK_DAYS`,
   *      asserted at boot per AC-296) attaches Object Lock to the PUT
   *      — no per-call retention header needed.
   *   5. Insert one `attachments` row at `status='ready'`. The row id
   *      is the descriptor reference returned to the caller and
   *      stored on `invoices.renderedPdfBinaryDescriptorId`.
   *
   * The whole call runs inside the issuance transaction, so a fault
   * after the bucket PUT rolls back the row insert and leaves the
   * object behind. The attachment-orphan reaper does NOT collect it:
   * it matches rows at `status = 'pending'`, and a rolled-back insert
   * leaves no row at all. The periodic bucket-orphan sweep
   * (`pruneBucketOrphans`) is what collects it, within a day.
   */
  async persistRendered(
    tx: MutatingDatabase,
    rendered: RenderedInvoice,
    projectId: string,
    invoice: Pick<Invoice, 'id' | 'number' | 'recipient'>,
    userId: string,
  ): Promise<string> {
    const { storage, binaryAgeRecipient, binaryAgeIdentityPath } = this.deps;

    // 1 + 2. Encrypt the plaintext PDF bytes under a fresh DEK.
    const { ciphertext, dek } = encryptInvoicePayload(rendered.pdfBytes);

    // 3. Wrap the DEK against the operator-loaded recipient.
    const envelope = new KeyEnvelopeService({
      recipient: binaryAgeRecipient,
      identityPath: binaryAgeIdentityPath,
    });
    const wrappedDek = await envelope.wrap(dek);
    const wrappedDekBase64 = Buffer.from(wrappedDek).toString('base64');

    // 4. PUT the ciphertext. The key shape mirrors the attachment
    // convention so the lifecycle / safety probe surfaces both paths
    // under a predictable prefix.
    const descriptorId = crypto.randomUUID();
    const originalKey = `invoices/${projectId}/${descriptorId}.orig`;
    await storage.putObject(originalKey, ciphertext, 'application/octet-stream');

    // 5. Insert the attachments row at `status='ready'` via the repo.
    // The stored filename is the human-readable label the operator
    // sees on a fresh download — derived from the invoice via the
    // shared helper so `attachments.filename` and the value the
    // download endpoint computes can never diverge.
    //
    // ServerSide PUT does not return a VersionId from `putObject`
    // (we don't HEAD the just-written object). Versioned buckets
    // still issue a VersionId per write; capture it via HEAD post-
    // PUT so the Papierkorb restore primitive can address the
    // current version later. The HEAD is cheap (no body fetch).
    const filename = buildInvoiceDownloadFilename(invoice);
    const versionId = (await storage.headObject(originalKey)).versionId ?? null;
    await insertRenderedInvoiceBinary(tx, {
      id: descriptorId,
      projectId,
      filename,
      sizeBytes: rendered.pdfBytes.byteLength,
      originalKey,
      ciphertextSizeBytes: ciphertext.byteLength,
      versionId,
      wrappedDek: wrappedDekBase64,
      wrappedDekVersion: WRAPPED_DEK_CURRENT_VERSION,
      createdBy: userId,
    });
    return descriptorId;
  }

  /**
   * Resolve the rendered PDF for an issued / cancelled invoice and
   * return the plaintext bytes plus the suggested filename. Drafts
   * surface `INVOICE_NOT_ISSUED` (AC-299).
   *
   * The orchestrator does the `get()` triage upstream; this method
   * takes an already-resolved `Invoice` and applies only the
   * status / descriptor checks.
   *
   * Sequence:
   *   1. Reject drafts with `INVOICE_NOT_ISSUED`.
   *   2. Look up the rendered-PDF attachment row by descriptor id;
   *      surface a synthetic `404` if the descriptor reference is
   *      missing on the invoice row, the attachment row is gone, or
   *      its `wrappedDek` is missing.
   *   3. Unwrap the row's DEK against the operator-loaded identity.
   *   4. Fetch the ciphertext from object storage.
   *   5. Decrypt and return the plaintext bytes.
   *
   * Per-row unwrap failure → `DEK_UNWRAP_FAILED` (422), mirroring the
   * attachment download path (AC-244). Wholesale identity failures
   * bubble as 5xx — the boot probe (ADR-0024) is supposed to make those
   * unreachable in steady state.
   */
  async downloadPdf(invoice: Invoice): Promise<{ bytes: Uint8Array; filename: string }> {
    if (invoice.status === 'draft') {
      throw invoiceNotIssued();
    }
    const descriptorId = invoice.renderedPdfBinaryDescriptorId;
    if (!descriptorId) {
      // No binary persisted for this row — surface 404 rather than
      // synthesising a placeholder.
      throw notFound(STRINGS.entities.resource);
    }

    const rows = await this.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, descriptorId))
      .limit(1);
    const row = rows[0];
    if (!row || !row.wrappedDek) {
      throw notFound(STRINGS.entities.resource);
    }

    const envelope = new KeyEnvelopeService({
      recipient: this.deps.binaryAgeRecipient,
      identityPath: this.deps.binaryAgeIdentityPath,
    });
    let dek: Uint8Array;
    try {
      dek = await envelope.unwrap(Buffer.from(row.wrappedDek, 'base64'));
    } catch (err) {
      if (err instanceof KeyEnvelopeUnwrapError) {
        throw dekUnwrapFailed();
      }
      throw err;
    }

    let ciphertext: Buffer;
    try {
      const stream = await this.deps.storage.getObject(row.originalKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
      }
      ciphertext = Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw notFound(STRINGS.entities.resource);
      }
      throw err;
    }

    const plaintext = decryptInvoicePayload(new Uint8Array(ciphertext), dek);
    // Derive the download filename from the invoice on the fly rather
    // than reading the row's stored label. `row.filename` is the
    // pipeline's internal storage label (kept stable for the descriptor
    // bookkeeping); the user-facing download name should follow the
    // human-readable format and stay in sync with the helper so any
    // future format changes apply to historical invoices too.
    return { bytes: plaintext, filename: buildInvoiceDownloadFilename(invoice) };
  }
}
