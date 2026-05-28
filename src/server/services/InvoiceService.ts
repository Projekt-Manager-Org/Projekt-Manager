/**
 * Invoice service — slim orchestrator. Owns list / get + draft CRUD;
 * delegates issuance, cancellation and PDF download to focused sibling
 * services (`InvoiceIssueService`, `InvoiceCancelService`,
 * `InvoiceBinaryService`).
 *
 * Architectural rationale: ADR-0026.
 * Entity: data-model.md §5.15 (Invoice), §5.16 (Sequence), §5.17 (Profile).
 * Wire contract: api.md §14.2.14.
 * Verification: AC-285..AC-308, AT-109..AT-128.
 *
 * Every mutation rides the single-write `mutate()` / `mutateInTx()`
 * path (ADR-0021). The issuance / cancellation atoms live in their
 * own services; the orchestrator handles permission / scope triage
 * for read-side surfaces and forwards the rest verbatim.
 */

import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { projects, customers } from '../db/schema.js';
import type { AuthUser } from '../middleware/auth.js';
import type { ServiceLogger } from './Logger.js';
import { mutate } from './mutate.js';
import { projectAuditLabel } from '../../domain/audit.js';
import { getProjectRowById } from '../repositories/project.js';
import {
  computeInvoiceTotals,
  TAX_MODES,
  type Invoice,
  type InvoiceLine,
  type InvoiceIssuerSnapshot,
  type InvoiceRecipientSnapshot,
  type TaxMode,
  type InvoiceProfile,
} from '../../domain/invoice.js';
import {
  toInvoiceResponse,
  listInvoices as listInvoicesRepo,
  listInvoiceYears as listInvoiceYearsRepo,
  getInvoice as getInvoiceRepo,
  getInvoiceRowForMutation,
  insertInvoiceDraft,
  updateInvoiceDraft,
  deleteInvoiceDraft,
  type ListInvoicesOpts,
} from '../repositories/invoice-read.js';
import { CompanyProfileService } from './CompanyProfileService.js';
import { notFound, notPermitted, validationError, invoiceFrozen } from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { isOutOfScope } from '../repositories/scope.js';
import { emitInvoiceChanged } from '../sse/emitters.js';
import { InvoiceBinaryService, type InvoiceBinaryDeps } from './InvoiceBinaryService.js';
import { InvoiceIssueService } from './InvoiceIssueService.js';
import {
  InvoiceCancelService,
  type CancelInput,
  type CancelResult,
} from './InvoiceCancelService.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';

/** Re-export the read-side opts shape so routes don't import the repo. */
export type { ListInvoicesOpts };
/** Re-export the binary-deps shape so routes can build it. */
export type { InvoiceBinaryDeps };
/** Re-export the cancel result so routes don't reach into the sibling service. */
export type { CancelResult };

/**
 * Parse an ISO-8601 `YYYY-MM-DD` date with calendar validity. The route
 * regex only enforces structural shape (`^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$`),
 * which admits e.g. `2026-02-30`. Passing such a string to `new Date()`
 * silently normalizes to `2026-03-02`; the shifted value would land in
 * the immutable issued snapshot, `factur-x.xml`, and the rendered PDF —
 * a §147 AO / GoBD data-integrity defect. Round-trip via `Date.UTC` and
 * reject any input whose Y/M/D parts don't equal the constructed Date's
 * Y/M/D parts.
 */
function parseCalendarDate(input: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) throw validationError(STRINGS.errors.invalidInput);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  return date;
}

/** Validate that every line's shape is the contract's. Server re-derives totals. */
function validateInvoiceLines(lines: InvoiceLine[]): void {
  if (!Array.isArray(lines)) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  for (const line of lines) {
    if (typeof line.description !== 'string') throw validationError(STRINGS.errors.invalidInput);
    if (typeof line.quantity !== 'number') throw validationError(STRINGS.errors.invalidInput);
    if (typeof line.unit !== 'string') throw validationError(STRINGS.errors.invalidInput);
    if (typeof line.unitPrice !== 'number') throw validationError(STRINGS.errors.invalidInput);
    if (typeof line.lineTotal !== 'number') throw validationError(STRINGS.errors.invalidInput);
    if (typeof line.taxRate !== 'number') throw validationError(STRINGS.errors.invalidInput);
  }
}

export interface CreateDraftInput {
  projectId: string;
  lines?: InvoiceLine[];
  recipient?: InvoiceRecipientSnapshot;
  taxMode?: TaxMode;
  performanceDate?: string | null;
}

export interface UpdateDraftInput {
  lines?: InvoiceLine[];
  recipient?: InvoiceRecipientSnapshot;
  taxMode?: TaxMode;
  performanceDate?: string | null;
}

export class InvoiceService {
  constructor(
    private db: Database,
    private issue: InvoiceIssueService,
    private cancel_: InvoiceCancelService,
    private binary: InvoiceBinaryService,
  ) {}

  // -------------------------------------------------------------------
  // List + Get
  // -------------------------------------------------------------------

  /**
   * List visible invoices. Worker callers receive `[]` (AC-298) by
   * construction of the repository predicate; permission gating is
   * the route layer's job. The service is callable from any
   * authenticated context — readers without `invoice:read` are
   * rejected upstream.
   */
  async list(caller: AuthUser, opts: ListInvoicesOpts = {}) {
    return listInvoicesRepo(this.db, caller, opts);
  }

  /**
   * Distinct years that appear in `issueDate` across the caller's
   * visible invoices. Drives the year-filter dropdown on
   * `/rechnungen` — independent of the active filter so picking
   * year=N does not collapse the dropdown to just N.
   */
  async listYears(caller: AuthUser): Promise<number[]> {
    return listInvoiceYearsRepo(this.db, caller);
  }

  /**
   * Three-way result (AC-298): row → 200 / OUT_OF_SCOPE → 403 / null → 404.
   */
  async get(caller: AuthUser, id: string): Promise<Invoice> {
    const result = await getInvoiceRepo(this.db, caller, id);
    if (result === null) throw notFound(STRINGS.entities.invoice);
    if (isOutOfScope(result)) throw notPermitted();
    return result;
  }

  // -------------------------------------------------------------------
  // PDF download (delegates after orchestrator-side permission triage)
  // -------------------------------------------------------------------

  /**
   * Resolve the rendered PDF for an issued / cancelled invoice and
   * return the plaintext bytes plus the suggested filename.
   *
   * The orchestrator does the `get()` triage here so permission / scope
   * stay in the orchestration layer. The binary service then applies
   * the draft `INVOICE_NOT_ISSUED` rejection and performs the
   * descriptor lookup + decrypt.
   */
  async downloadPdf(
    caller: AuthUser,
    id: string,
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    const invoice = await this.get(caller, id);
    return this.binary.downloadPdf(invoice);
  }

  /**
   * Resolve PDF bytes for an already-loaded invoice. Used by the bulk
   * export path (`resolveExportInvoices` runs the scope / draft triage
   * once; per-entry PDF fetches reuse the resolved row to avoid an N+1
   * round-trip back to `get()`).
   */
  async downloadPdfBytesForInvoice(
    invoice: Invoice,
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    return this.binary.downloadPdf(invoice);
  }

  // -------------------------------------------------------------------
  // Draft CRUD
  // -------------------------------------------------------------------

  /**
   * Create a draft invoice scoped to a project. Pre-fills `taxMode`
   * from the live `company_profile.defaultTaxMode` and `recipient`
   * from the project's customer (live row; the actual snapshot is
   * taken at issuance — AC-285).
   *
   * Rejected on an archived project (mirrors AC-95) — 404 NOT_FOUND.
   *
   * TOCTOU safety: the project + customer lookups run INSIDE the
   * `mutate()` transaction body so they share the same READ COMMITTED
   * snapshot as the INSERT. A concurrent archive committed between
   * route entry and the audit transaction's start is observed by the
   * in-tx lookup and rejected — closing the M2 race window. Mirrors
   * `CustomerService.deleteCustomer`, which moved its
   * active-project / invoice-retention guards inside the tx for the
   * same reason.
   *
   * The `company_profile.defaultTaxMode` read remains outside the tx:
   * the resolved `taxMode` is what the draft carries until issuance,
   * and a profile mutation racing the draft is benign — the issuance
   * path re-reads the profile inside its own transaction and is the
   * load-bearing snapshot point (AC-287, AC-304).
   */
  async createDraft(
    input: CreateDraftInput,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ): Promise<Invoice> {
    const lines = input.lines ?? [];
    validateInvoiceLines(lines);

    if (input.taxMode !== undefined && !TAX_MODES.includes(input.taxMode)) {
      throw validationError(STRINGS.errors.invalidInput);
    }

    const profileService = new CompanyProfileService(this.db);
    const profile = await profileService.get();

    // Issuer block on a draft row carries empty placeholders — the
    // snapshot freezes at issuance, not at draft create (data-model.md
    // §5.17 design note "Snapshot at issuance, not at draft creation").
    const placeholderIssuer: InvoiceIssuerSnapshot = {
      companyName: '',
      address: { street: '', zip: '', city: '' },
      taxId: '',
    };

    const profileLiteral: InvoiceProfile = 'zugferd-en16931';

    const id = crypto.randomUUID();
    const performanceDate = input.performanceDate ? parseCalendarDate(input.performanceDate) : null;

    const created = await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'invoice',
        action: 'create',
        run: async (tx) => {
          // Project + customer lookup INSIDE the tx — shares its
          // snapshot with the INSERT below (AC-285 / M2). A concurrent
          // archive committed before this tx started is visible here
          // and triggers the 404; an archive committed AFTER this tx
          // started cannot be observed by our snapshot and the INSERT
          // proceeds against the row as we saw it.
          const projRows = await tx
            .select()
            .from(projects)
            .where(eq(projects.id, input.projectId))
            .limit(1);
          const project = projRows[0];
          // AC-285: archived project → 404 (mirrors AC-95 for draft writes).
          if (!project || project.deleted) {
            throw notFound(STRINGS.entities.project);
          }

          const customerRows = await tx
            .select()
            .from(customers)
            .where(eq(customers.id, project.customerId))
            .limit(1);
          const customer = customerRows[0];

          const taxMode: TaxMode = input.taxMode ?? profile.defaultTaxMode;

          // Build the draft's recipient: the live customer's fields are
          // the baseline; any field present in `input.recipient`
          // overrides.
          const customerRecipient: InvoiceRecipientSnapshot = customer
            ? {
                name: customer.name,
                address: customer.address ?? null,
                ustId: customer.ustId ?? null,
              }
            : { name: '', address: null, ustId: null };

          const recipient: InvoiceRecipientSnapshot = input.recipient
            ? {
                name:
                  input.recipient.name !== undefined
                    ? input.recipient.name
                    : customerRecipient.name,
                address:
                  input.recipient.address !== undefined
                    ? input.recipient.address
                    : customerRecipient.address,
                ustId:
                  input.recipient.ustId !== undefined
                    ? input.recipient.ustId
                    : customerRecipient.ustId,
              }
            : customerRecipient;

          const totals = computeInvoiceTotals(lines, taxMode);

          const row = await insertInvoiceDraft(tx, {
            id,
            projectId: input.projectId,
            performanceDate,
            taxMode,
            profile: profileLiteral,
            issuer: placeholderIssuer,
            recipient,
            lines,
            totals,
            createdBy: userId,
            updatedBy: userId,
          });
          return {
            entityId: row.id,
            entityLabel: null,
            value: row,
            before: {},
            after: {
              projectId: row.projectId,
              status: row.status,
              taxMode: row.taxMode,
              profile: row.profile,
              recipient: row.recipient,
              lines: row.lines,
              totals: row.totals,
            },
            // Ancestor link: every invoice mutation surfaces under the
            // project's activity feed (ADR-0026 §Audit and realtime).
            ancestorEntityType: 'project',
            ancestorEntityId: input.projectId,
            ancestorEntityLabel: projectAuditLabel(project),
          };
        },
      },
    );
    log.info({ invoiceId: created.id, projectId: input.projectId }, 'invoice_draft_created');
    emitInvoiceChanged();
    return toInvoiceResponse(created);
  }

  /**
   * PATCH a draft row. Rejected with `INVOICE_FROZEN` (422) if the
   * row's status is not `'draft'`. Server re-derives `totals` from the
   * post-patch `lines + taxMode` on every successful PATCH (AC-286).
   */
  async updateDraft(
    id: string,
    input: UpdateDraftInput,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ): Promise<Invoice> {
    if (input.taxMode !== undefined && !TAX_MODES.includes(input.taxMode)) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    if (input.lines !== undefined) validateInvoiceLines(input.lines);

    const updated = await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'invoice',
        action: 'update',
        run: async (tx) => {
          const before = await getInvoiceRowForMutation(tx, id);
          if (!before) throw notFound(STRINGS.entities.invoice);
          if (before.status !== 'draft') throw invoiceFrozen();

          const nextTaxMode: TaxMode = (input.taxMode ?? before.taxMode) as TaxMode;
          const nextLines: InvoiceLine[] = input.lines ?? (before.lines as InvoiceLine[]);
          const nextTotals = computeInvoiceTotals(nextLines, nextTaxMode);
          const nextPerformanceDate =
            'performanceDate' in input
              ? input.performanceDate
                ? parseCalendarDate(input.performanceDate)
                : null
              : before.performanceDate;

          // Build the per-PATCH recipient: omitted fields unchanged.
          let nextRecipient: InvoiceRecipientSnapshot =
            before.recipient as InvoiceRecipientSnapshot;
          if (input.recipient !== undefined) {
            nextRecipient = {
              name: input.recipient.name !== undefined ? input.recipient.name : nextRecipient.name,
              address:
                input.recipient.address !== undefined
                  ? input.recipient.address
                  : (nextRecipient.address ?? null),
              ustId:
                input.recipient.ustId !== undefined
                  ? input.recipient.ustId
                  : (nextRecipient.ustId ?? null),
            };
          }

          const row = await updateInvoiceDraft(tx, id, {
            taxMode: nextTaxMode,
            lines: nextLines,
            totals: nextTotals,
            recipient: nextRecipient,
            performanceDate: nextPerformanceDate,
            updatedBy: userId,
          });

          // Capture only the changed fields in the audit payload —
          // matches the §5.10 "changed fields only" rule.
          const beforeFields: Record<string, unknown> = {};
          const afterFields: Record<string, unknown> = {};
          if (input.taxMode !== undefined && before.taxMode !== input.taxMode) {
            beforeFields.taxMode = before.taxMode;
            afterFields.taxMode = input.taxMode;
          }
          if (input.lines !== undefined) {
            beforeFields.lines = before.lines;
            afterFields.lines = nextLines;
            beforeFields.totals = before.totals;
            afterFields.totals = nextTotals;
          }
          if (input.recipient !== undefined) {
            beforeFields.recipient = before.recipient;
            afterFields.recipient = nextRecipient;
          }
          if ('performanceDate' in input) {
            beforeFields.performanceDate = before.performanceDate;
            afterFields.performanceDate = nextPerformanceDate;
          }

          // Project row is needed for the ancestor label. Read inside
          // the tx so the audit row's label reflects the same snapshot
          // as the invoice update; the project FK guarantees existence.
          const projectRow = await getProjectRowById(tx, row.projectId);
          if (!projectRow) {
            // FK guarantee — should be unreachable. Defensive throw so
            // the inconsistency surfaces loudly rather than landing a
            // half-formed audit row.
            throw new Error(`updateDraft: project ${row.projectId} missing for invoice ${id}`);
          }
          return {
            entityId: id,
            entityLabel: null,
            value: row,
            before: beforeFields,
            after: afterFields,
            ancestorEntityType: 'project',
            ancestorEntityId: row.projectId,
            ancestorEntityLabel: projectAuditLabel(projectRow),
          };
        },
      },
    );
    log.info({ invoiceId: id }, 'invoice_draft_updated');
    emitInvoiceChanged();
    return toInvoiceResponse(updated);
  }

  /**
   * Hard-delete a draft. Rejected with `INVOICE_FROZEN` (422) for any
   * non-draft row (AC-286). Audit `action='invoice:delete'` — the
   * exact string is pinned in `invoices-routes.test.ts:467`. Ancestor
   * link is the parent project.
   */
  async deleteDraft(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ): Promise<void> {
    await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'invoice',
        action: 'invoice:delete',
        run: async (tx) => {
          const before = await getInvoiceRowForMutation(tx, id);
          if (!before) throw notFound(STRINGS.entities.invoice);
          if (before.status !== 'draft') throw invoiceFrozen();

          // Resolve the ancestor label from the live project row INSIDE
          // the tx — the invoice FK guarantees existence at this point.
          const projectRow = await getProjectRowById(tx, before.projectId);
          if (!projectRow) {
            throw new Error(`deleteDraft: project ${before.projectId} missing for invoice ${id}`);
          }

          await deleteInvoiceDraft(tx, id);

          return {
            entityId: id,
            entityLabel: null,
            value: null,
            before: {
              projectId: before.projectId,
              status: before.status,
              taxMode: before.taxMode,
              lines: before.lines,
              totals: before.totals,
            },
            after: {},
            ancestorEntityType: 'project',
            ancestorEntityId: before.projectId,
            ancestorEntityLabel: projectAuditLabel(projectRow),
          };
        },
      },
    );
    log.info({ invoiceId: id }, 'invoice_draft_deleted');
    emitInvoiceChanged();
  }

  // -------------------------------------------------------------------
  // Issue / Cancel — pure delegation
  // -------------------------------------------------------------------

  async issueDraft(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
    now: Date = new Date(),
  ): Promise<Invoice> {
    return this.issue.issueDraft(id, userId, log, correlationId, now);
  }

  async cancel(
    id: string,
    input: CancelInput,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
    now: Date = new Date(),
  ): Promise<CancelResult> {
    return this.cancel_.cancel(id, input, userId, log, correlationId, now);
  }
}

/**
 * Build the `InvoiceBinaryDeps` for the service from validated env.
 * `assertAppServerEnv` enforces presence of STORAGE_* / BINARY_AGE_RECIPIENT
 * at boot (env.ts § app-server presence predicate); BINARY_AGE_IDENTITY_PATH
 * has a schema-level default. If any of these are missing at factory
 * call time we throw — the app should never have started.
 */
function buildInvoiceBinaryDeps(): InvoiceBinaryDeps {
  const env = getEnv();
  if (
    !env.STORAGE_ENDPOINT ||
    !env.STORAGE_ACCESS_KEY ||
    !env.STORAGE_SECRET_KEY ||
    !env.BINARY_AGE_RECIPIENT ||
    !env.BINARY_AGE_IDENTITY_PATH
  ) {
    throw new Error(
      'Refusing to register invoice routes: STORAGE_* and BINARY_AGE_RECIPIENT / ' +
        'BINARY_AGE_IDENTITY_PATH are required for invoice binary persistence. ' +
        'assertAppServerEnv should have rejected this configuration at boot — see ' +
        'src/server/config/env.ts.',
    );
  }
  const storage = createStorageClient({
    endpoint: env.STORAGE_ENDPOINT,
    publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
    region: env.STORAGE_REGION,
  });
  return {
    storage,
    binaryAgeRecipient: env.BINARY_AGE_RECIPIENT,
    binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH,
  };
}

/**
 * Build the orchestrator + its three sibling services. Route wiring
 * is one line: `const service = createInvoiceService(db);`.
 *
 * The binary-pipeline deps are resolved from env here so callers don't
 * have to thread STORAGE_* / BINARY_AGE_* through the route layer; the
 * shape is still re-exported as `InvoiceBinaryDeps` for tests that
 * want to construct the service against a fake storage client.
 */
export function createInvoiceService(db: Database): InvoiceService {
  const deps = buildInvoiceBinaryDeps();
  const binary = new InvoiceBinaryService(db, deps);
  const issue = new InvoiceIssueService(db, binary);
  const cancel = new InvoiceCancelService(db, binary);
  return new InvoiceService(db, issue, cancel, binary);
}
