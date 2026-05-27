/**
 * Unified data-exchange contract (ADR-0018, data-model.md §5.8).
 *
 * Canonical types shared between server and UI. Lives in the domain layer
 * so both halves can import it without violating the eslint.config.js
 * layer boundary (UI cannot import from src/server/**).
 */

import type { WorkflowState } from '@/config/stateConfig';
import type { ThemePreference } from '@/config/themeStorage';
import type { Address } from './types';
import type {
  InvoiceIssuerSnapshot,
  InvoiceLine,
  InvoiceProfile,
  InvoiceRecipientSnapshot,
  InvoiceSequenceKind,
  InvoiceStatus,
  InvoiceTotals,
  TaxMode,
} from './invoice';

/**
 * Monotonic envelope-format version. Imports reject any mismatch outright —
 * no format-migration code (ADR-0018). Bumped to `3` when the envelope
 * expanded to cover all user-meaningful business state (issue #230): the
 * `users`, `company_profile`, `invoices`, and `invoice_sequence` slots
 * were added, and `customers.ustId` was filled in (pre-existing drift —
 * the schema has carried the field since invoicing landed). Pre-#230
 * (`v2`) envelopes are not consumable on the importing instance and are
 * rejected via SCHEMA_VERSION_MISMATCH.
 */
export const SCHEMA_VERSION = 3;

export interface EnvelopeCustomer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: Address | null;
  ustId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface EnvelopeProject {
  id: string;
  number: string;
  title: string;
  status: WorkflowState;
  statusChangedAt: string;
  customerId: string;
  /**
   * Baustellen-/Leistungsadresse — distinct from the customer's
   * Rechnungsadresse (`EnvelopeCustomer.address`). Null means the site
   * is at the customer's billing address (data-model.md §5.1).
   */
  siteAddress: Address | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  estimatedValue: string | null;
  notes: string | null;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface EnvelopeAssignment {
  projectId: string;
  userId: string;
}

/**
 * Attachment row in the export envelope — `status = 'ready'` only per
 * data-model.md §5.8. Bytes remain storage-owned (ADR-0018); this
 * envelope carries only the metadata row.
 *
 * Under the takeout-zip restore design (issue #163) crypto fields
 * (`wrappedDek`, `wrappedThumbDek`, `wrappedDekVersion`), opaque
 * storage keys (`originalKey`, `thumbKey`), and ciphertext sizes
 * (`ciphertextSizeBytes`, `ciphertextThumbSizeBytes`) are NOT carried
 * on the envelope: they are not consumable on the importing instance,
 * and the wrapped envelopes additionally remain inside the exporting
 * instance's confidentiality boundary (ADR-0024). The client
 * orchestrator re-uploads each attachment via the standard `init`
 * (with `restore` block) + presigned PUT + `complete` pipeline — fresh
 * DEKs are minted in the browser and wrapped under the importing
 * instance's `BINARY_AGE_RECIPIENT`.
 */
export interface EnvelopeAttachment {
  id: string;
  projectId: string;
  status: 'ready';
  kind: 'photo' | 'binary';
  label: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  createdBy: string | null;
}

/**
 * User row in the envelope. Issue #230: `users` round-trips through Layer 1
 * so an export → import on a fresh install reproduces the operator's user
 * set without an out-of-band password-reset pass. `passwordHash` ships
 * verbatim — the salted hash is no more PII-sensitive than the addresses
 * and invoice line items already in the artifact, and excluding it would
 * break the round-trip. See data-model.md §5.3 / §5.7 for field semantics.
 */
export interface EnvelopeUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  roles: string[];
  email: string | null;
  active: boolean;
  themePreference: ThemePreference;
  pushMuted: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

/**
 * Singleton company-profile row. The wire shape mirrors `CompanyProfile`
 * (domain/invoice.ts) but is duplicated here so the envelope contract
 * evolves independently of the API read shape — same pattern as
 * `EnvelopeCustomer` vs. the read-side `Customer`. `logoBinaryDescriptorId`
 * references an attachment row carried by the takeout-zip binary leg
 * (ADR-0024); the envelope row only persists the reference. See
 * data-model.md §5.17 and ADR-0026.
 */
export interface EnvelopeCompanyProfile {
  id: string;
  companyName: string;
  address: { street: string; zip: string; city: string };
  taxId: string;
  ustId: string | null;
  iban: string | null;
  accentColor: string | null;
  footerText: string | null;
  logoBinaryDescriptorId: string | null;
  defaultTaxMode: TaxMode;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Immutable issued invoice snapshot. Every contributing value (issuer,
 * recipient, lines, totals, profile) is copied onto the row at issuance
 * and frozen thereafter (ADR-0026, data-model.md §5.15). Storno rows
 * carry a non-null `cancellationOf`; the importer inserts non-Storno
 * rows first and Storno rows second to satisfy the self-FK without
 * needing a deferrable constraint. `renderedPdfBinaryDescriptorId`
 * references an attachment row carried by the takeout-zip binary leg.
 */
export interface EnvelopeInvoice {
  id: string;
  projectId: string;
  status: InvoiceStatus;
  number: string | null;
  issueDate: string | null;
  performanceDate: string | null;
  taxMode: TaxMode;
  profile: InvoiceProfile;
  issuer: InvoiceIssuerSnapshot;
  recipient: InvoiceRecipientSnapshot;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  cancellationOf: string | null;
  cancellationReason: string | null;
  renderedPdfBinaryDescriptorId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

/**
 * Year-scoped gapless invoice-number counter. Round-trips alongside the
 * invoice rows so the importing instance allocates the next number
 * correctly without observing the imported invoice set (data-model.md
 * §5.16, ADR-0026 §Data model). One row per (year, kind).
 */
export interface EnvelopeInvoiceSequence {
  year: number;
  kind: InvoiceSequenceKind;
  nextValue: number;
  updatedAt: string;
}

export interface Envelope {
  schema_version: number;
  exported_at: string;
  /**
   * Users — every row in the `users` table, including inactive accounts.
   * Issue #230: `users` round-trips through Layer 1 so the importing
   * instance reproduces the operator's user set. `passwordHash` ships
   * verbatim per the threat-model note in issue #230 (the artifact is
   * already plaintext owner-only PII).
   */
  users: EnvelopeUser[];
  /**
   * Singleton company-profile row. Always exactly one element — the row
   * is pre-seeded by the baseline migration and the schema enforces a
   * singleton CHECK + UNIQUE. The envelope carries it as an array for
   * uniformity; the importer validates `length === 1`.
   */
  company_profile: EnvelopeCompanyProfile[];
  customers: EnvelopeCustomer[];
  projects: EnvelopeProject[];
  project_workers: EnvelopeAssignment[];
  /**
   * Immutable issued invoice snapshots, ordered by
   * `(cancellation_of NULLS FIRST, id)` so the importer's two-pass insert
   * sees originals before Stornos and can slice the list at the first
   * row with a non-null `cancellationOf`.
   */
  invoices: EnvelopeInvoice[];
  /**
   * Year-scoped gapless invoice-number counters. Restored alongside
   * `invoices` so next-number allocation continues from the imported
   * peak rather than restarting at 1.
   */
  invoice_sequence: EnvelopeInvoiceSequence[];
  /**
   * Attachments — every row with `status = 'ready'`. The export emits
   * the field unconditionally (empty array when no ready rows exist);
   * the business-data import (`ImportService`) never inserts attachment
   * rows and ignores any `attachments` key on the envelope
   * (issue #163 / AC-253) — the field rides the takeout zip, not the
   * import envelope.
   */
  attachments: EnvelopeAttachment[];
}

export interface ImportOptions {
  dryRun: boolean;
  override: boolean;
  /**
   * Typed confirmation phrase from the caller. Required by the server when
   * `override` is true AND the target database is non-empty (AC-160);
   * ignored on the dry-run and empty-target paths. `null` indicates the
   * request body omitted the field entirely.
   */
  confirmationPhrase: string | null;
  /**
   * When `false`, the `import_restored` audit row is suppressed. Defaults
   * to `true` (a direct `ImportService` call writes the row). The server-side
   * import JOB sets this to `false` so it can write the single terminal
   * `data_import` audit row itself — at the end of Pass 2, after attachment
   * rows have been inserted — giving it sole audit ownership (AC-332).
   */
  writeAuditRow?: boolean;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * One envelope reference site whose `userId` is absent from the target
 * `users` table. `path` follows the same shape as `ValidationIssue.path`
 * (e.g. `customers[0].createdBy`, `project_workers[2].userId`).
 */
export interface MissingUserReference {
  path: string;
  userId: string;
}

/**
 * Payload for the `MISSING_USER_REFS` error code and the dry-run preview.
 * See api.md §14.4.1.
 */
export interface MissingUserRefsPayload {
  missingUserIds: string[];
  references: MissingUserReference[];
}

export interface DryRunPreview {
  schema_version: number;
  /**
   * True when at least one of the importable tables (users,
   * company_profile beyond the seeded singleton, customers, projects,
   * project_workers, invoices, invoice_sequence, attachments) has rows
   * at dry-run time. The UI uses this to gate the override-warning
   * checkbox; the server still enforces `TARGET_NOT_EMPTY` on commit
   * when override is not set (defense in depth).
   */
  target_non_empty: boolean;
  would_write: {
    users: number;
    company_profile: number;
    customers: number;
    projects: number;
    project_workers: number;
    invoices: number;
    invoice_sequence: number;
  };
  validation_errors: ValidationIssue[];
  /**
   * Missing-user references surfaced by the dry-run path (AC-162b). The
   * commit-path error code `MISSING_USER_REFS` uses the same payload shape
   * under `details`. The spec (api.md §14.2.4) deliberately does not mint
   * a wire-field name for the preview, so this sibling field carries the
   * same payload shape as the commit-path `details` for symmetry. `null`
   * when no missing references were found; optional so pre-existing test
   * fixtures that only care about `validation_errors` remain valid without
   * spelling it out.
   */
  missing_user_refs?: MissingUserRefsPayload | null;
}

export interface ImportResult {
  schema_version: number;
  summary: {
    users: number;
    company_profile: number;
    customers: number;
    projects: number;
    project_workers: number;
    invoices: number;
    invoice_sequence: number;
  };
  /**
   * `true` when the import wiped-and-replaced an existing `users` set
   * (override=true into a non-empty target). The wipe cascades to
   * `sessions` via `ON DELETE CASCADE`, so the operator's session token
   * is gone before this response reaches the client. The UI uses this
   * flag to redirect to login cleanly rather than hitting a 401 on the
   * next call. `false` in every other code path (dry-run never reaches
   * the commit; empty-target inserts into empty tables; envelopes
   * without users — once another path produces one — would not wipe).
   */
  sessionInvalidated: boolean;
}
