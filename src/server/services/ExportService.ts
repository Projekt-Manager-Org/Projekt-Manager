/**
 * Unified business-data export. See ADR-0018 and data-model.md §5.8.
 */

import type { Database } from '../db/connection.js';
import { SCHEMA_VERSION, type Envelope } from '../../domain/dataExchange.js';
import { readBusinessSnapshot } from '../repositories/businessData.js';
import { toCustomerResponse } from '../repositories/customer.js';
import { isUnscoped } from '../repositories/scope.js';
import type { AuthUser } from '../middleware/auth.js';
import { formatDateOnly } from '../../domain/dateFormat.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import type { ThemePreference } from '../../config/themeStorage.js';
import type { AttachmentKind, AttachmentLabel } from '../../domain/types.js';
import type {
  InvoiceIssuerSnapshot,
  InvoiceLine,
  InvoiceProfile,
  InvoiceRecipientSnapshot,
  InvoiceSequenceKind,
  InvoiceStatus,
  InvoiceTotals,
  TaxMode,
} from '../../domain/invoice.js';

export class ExportService {
  constructor(private db: Database) {}

  /**
   * Export every row of the business-data layer as a single envelope.
   * Deterministic ordering across all tables so AC-594 can byte-compare
   * successive exports after a roundtrip.
   *
   * Issue #230: `users`, `company_profile`, `invoices`, and
   * `invoice_sequence` ride the envelope alongside the original three
   * (customers, projects, project_workers) plus the metadata-only
   * `attachments` slot, so a snapshot reproduces the full operator-
   * meaningful business state. `readBusinessSnapshot` runs every SELECT
   * inside one `REPEATABLE READ READ ONLY` transaction, so the export is a
   * single consistent snapshot — no torn reads between tables.
   *
   * The caller is threaded through as a fail-fast tripwire: this service
   * deliberately bypasses the per-caller scope seam (ADR-0019) because an
   * export is, by definition, the whole dataset. Today only owner/office
   * hold `data:export`, but if a scoped role ever gains it via permission
   * churn, this assertion fires before any row leaks. See ADR-0019
   * "Alternatives considered" for why scope is enforced at the seam rather
   * than in the permission check.
   */
  async export(caller: AuthUser): Promise<Envelope> {
    if (!isUnscoped(caller)) {
      throw new Error(
        `ExportService.export must be invoked with an unscoped caller; got roles=[${caller.roles.join(', ')}]`,
      );
    }

    const {
      userRows,
      companyProfileRows,
      customerRows,
      projectRows,
      assignmentRows,
      invoiceRows,
      invoiceSequenceRows,
      attachmentRows,
    } = await readBusinessSnapshot(this.db);

    return {
      schema_version: SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      // Issue #230: users round-trip through Layer 1. `passwordHash`
      // ships verbatim — the threat-model note on the contract type
      // (EnvelopeUser) calls out that the salted hash is no more PII-
      // sensitive than the addresses and invoice line items already in
      // the envelope, and excluding it would break the round-trip on a
      // fresh-install restore.
      users: userRows.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        passwordHash: u.passwordHash,
        roles: u.roles,
        email: u.email ?? null,
        active: u.active,
        themePreference: u.themePreference as ThemePreference,
        pushMuted: u.pushMuted,
        createdAt: u.createdAt.toISOString(),
        updatedAt: u.updatedAt.toISOString(),
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        createdBy: u.createdBy ?? null,
        updatedBy: u.updatedBy ?? null,
      })),
      // Singleton in steady state — the schema's UNIQUE(singleton) +
      // CHECK(singleton = true) keeps it that way. The envelope carries
      // the row as a one-element array for uniformity with every other
      // top-level slot; the importer validates `length === 1`.
      company_profile: companyProfileRows.map((cp) => ({
        id: cp.id,
        companyName: cp.companyName,
        address: cp.address,
        taxId: cp.taxId,
        ustId: cp.ustId ?? null,
        iban: cp.iban ?? null,
        accentColor: cp.accentColor ?? null,
        footerText: cp.footerText ?? null,
        defaultTaxMode: cp.defaultTaxMode as TaxMode,
        updatedAt: cp.updatedAt.toISOString(),
        updatedBy: cp.updatedBy ?? null,
      })),
      // `toCustomerResponse` already projects `ustId` (pre-existing
      // drift in the envelope shape pre-#230); the upgraded contract
      // now consumes the field directly. `version` is a concurrency
      // token, not business data — never exported (data-model.md §6.4).
      customers: customerRows.map((c) => {
        const { version: _version, ...customer } = toCustomerResponse(c);
        return customer;
      }),
      projects: projectRows.map((p) => ({
        id: p.id,
        number: p.number,
        title: p.title,
        status: p.status as WorkflowState,
        statusChangedAt: p.statusChangedAt.toISOString(),
        customerId: p.customerId,
        siteAddress: p.siteAddress ?? null,
        plannedStart: p.plannedStart ? formatDateOnly(p.plannedStart) : null,
        plannedEnd: p.plannedEnd ? formatDateOnly(p.plannedEnd) : null,
        estimatedValue: p.estimatedValue,
        notes: p.notes,
        deleted: p.deleted,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        createdBy: p.createdBy,
        updatedBy: p.updatedBy,
      })),
      project_workers: assignmentRows.map((a) => ({
        projectId: a.projectId,
        userId: a.userId,
      })),
      // `issue_date` / `performance_date` are `date` columns; emit as
      // `YYYY-MM-DD` strings via `formatDateOnly` to dodge the UTC-slice
      // off-by-one that bit `toISOString().slice(0, 10)` in non-UTC
      // server timezones (see formatDateOnly's docstring). Casts on the
      // JSONB columns mirror `toInvoiceResponse` in repositories/
      // invoice-read.ts — the schema declares them as `jsonb` without a
      // `$type<>()` annotation, so the typed shape lives at the
      // projection boundary.
      invoices: invoiceRows.map((i) => ({
        id: i.id,
        projectId: i.projectId,
        status: i.status as InvoiceStatus,
        number: i.number,
        issueDate: i.issueDate ? formatDateOnly(i.issueDate) : null,
        performanceDate: i.performanceDate ? formatDateOnly(i.performanceDate) : null,
        taxMode: i.taxMode as TaxMode,
        profile: i.profile as InvoiceProfile,
        issuer: i.issuer as InvoiceIssuerSnapshot,
        recipient: i.recipient as InvoiceRecipientSnapshot,
        lines: i.lines as InvoiceLine[],
        totals: i.totals as InvoiceTotals,
        cancellationOf: i.cancellationOf,
        cancellationReason: i.cancellationReason,
        renderedPdfBinaryDescriptorId: i.renderedPdfBinaryDescriptorId,
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
        createdBy: i.createdBy,
        updatedBy: i.updatedBy,
      })),
      invoice_sequence: invoiceSequenceRows.map((s) => ({
        year: s.year,
        kind: s.kind as InvoiceSequenceKind,
        nextValue: s.nextValue,
        updatedAt: s.updatedAt.toISOString(),
      })),
      // Metadata-only descriptor. Crypto fields, opaque storage keys,
      // and ciphertext sizes are NOT consumable on the importing
      // instance and are therefore omitted; the import job re-encrypts
      // server-side (AC-431, AC-594).
      attachments: attachmentRows.map((a) => ({
        id: a.id,
        projectId: a.projectId,
        status: 'ready' as const,
        kind: a.kind as AttachmentKind,
        label: a.label as AttachmentLabel,
        fileName: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        createdAt: a.createdAt.toISOString(),
        createdBy: a.createdBy,
      })),
    };
  }
}
