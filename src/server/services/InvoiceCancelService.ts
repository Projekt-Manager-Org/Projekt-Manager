/**
 * Invoice cancellation atom — split off `InvoiceService` per C-SIZE.
 *
 * Cancel mirrors the issuance atom against a `storno` sub-sequence,
 * with TWO audit rows (`invoice:cancel` on the original,
 * `invoice:issue` on the Storno — the Storno is itself an issuance)
 * and ONE SSE event.
 *
 * Rejections (AC-291):
 *   - draft → 409 `INVOICE_NOT_ISSUED`
 *   - cancelled → 409 `INVOICE_ALREADY_CANCELLED`
 */

import crypto from 'node:crypto';
import type { Database } from '../db/connection.js';
import type { ServiceLogger } from './Logger.js';
import { mutateInTx, dispatchAuditRows } from './mutate.js';
import { projectAuditLabel } from '../../domain/audit.js';
import { getProjectRowById } from '../repositories/project.js';
import type { AuditLogRow } from './audit-publisher.js';
import {
  computeInvoiceTotals,
  negateInvoiceLines,
  type Invoice,
  type InvoiceLine,
  type InvoiceIssuerSnapshot,
  type InvoiceRecipientSnapshot,
  type TaxMode,
  type InvoiceProfile,
} from '../../domain/invoice.js';
import {
  toInvoiceResponse,
  getInvoiceRowForMutation,
  allocateInvoiceNumber,
  insertStornoInvoice,
  applyCancellationFlip,
} from '../repositories/invoice-read.js';
import { readSingleton, toCompanyProfileResponse } from './CompanyProfileService.js';
import { InvoiceRenderer } from './InvoiceRenderer.js';
import { notFound, invoiceNotIssued, invoiceAlreadyCancelled } from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { emitInvoiceChanged } from '../sse/emitters.js';
import { InvoiceBinaryService } from './InvoiceBinaryService.js';

/**
 * Shape returned by the cancel call (api.md §14.2.14 — pinned exactly
 * as `{ original, storno }` per the wire contract assertion in
 * `invoices-cancel.test.ts:254`).
 */
export interface CancelResult {
  original: Invoice;
  storno: Invoice;
}

export interface CancelInput {
  reason?: string | null;
}

export class InvoiceCancelService {
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
   * Cancel an issued invoice — create the Stornorechnung sibling, flip
   * the original to `'cancelled'`, write TWO audit rows in one tx,
   * emit ONE SSE event post-commit (AC-290 / AT-114).
   *
   * Invariant: the cancel atom commits EXACTLY two audit rows AND
   * dispatches EXACTLY one SSE event. Because this path uses a bespoke
   * `db.transaction(...)` with two `mutateInTx(...)` calls (instead of
   * the single-action `mutate()` wrapper), the post-commit
   * `dispatchAuditRows(collected)` below is the manual replacement for
   * what `mutate()` would otherwise publish for us — it pumps both
   * collected audit rows through the same publisher in one shot. A
   * future maintainer adding state or steps to this path MUST preserve
   * that one-dispatch invariant: collect every audit row into
   * `collected`, do not introduce a second `dispatchAuditRows` call,
   * and do not let `mutate()` (with its built-in dispatch) sneak back
   * into the cancel atom — that would double-publish.
   *
   * Rejections (AC-291):
   *   - draft → 409 `INVOICE_NOT_ISSUED`
   *   - cancelled → 409 `INVOICE_ALREADY_CANCELLED`
   */
  async cancel(
    id: string,
    input: CancelInput,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
    // Clock seam — defaults to the wall clock in production. The seed
    // and tests inject a fixed Date to control the Storno's
    // `issueDate` AND the gapless number-year allocation (must agree,
    // otherwise a backdated Storno would desync from `ST-YYYY-NNNN`).
    now: Date = new Date(),
  ): Promise<CancelResult> {
    const ctx = {
      actorKind: 'user' as const,
      actorId: userId,
      correlationId: correlationId ?? null,
    };

    const collected: AuditLogRow[] = [];
    const result = await this.db.transaction(async (tx) => {
      const before = await getInvoiceRowForMutation(tx, id);
      if (!before) throw notFound(STRINGS.entities.invoice);
      if (before.status === 'draft') throw invoiceNotIssued();
      if (before.status === 'cancelled') throw invoiceAlreadyCancelled();

      // 1. Allocate from `(year, 'storno')`. Year derives from the
      //    clock seam so a backdated Storno keeps its number's year
      //    aligned with its `issueDate`.
      const year = now.getUTCFullYear();
      const { number: stornoNumber } = await allocateInvoiceNumber(tx, year, 'storno');

      // 2. Build the Storno's snapshot fields. Same rule as the issue
      //    path: the persistence-layer immutability trigger blocks
      //    UPDATEs on `status='issued'` rows except the cancellation
      //    flip, so we cannot INSERT-then-UPDATE-descriptor. Render
      //    first, then INSERT the Storno with the descriptor in one
      //    shot. Snapshots copied byte-for-byte from the original
      //    (AC-290): issuer / recipient / taxMode / profile /
      //    performanceDate.
      const stornoId = crypto.randomUUID();
      const stornoLines = negateInvoiceLines(before.lines as InvoiceLine[]);
      const stornoTotals = computeInvoiceTotals(stornoLines, before.taxMode as TaxMode);
      const cancellationReason =
        input.reason && input.reason.trim().length > 0 ? input.reason : null;

      // 3. Render the Storno PDF from the synthesised snapshot. A
      //    throw rolls back the whole cancel atom, including the
      //    sequence allocation. The company profile read shares the
      //    cancel transaction's snapshot — a concurrent PUT to the
      //    profile cannot drift the Storno's rendered visual style
      //    away from the persisted `issuer` block.
      const profileRow = await readSingleton(tx);
      const profile = toCompanyProfileResponse(profileRow);
      const stornoPreview: Invoice = {
        id: stornoId,
        number: stornoNumber,
        status: 'issued',
        projectId: before.projectId,
        cancellationOf: before.id,
        issuer: before.issuer as InvoiceIssuerSnapshot,
        recipient: before.recipient as InvoiceRecipientSnapshot,
        lines: stornoLines,
        taxMode: before.taxMode as TaxMode,
        profile: before.profile as InvoiceProfile,
        totals: stornoTotals,
        issueDate: now.toISOString().slice(0, 10),
        performanceDate: before.performanceDate
          ? before.performanceDate.toISOString().slice(0, 10)
          : null,
        cancellationReason,
        renderedPdfBinaryDescriptorId: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        createdBy: userId,
        updatedBy: userId,
      };
      const rendered = await this.renderer.render({
        invoice: stornoPreview,
        companyProfile: profile,
      });
      const stornoDescriptor = await this.binary.persistRendered(
        tx,
        rendered,
        before.projectId,
        stornoPreview,
        userId,
      );

      const stornoRow = await insertStornoInvoice(tx, {
        id: stornoId,
        projectId: before.projectId,
        number: stornoNumber,
        issueDate: now,
        performanceDate: before.performanceDate,
        taxMode: before.taxMode as TaxMode,
        profile: before.profile as InvoiceProfile,
        issuer: before.issuer as InvoiceIssuerSnapshot,
        recipient: before.recipient as InvoiceRecipientSnapshot,
        lines: stornoLines,
        totals: stornoTotals,
        cancellationOf: before.id,
        cancellationReason,
        renderedPdfBinaryDescriptorId: stornoDescriptor,
        createdBy: userId,
        updatedBy: userId,
      });

      // 4. Flip the original to `cancelled`.
      const originalRow = await applyCancellationFlip(tx, id, userId, now);

      // Snapshot the parent project's audit label once, inside the
      // same tx. Both audit rows below share the same ancestor; one
      // read keeps the label consistent and avoids two round-trips.
      // FK from invoice→project guarantees existence — a missing row
      // here is a programmer/integrity error.
      const projectRow = await getProjectRowById(tx, before.projectId);
      if (!projectRow) {
        throw new Error(`cancel: project ${before.projectId} missing for invoice ${id}`);
      }
      const ancestorLabel = projectAuditLabel(projectRow);

      // 5. Two audit rows in one tx (AC-290). Project status is
      //    deliberately NOT flipped — AC-290 trailing clause.
      const cancelAudit = await mutateInTx(tx, ctx, {
        entityType: 'invoice',
        action: 'invoice:cancel',
        run: async () => ({
          entityId: id,
          entityLabel: originalRow.number,
          value: originalRow,
          before: { status: before.status },
          after: { status: originalRow.status },
          ancestorEntityType: 'project',
          ancestorEntityId: before.projectId,
          ancestorEntityLabel: ancestorLabel,
        }),
      });
      collected.push(cancelAudit.auditRow);

      const stornoAudit = await mutateInTx(tx, ctx, {
        entityType: 'invoice',
        action: 'invoice:issue',
        run: async () => ({
          entityId: stornoId,
          entityLabel: stornoNumber,
          value: stornoRow,
          before: {},
          after: {
            status: stornoRow.status,
            number: stornoRow.number,
            cancellationOf: stornoRow.cancellationOf,
            issuer: stornoRow.issuer,
            recipient: stornoRow.recipient,
            lines: stornoRow.lines,
            totals: stornoRow.totals,
            taxMode: stornoRow.taxMode,
            profile: stornoRow.profile,
            cancellationReason: stornoRow.cancellationReason,
            renderedPdfBinaryDescriptorId: stornoRow.renderedPdfBinaryDescriptorId,
          },
          ancestorEntityType: 'project',
          ancestorEntityId: before.projectId,
          ancestorEntityLabel: ancestorLabel,
        }),
      });
      collected.push(stornoAudit.auditRow);

      return {
        original: toInvoiceResponse(originalRow),
        storno: toInvoiceResponse(stornoRow),
      };
    });

    // Post-commit dispatch — both audit rows ride the publisher.
    await dispatchAuditRows(collected);
    // Exactly ONE SSE frame for the cancel atom (AC-290 trailing
    // clause). Both rows changed; one invalidation is enough — the
    // client refetches the gated list anyway.
    emitInvoiceChanged();

    log.info({ invoiceId: id, stornoId: result.storno.id }, 'invoice_cancelled');
    return result;
  }
}
