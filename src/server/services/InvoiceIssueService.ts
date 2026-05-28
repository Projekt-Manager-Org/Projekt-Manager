/**
 * Invoice issuance atom — split off `InvoiceService` per C-SIZE.
 *
 * The issuance transaction is the load-bearing primitive — one DB
 * transaction commits:
 *
 *   1. Atomic `INSERT … ON CONFLICT (year, kind) DO UPDATE
 *      … RETURNING next_value` on `invoice_sequence` for
 *      `(year, 'invoice')` — single statement covers both
 *      first-of-year and steady-state. Postgres takes a row-exclusive
 *      lock on the row, equivalent to `SELECT FOR UPDATE`, held until
 *      commit — a rollback returns the value to the sequence (gapless
 *      property).
 *   2. Issuer snapshot from the live `company_profile` row.
 *   3. Recipient snapshot — live customer overlaid with body overrides.
 *   4. UPDATE the draft row to `status='issued'`, set `number`,
 *      `issueDate`, `taxMode`, `profile`, `issuer`, `recipient`, `lines`,
 *      `totals`, `performanceDate`.
 *   5. Server-computed totals from `lines + taxMode`.
 *   6. Renderer call.
 *   7. Persist the binary descriptor through the ADR-0022 / ADR-0024
 *      pipeline (`InvoiceBinaryService.persistRendered`).
 *   8. UPDATE the row to attach the binary descriptor reference.
 *   9. UPDATE the parent project `status` to `'abgerechnet'`.
 *  10. Audit row via `mutate()` (action=`invoice:issue`,
 *      ancestor=`('project', projectId)`).
 *  11. Commit. Post-commit: `emitInvoiceChanged()` AND
 *      `emitProjectChanged()` (AC-287, AT-111 — the project status
 *      flipped to `abgerechnet` in the same tx, so both surfaces
 *      invalidate).
 */

import { eq, and } from 'drizzle-orm';
import type { Database, MutatingDatabase } from '../db/connection.js';
import { projects } from '../db/schema.js';
import type { ServiceLogger } from './Logger.js';
import { mutate } from './mutate.js';
import { projectAuditLabel } from '../../domain/audit.js';
import { getProjectRowById } from '../repositories/project.js';
import {
  computeInvoiceTotals,
  type Invoice,
  type InvoiceLine,
  type InvoiceIssuerSnapshot,
  type InvoiceRecipientSnapshot,
  type TaxMode,
} from '../../domain/invoice.js';
import {
  toInvoiceResponse,
  getInvoiceRowForMutation,
  allocateInvoiceNumber,
  applyIssuanceUpdate,
  flipParentProjectStatusToAbgerechnet,
  type InvoiceRow,
} from '../repositories/invoice-read.js';
import { assertCompanyProfileCompleteForMode } from './CompanyProfileService.js';
import { InvoiceRenderer, type RenderedInvoice } from './InvoiceRenderer.js';
import { notFound, validationError, invoiceFrozen, invoiceProjectState } from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { emitInvoiceChanged, emitProjectChanged } from '../sse/emitters.js';
import { InvoiceBinaryService } from './InvoiceBinaryService.js';

export class InvoiceIssueService {
  private readonly renderer: InvoiceRenderer;
  constructor(
    private db: Database,
    private binary: InvoiceBinaryService,
    renderer?: InvoiceRenderer,
  ) {
    // Renderer is constructor-injected so the test mock seam in
    // `invoices-issue.test.ts:521-536` is honored — the mocked module's
    // class is what `new InvoiceRenderer()` resolves to in the test
    // process. In production the default constructor is fine.
    this.renderer = renderer ?? new InvoiceRenderer();
  }

  /**
   * The issuance transaction (AC-287). See module docstring for the
   * step list. Throws structured errors at each pre-condition failure
   * so the route maps to the documented status / code combinations
   * (AC-289 + AT-113).
   *
   * Post-commit emits ONE `invoice_changed` SSE event AND ONE
   * `project_changed` SSE event (AC-287, AT-111): a new issued row is
   * visible, and the parent project's `status` flipped to
   * `abgerechnet` inside the same transaction — both consumer surfaces
   * (invoice list / per-invoice viewer, Kanban / project list /
   * project detail) must invalidate.
   */
  async issueDraft(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
    // Clock seam — defaults to the wall clock in production. The seed
    // and tests inject a fixed Date to control `issueDate` AND the
    // gapless number-year allocation (both must agree, otherwise a
    // backdated `issueDate` would desync from the `RE-YYYY-NNNN`
    // sequence).
    now: Date = new Date(),
  ): Promise<Invoice> {
    const issued = await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'invoice',
        action: 'invoice:issue',
        run: async (tx) => this.runIssueInsideTx(tx, id, userId, now),
      },
    );
    log.info({ invoiceId: id }, 'invoice_issued');
    emitInvoiceChanged();
    // AC-287 / AT-111: the issuance flipped `projects.status` to
    // `abgerechnet` as part of the same transaction, so the project
    // surfaces must invalidate too. Cancellation deliberately does NOT
    // emit this (AC-290 — the cancel atom does not modify project
    // status).
    emitProjectChanged();
    return toInvoiceResponse(issued);
  }

  /**
   * The body of the issuance atom. Lives inside `mutate()` so the audit
   * row commits with every other change. Splitting it out keeps the
   * step list readable and lets `cancel()` reuse the snapshot/render
   * portion against the Storno's own sequence.
   */
  private async runIssueInsideTx(
    tx: MutatingDatabase,
    invoiceId: string,
    userId: string,
    now: Date,
  ): Promise<{
    entityId: string;
    entityLabel: string | null;
    value: InvoiceRow;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    ancestorEntityType: 'project';
    ancestorEntityId: string;
    ancestorEntityLabel: string;
  }> {
    const before = await getInvoiceRowForMutation(tx, invoiceId);
    if (!before) throw notFound(STRINGS.entities.invoice);
    if (before.status !== 'draft') throw invoiceFrozen();

    // 1. Pre-condition rejections — each maps to its documented code
    // (AC-289 / AT-113). Order matters: the cheaper checks (no DB
    // round-trip) run first so they don't waste a sequence lock.

    const lines = before.lines as InvoiceLine[];
    if (lines.length === 0) {
      throw validationError(STRINGS.errors.invalidInput, { missingFields: ['lines'] });
    }
    if (!before.performanceDate) {
      throw validationError(STRINGS.errors.invalidInput, { missingFields: ['performanceDate'] });
    }
    const recipient = before.recipient as InvoiceRecipientSnapshot;
    if (!recipient.name || recipient.name.length === 0) {
      throw validationError(STRINGS.errors.invalidInput, { missingFields: ['recipient.name'] });
    }
    if (!recipient.address || !recipient.address.street || recipient.address.street.length === 0) {
      throw validationError(STRINGS.errors.invalidInput, {
        missingFields: ['recipient.address.street'],
      });
    }
    if (!recipient.address.zip || recipient.address.zip.length === 0) {
      throw validationError(STRINGS.errors.invalidInput, {
        missingFields: ['recipient.address.zip'],
      });
    }
    if (!recipient.address.city || recipient.address.city.length === 0) {
      throw validationError(STRINGS.errors.invalidInput, {
        missingFields: ['recipient.address.city'],
      });
    }
    const taxMode = before.taxMode as TaxMode;
    if (taxMode === 'reverse_charge' && (!recipient.ustId || recipient.ustId.length === 0)) {
      throw validationError(STRINGS.errors.invalidInput, { missingFields: ['recipient.ustId'] });
    }

    // 2. Project state precondition — the project must be in
    //    `rechnung_faellig` for the issue to be legal.
    const projRows = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, before.projectId), eq(projects.deleted, false)))
      .limit(1);
    const project = projRows[0];
    if (!project) throw notFound(STRINGS.entities.project);
    if (project.status !== 'rechnung_faellig') {
      throw invoiceProjectState();
    }

    // 3. Company profile completeness — assertion reads inside the
    //    issuance tx so a concurrent profile mutation cannot
    //    invalidate the snapshot mid-issue. Throws
    //    `companyProfileRequired()` on incomplete state (AC-289(i),
    //    AT-113(i), AT-125). The throw rolls back the tx — no
    //    sequence allocation has been claimed yet, so AC-305's
    //    "release the lock without advancement" invariant is met by
    //    ordering: validate THEN allocate.
    const companyProfileRow = await assertCompanyProfileCompleteForMode(tx, taxMode);

    // 4. Allocate `number` from the gapless `(year, 'invoice')`
    //    sequence. The row lock survives until commit. The year MUST
    //    come from `now` (the clock seam) — not the wall clock — so a
    //    backdated `issueDate` stays consistent with `RE-YYYY-NNNN`.
    const year = now.getUTCFullYear();
    const { number } = await allocateInvoiceNumber(tx, year, 'invoice');

    // 5. Build the snapshot blocks (issuer is frozen from the live
    //    profile, recipient already lives on the row). The Storno path
    //    reuses the same snapshot shape.
    const issuer: InvoiceIssuerSnapshot = {
      companyName: companyProfileRow.companyName,
      address: companyProfileRow.address,
      taxId: companyProfileRow.taxId,
      ustId: companyProfileRow.ustId,
      iban: companyProfileRow.iban,
      footerText: companyProfileRow.footerText,
    };

    const totals = computeInvoiceTotals(lines, taxMode);
    const issueDate = now;

    // 6. Render BEFORE the UPDATE — the persistence-layer immutability
    //    trigger (data-model.md §6.14, baseline migration) blocks every
    //    UPDATE on an issued row except the cancellation-status flip,
    //    so the legacy "UPDATE to issued THEN UPDATE descriptor" two-
    //    step is rejected by Postgres on the second statement.
    //
    //    Why the preview snapshot is hand-rolled rather than fetched
    //    from the DB: the renderer must run BEFORE the UPDATE (the
    //    trigger blocks UPDATE-after-INSERT on issued rows), so there
    //    is no persisted issued row to read at this point. The
    //    snapshot is therefore constructed from the locally-resolved
    //    fields, and it MUST be byte-equal to what step 8's UPDATE
    //    writes — same `issuer`, `recipient`, `lines`, `totals`,
    //    `taxMode`, `profile`, `number`, `issueDate` — so the rendered
    //    bytes match the eventually-persisted row exactly. A throw
    //    inside `render()` rolls back the entire transaction; the
    //    sequence value returns to the pool (AC-288). The mock seam in
    //    `invoices-issue.test.ts:521-536` exercises this exact path.
    const previewInvoice: Invoice = {
      id: invoiceId,
      number,
      status: 'issued',
      projectId: before.projectId,
      cancellationOf: null,
      issuer,
      recipient,
      lines,
      taxMode,
      profile: 'zugferd-en16931',
      totals,
      issueDate: issueDate.toISOString().slice(0, 10),
      performanceDate: before.performanceDate
        ? before.performanceDate.toISOString().slice(0, 10)
        : null,
      cancellationReason: null,
      renderedPdfBinaryDescriptorId: null,
      createdAt: before.createdAt.toISOString(),
      updatedAt: issueDate.toISOString(),
      createdBy: before.createdBy,
      updatedBy: userId,
    };
    const rendered: RenderedInvoice = await this.renderer.render({
      invoice: previewInvoice,
      companyProfile: {
        id: companyProfileRow.id,
        companyName: companyProfileRow.companyName,
        address: companyProfileRow.address,
        taxId: companyProfileRow.taxId,
        ustId: companyProfileRow.ustId,
        iban: companyProfileRow.iban,
        accentColor: companyProfileRow.accentColor,
        footerText: companyProfileRow.footerText,
        logoBinaryDescriptorId: companyProfileRow.logoBinaryDescriptorId,
        defaultTaxMode: companyProfileRow.defaultTaxMode as TaxMode,
        updatedAt: companyProfileRow.updatedAt.toISOString(),
        updatedBy: companyProfileRow.updatedBy,
      },
    });

    // 7. Persist the binary descriptor through the ADR-0022 / ADR-0024
    //    pipeline: encrypt with a fresh DEK, wrap against the operator
    //    `age` recipient, `putObject` ciphertext, insert `attachments`
    //    row at `status='ready'`. Returns the descriptor id; we land
    //    it on the invoice row in step 8's single UPDATE.
    const renderedDescriptorId = await this.binary.persistRendered(
      tx,
      rendered,
      before.projectId,
      previewInvoice,
      userId,
    );

    // 8. ONE UPDATE that flips draft→issued and writes the descriptor
    //    in the same statement (so the immutability trigger sees a
    //    single transition from draft, not an UPDATE of an already-
    //    issued row).
    const issuedRow = await applyIssuanceUpdate(tx, invoiceId, {
      number,
      issueDate,
      issuer,
      recipient,
      lines,
      totals,
      taxMode,
      profile: 'zugferd-en16931',
      renderedPdfBinaryDescriptorId: renderedDescriptorId,
      updatedBy: userId,
    });

    // 9. Flip the parent project's status to `abgerechnet` inside
    //    this same tx (the project transition is part of the issue
    //    atom — AC-287). The repo function holds the ADR-0026
    //    rationale (side-effect of issuance, not its own audit event).
    await flipParentProjectStatusToAbgerechnet(tx, before.projectId, userId, issueDate);

    // Snapshot the parent project's audit label inside this tx so the
    // audit row's `ancestorEntityLabel` matches the post-flip state.
    // The FK from invoice→project guarantees existence; a missing row
    // here is a programmer/integrity error and we refuse to write a
    // half-formed audit entry.
    const projectRow = await getProjectRowById(tx, before.projectId);
    if (!projectRow) {
      throw new Error(
        `runIssueInsideTx: project ${before.projectId} missing for invoice ${invoiceId}`,
      );
    }

    return {
      entityId: invoiceId,
      entityLabel: number,
      value: issuedRow,
      before: {
        status: before.status,
        number: before.number,
        issueDate: before.issueDate,
      },
      after: {
        status: issuedRow.status,
        number: issuedRow.number,
        issueDate: issuedRow.issueDate,
        issuer: issuedRow.issuer,
        recipient: issuedRow.recipient,
        lines: issuedRow.lines,
        totals: issuedRow.totals,
        taxMode: issuedRow.taxMode,
        profile: issuedRow.profile,
        renderedPdfBinaryDescriptorId: issuedRow.renderedPdfBinaryDescriptorId,
      },
      ancestorEntityType: 'project',
      ancestorEntityId: before.projectId,
      ancestorEntityLabel: projectAuditLabel(projectRow),
    };
  }
}
