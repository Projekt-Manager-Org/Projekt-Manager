/**
 * Unified business-data export. See ADR-0018 and data-model.md §5.8.
 */

import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import {
  attachments,
  companyProfile,
  customers,
  invoiceSequence,
  invoices,
  projects,
  projectWorkers,
  users,
} from '../db/schema.js';
import { SCHEMA_VERSION, type Envelope } from '../../domain/dataExchange.js';
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
   * Deterministic ordering across all tables so AT-77 can byte-compare
   * successive exports after a roundtrip.
   *
   * Issue #230: `users`, `company_profile`, `invoices`, and
   * `invoice_sequence` ride the envelope alongside the original three
   * (customers, projects, project_workers) plus the metadata-only
   * `attachments` slot, so a snapshot reproduces the full operator-
   * meaningful business state. Every SELECT runs inside the same
   * `REPEATABLE READ READ ONLY` transaction so the export is a single
   * consistent snapshot — no torn reads between tables.
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
    } = await this.db.transaction(
      async (tx) => {
        // Sequential — drizzle runs each tx query on the same pg client, so
        // Promise.all here would trigger pg's "concurrent query" deprecation
        // warning without any real parallelism.
        const userRows = await tx.select().from(users).orderBy(asc(users.id));
        // Singleton table — one row enforced by UNIQUE(singleton) +
        // CHECK(singleton = true). The `ORDER BY id ASC` is defensive
        // uniformity: it costs nothing and pins ordering if a future
        // migration ever relaxes the singleton invariant.
        const companyProfileRows = await tx
          .select()
          .from(companyProfile)
          .orderBy(asc(companyProfile.id));
        const customerRows = await tx.select().from(customers).orderBy(asc(customers.id));
        const projectRows = await tx.select().from(projects).orderBy(asc(projects.id));
        const assignmentRows = await tx
          .select()
          .from(projectWorkers)
          .orderBy(asc(projectWorkers.projectId), asc(projectWorkers.userId));
        // Originals first, Stornos second — the importer's two-pass
        // insert relies on this ordering to satisfy the self-FK
        // (`cancellation_of → invoices.id`) without a deferrable
        // constraint. Postgres treats `(cancellation_of IS NULL)` as a
        // boolean expression that can sit in ORDER BY directly; DESC on
        // a boolean puts TRUE (i.e. originals) first, FALSE (Stornos)
        // last. `id` ASC is the deterministic tiebreaker so a re-export
        // is byte-stable.
        const invoiceRows = await tx
          .select()
          .from(invoices)
          .orderBy(sql`(${invoices.cancellationOf} IS NULL) DESC`, asc(invoices.id));
        const invoiceSequenceRows = await tx
          .select()
          .from(invoiceSequence)
          .orderBy(asc(invoiceSequence.year), asc(invoiceSequence.kind));
        // AC-220: only ready rows travel in the envelope. Pending rows
        // represent uncommitted uploads and are excluded by design.
        const attachmentRows = await tx
          .select()
          .from(attachments)
          .where(eq(attachments.status, 'ready'))
          .orderBy(asc(attachments.id));
        return {
          userRows,
          companyProfileRows,
          customerRows,
          projectRows,
          assignmentRows,
          invoiceRows,
          invoiceSequenceRows,
          attachmentRows,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

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
        logoBinaryDescriptorId: cp.logoBinaryDescriptorId ?? null,
        defaultTaxMode: cp.defaultTaxMode as TaxMode,
        updatedAt: cp.updatedAt.toISOString(),
        updatedBy: cp.updatedBy ?? null,
      })),
      // `toCustomerResponse` already projects `ustId` (pre-existing
      // drift in the envelope shape pre-#230); the upgraded contract
      // now consumes the field directly.
      customers: customerRows.map(toCustomerResponse),
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
      // Issue #163: metadata-only descriptor. Crypto fields, opaque
      // storage keys, and ciphertext sizes are NOT consumable on the
      // importing instance and are therefore omitted; the client
      // orchestrator re-uploads each attachment via the standard
      // `init` (with `restore` block) + presigned PUT + `complete`
      // pipeline against the importing instance (api.md §14.2.4 /
      // §14.2.11, AC-220, AC-256).
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
