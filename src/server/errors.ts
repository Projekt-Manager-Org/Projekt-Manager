/**
 * Application error types with machine-readable codes
 * and German human-readable messages.
 *
 * Never leaks internal details (stack traces, DB field names, etc.).
 */

import { STRINGS } from '../config/strings.js';

export type ErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'NOT_PERMITTED'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND'
  | 'ROUTE_NOT_FOUND'
  | 'GONE'
  | 'RATE_LIMITED'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'TARGET_NOT_EMPTY'
  | 'RESTORE_CONFIRMATION_MISMATCH'
  | 'MISSING_USER_REFS'
  // Full-account takeout jobs (ADR-0018, api.md §14.2.4 / §14.4.1).
  | 'EXPORT_JOB_ACTIVE'
  | 'IMPORT_JOB_ACTIVE'
  | 'EXPORT_JOB_NOT_READY'
  | 'UPLOAD_OFFSET_CONFLICT'
  | 'UPLOAD_TOO_LARGE'
  | 'UPLOAD_NOT_ACCEPTED'
  | 'BULK_LIMIT_EXCEEDED'
  | 'DEK_UNWRAP_FAILED'
  // Invoice + company-profile domain (ADR-0026, api.md §14.4).
  | 'INVOICE_FROZEN'
  | 'INVOICE_NUMBER_FORMAT'
  | 'INVOICE_PROJECT_STATE'
  | 'INVOICE_NOT_ISSUED'
  | 'INVOICE_ALREADY_CANCELLED'
  | 'DRAFT_NOT_EXPORTABLE'
  | 'EXPORT_TOO_LARGE'
  | 'COMPANY_PROFILE_REQUIRED'
  | 'CUSTOMER_HAS_INVOICES'
  | 'PROJECT_HAS_INVOICES'
  | 'SERVER_ERROR';

export interface AppErrorResponse {
  code: ErrorCode;
  message: string;
  /** Optional machine-readable detail (e.g. ajv validation errors). */
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly userMessage: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(userMessage);
    this.name = 'AppError';
  }

  toResponse(): AppErrorResponse {
    const response: AppErrorResponse = {
      code: this.code,
      message: this.userMessage,
    };
    if (this.details !== undefined) {
      response.details = this.details;
    }
    return response;
  }
}

// ---------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------

export function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', STRINGS.auth.loginFailed, 401);
}

export function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', STRINGS.auth.unauthenticated, 401);
}

export function sessionExpired(): AppError {
  return new AppError('SESSION_EXPIRED', STRINGS.auth.sessionExpired, 401);
}

export function notPermitted(): AppError {
  return new AppError('NOT_PERMITTED', STRINGS.auth.notPermitted, 403);
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError('VALIDATION_ERROR', message, 422, details);
}

export function conflict(message: string): AppError {
  return new AppError('CONFLICT', message, 409);
}

export function idempotencyConflict(): AppError {
  return new AppError('IDEMPOTENCY_CONFLICT', STRINGS.errors.idempotencyConflict, 409);
}

export function schemaVersionMismatch(expected: number, got: number): AppError {
  return new AppError('SCHEMA_VERSION_MISMATCH', STRINGS.errors.schemaVersionMismatch, 422, {
    expected,
    got,
  });
}

export function targetNotEmpty(): AppError {
  return new AppError('TARGET_NOT_EMPTY', STRINGS.errors.targetNotEmpty, 409);
}

export function restoreConfirmationMismatch(): AppError {
  return new AppError(
    'RESTORE_CONFIRMATION_MISMATCH',
    STRINGS.errors.restoreConfirmationMismatch,
    422,
  );
}

/**
 * Envelope carries user-id references that do not exist in the target
 * database. See api.md §14.2.4 / §14.4.1. `details.missingUserIds` is the
 * deduplicated list of absent ids; `details.references` carries one entry
 * per offending envelope reference site.
 */
export interface MissingUserRefsDetails {
  missingUserIds: string[];
  references: { path: string; userId: string }[];
}

export function missingUserRefs(details: MissingUserRefsDetails): AppError {
  return new AppError('MISSING_USER_REFS', STRINGS.errors.missingUserRefs, 422, details);
}

/**
 * A full-account export/import job create collided with one already
 * `pending`/`running` (api.md §14.2.4 "Jobs — one active per kind").
 * The active job's id rides in `details.activeJobId` so the UI
 * re-attaches to the running build rather than starting a second.
 */
export function exportJobActive(activeJobId: string): AppError {
  return new AppError('EXPORT_JOB_ACTIVE', STRINGS.errors.exportJobActive, 409, { activeJobId });
}

export function importJobActive(activeJobId: string): AppError {
  return new AppError('IMPORT_JOB_ACTIVE', STRINGS.errors.importJobActive, 409, { activeJobId });
}

/**
 * Download requested on an export job that has not reached `ready`
 * (api.md §14.2.4 "Export job — download"). 409 (not 404): the job
 * exists, the artifact is simply not built yet — the client polls and
 * retries.
 */
export function exportJobNotReady(): AppError {
  return new AppError('EXPORT_JOB_NOT_READY', STRINGS.errors.exportJobNotReady, 409);
}

/**
 * Resumable-upload chunk PATCHed at an offset other than the server's
 * current one (api.md §14.2.4 "Import job — resumable upload"). 409: the
 * server offset is unchanged, so a retried chunk at the correct offset is
 * safe (idempotent retry).
 */
export function uploadOffsetConflict(): AppError {
  return new AppError('UPLOAD_OFFSET_CONFLICT', STRINGS.errors.uploadOffsetConflict, 409);
}

/**
 * Resumable-upload chunk whose bytes would extend past the declared
 * `Upload-Length` (api.md §14.2.4). 413: the write is rejected wholesale
 * and the server offset does not advance.
 */
export function uploadTooLarge(): AppError {
  return new AppError('UPLOAD_TOO_LARGE', STRINGS.errors.uploadTooLarge, 413);
}

/**
 * Resumable-upload chunk PATCHed at a job that is not accepting bytes — it
 * either already left `pending` (upload complete / restore running / terminal)
 * so appending would corrupt the staged archive the runner reads, or it is not
 * an import job at all. 409: the job exists, its state simply forbids the write.
 */
export function uploadNotAccepted(): AppError {
  return new AppError('UPLOAD_NOT_ACCEPTED', STRINGS.errors.uploadNotAccepted, 409);
}

/**
 * Walk a (possibly wrapped) Error chain looking for the `constraint` property
 * that node-postgres attaches to integrity-constraint violations (23xxx).
 * Returns null when absent — some driver configurations (custom parsers,
 * stripped errors) omit it, in which case callers must fall back.
 */
export function extractPgConstraint(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (!(current instanceof Error)) break;
    const withConstraint = current as Error & { constraint?: string };
    if (typeof withConstraint.constraint === 'string' && withConstraint.constraint.length > 0) {
      return withConstraint.constraint;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Walk a (possibly wrapped) Error chain looking for a 5-char SQLSTATE code.
 * Returns null when no code is found.
 */
export function extractSqlState(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (!(current instanceof Error)) break;
    const withCode = current as Error & { code?: string };
    if (typeof withCode.code === 'string' && /^[0-9A-Z]{5}$/.test(withCode.code)) {
      return withCode.code;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}

export function notFound(entity: string = STRINGS.entities.resource): AppError {
  return new AppError('NOT_FOUND', STRINGS.errors.notFound(entity), 404);
}

/**
 * The requested URL has no registered handler. Distinct from `notFound()`
 * (entity missing on a known endpoint) — see api.md §14.4.1 / AC-247.
 */
export function routeNotFound(): AppError {
  return new AppError('ROUTE_NOT_FOUND', STRINGS.errors.routeNotFound, 404);
}

/**
 * Wrap a 4xx-class non-`AppError` (typically a `FastifyError` from the
 * content-type parser, body-limit, media-type negotiation, or the
 * not-found handler when it bubbles into `setErrorHandler`) in an
 * `AppError` that preserves the original statusCode and surfaces a
 * stable machine-readable code. Returns `null` for non-4xx errors so
 * the caller falls back to `serverError()`. See api.md §14.4.2 / AC-247.
 *
 * Domain `notFound()` errors are `AppError` instances and are handled
 * upstream of this mapper; a 404 reaching here is therefore route-shaped
 * (no registered handler) rather than domain-shaped (entity missing).
 */
export function mapFastify4xx(
  err: Error & { statusCode?: number; code?: string },
): AppError | null {
  const status = err.statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  if (status === 404 || err.code === 'FST_ERR_NOT_FOUND') {
    return new AppError('ROUTE_NOT_FOUND', STRINGS.errors.routeNotFound, status);
  }
  return new AppError('VALIDATION_ERROR', STRINGS.errors.invalidInput, status);
}

/**
 * The target resource existed but is permanently unavailable; retry won't
 * help. Distinct from 404 (no representation, may have never existed) and
 * 409 (transient conflict, refetch+retry might resolve). Used when the
 * Papierkorb row is present but the source bytes were lifecycle-reaped
 * ahead of the row reaper (data-model.md §6.12 race window).
 */
export function gone(message: string): AppError {
  return new AppError('GONE', message, 410);
}

export function rateLimited(): AppError {
  return new AppError('RATE_LIMITED', STRINGS.errors.rateLimited, 429);
}

export function serverError(): AppError {
  return new AppError('SERVER_ERROR', STRINGS.errors.serverError, 500);
}

/**
 * Bulk-download cap exceeded — AC-216. Specialized validation error
 * surfaced with its own code so the UI can render the "too many files /
 * too large" copy without parsing the generic message.
 */
export interface BulkLimitDetails {
  limits: { maxFiles: number; maxBytes: number };
}

export function bulkLimitExceeded(details: BulkLimitDetails): AppError {
  return new AppError('BULK_LIMIT_EXCEEDED', STRINGS.errors.invalidInput, 422, details);
}

/**
 * Per-row envelope unwrap failure — ADR-0024 / api.md §14.2.11
 * download-url error paths. The route returns this on a corrupt
 * `wrappedDek` (or `wrappedThumbDek` for thumbnail variant), or when
 * the row's envelope was wrapped to a different recipient than the
 * currently-loaded binary identity (partial key rotation). The SW
 * translates the code to the AC-244 "Schlüssel nicht verfügbar"
 * placeholder render path. A wholesale "identity not loaded" failure
 * is a different surface (500 SERVER_ERROR — the boot probe blocks
 * startup, so it should never reach a live request).
 */
export function dekUnwrapFailed(): AppError {
  return new AppError('DEK_UNWRAP_FAILED', STRINGS.errors.invalidInput, 422);
}

// ---------------------------------------------------------------------
// Invoice + company-profile domain errors (ADR-0026, api.md §14.4)
// ---------------------------------------------------------------------

/**
 * Mutation rejected on an issued or cancelled invoice row. AC-286 / §6.14:
 * issued rows are write-once at the persistence layer; the route surface
 * rejects PATCH / DELETE / non-cancellation mutations with this code
 * before the persistence-layer backstop fires.
 */
export function invoiceFrozen(): AppError {
  return new AppError('INVOICE_FROZEN', STRINGS.errors.invoiceFrozen, 422);
}

/**
 * Issue call rejected because the parent project is not in
 * `rechnung_faellig`. AC-289 / api.md §14.2.14 error paths.
 */
export function invoiceProjectState(): AppError {
  return new AppError('INVOICE_PROJECT_STATE', STRINGS.errors.invoiceProjectState, 409);
}

/**
 * Cancel / PDF-download rejected because the row is still a draft.
 * AC-291 (cancel-on-draft) and AC-299 (download-on-draft).
 */
export function invoiceNotIssued(): AppError {
  return new AppError('INVOICE_NOT_ISSUED', STRINGS.errors.invoiceNotIssued, 409);
}

/**
 * Cancel rejected because the row is already cancelled. AC-291.
 */
export function invoiceAlreadyCancelled(): AppError {
  return new AppError('INVOICE_ALREADY_CANCELLED', STRINGS.errors.invoiceAlreadyCancelled, 409);
}

/**
 * Issue / company-profile-upsert rejected because the singleton
 * `company_profile` row lacks one or more fields required for the
 * resolved `taxMode`. AC-289(i) / AC-303 / AC-305.
 *
 * `details.missingFields` enumerates the offending field paths so the
 * UI can target the right input(s).
 */
export interface CompanyProfileRequiredDetails {
  missingFields: string[];
}

export function companyProfileRequired(details: CompanyProfileRequiredDetails): AppError {
  return new AppError(
    'COMPANY_PROFILE_REQUIRED',
    STRINGS.errors.companyProfileRequired,
    422,
    details,
  );
}

/**
 * Customer delete rejected — at least one of the customer's projects
 * (active or archived) carries an issued or cancelled invoice. AC-307.
 * `details.invoiceCount` carries the count of issued + cancelled rows
 * (drafts excluded — they cascade-delete with their project).
 */
export interface InvoiceRetentionDetails {
  invoiceCount: number;
}

export function customerHasInvoices(details: InvoiceRetentionDetails): AppError {
  return new AppError('CUSTOMER_HAS_INVOICES', STRINGS.errors.customerHasInvoices, 409, details);
}

/**
 * Project purge rejected — the project carries at least one issued or
 * cancelled invoice. AC-308. Distinct from the generic CONFLICT used
 * for the non-archived purge precondition (AC-156).
 */
export function projectHasInvoices(details: InvoiceRetentionDetails): AppError {
  return new AppError('PROJECT_HAS_INVOICES', STRINGS.errors.projectHasInvoices, 409, details);
}

/**
 * Bulk-export rejected — at least one requested invoice id resolves to a
 * draft row. Drafts carry no rendered PDF and have no legal weight, so
 * including them in the ZIP would either yield empty PDFs or surface
 * an INVOICE_NOT_ISSUED mid-stream after partial bytes have already
 * left the wire. `details.invoiceId` is the offending draft's id so the
 * UI can target the row in the user's selection.
 */
export interface DraftNotExportableDetails {
  invoiceId: string;
}

export function draftNotExportable(details: DraftNotExportableDetails): AppError {
  return new AppError('DRAFT_NOT_EXPORTABLE', STRINGS.errors.draftNotExportable, 422, details);
}

/**
 * Bulk-export rejected — the filter matches more invoices than the
 * server is willing to bundle into a single ZIP. The caller must
 * narrow the filter (typically by year) and retry. `details.total` is
 * the matched-row count; `details.cap` is the configured ceiling so
 * the UI can phrase a precise message.
 */
export interface ExportTooLargeDetails {
  total: number;
  cap: number;
}

export function exportTooLarge(details: ExportTooLargeDetails): AppError {
  return new AppError(
    'EXPORT_TOO_LARGE',
    STRINGS.errors.exportTooLarge(details.total, details.cap),
    422,
    details,
  );
}
