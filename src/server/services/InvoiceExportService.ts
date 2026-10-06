/**
 * Invoice bulk-export — resolve a caller-supplied selection (ids or
 * filter) into a deterministic, draft-free list of invoices ready to
 * stream into a ZIP archive.
 *
 * The route layer wires `archiver` and pipes per-invoice PDF bytes
 * (sourced via `InvoiceService.downloadPdf`) plus a CSV manifest into
 * the response. Resolution + business validation lives here so the
 * route stays a thin HTTP adapter and the same rules apply to any
 * future caller (e.g. a scheduled bookkeeper takeout).
 *
 * Permission / scope: callers are expected to already hold
 * `invoice:read` (route preHandler). Resolution reuses
 * `InvoiceService.get` / `list`, which honour the repository-predicate
 * scope (ADR-0019) — workers return empty / 403 by construction.
 */

import type { AuthUser } from '../middleware/auth.js';
import type { Invoice } from '../../domain/invoice.js';
import type { InvoiceService, ListInvoicesOpts } from './InvoiceService.js';
import {
  draftNotExportable,
  exportTooLarge,
  invoiceBackupPending,
  validationError,
} from '../errors.js';
import { STRINGS } from '../../config/strings.js';

/** Filter shape mirrors the GET /api/invoices opts surface (api.md §14.2.14). */
export interface ExportFilterInput {
  year?: number;
  status?: ListInvoicesOpts['status'];
  projectId?: string;
  customerId?: string;
  includeCancelled?: boolean;
  search?: string;
}

export interface ExportByIds {
  ids: string[];
  filter?: undefined;
}

export interface ExportByFilter {
  ids?: undefined;
  filter: ExportFilterInput;
}

export type ExportInput = ExportByIds | ExportByFilter;

/**
 * Hard ceiling on a single export request. A filter that matches more
 * rows than this is rejected outright with 422 EXPORT_TOO_LARGE — the
 * caller must narrow the filter (typically by year) and retry. The
 * cap protects the response-side memory budget (decrypted PDF bytes
 * pre-buffered before the ZIP stream) and forces the bookkeeper to
 * acknowledge an unexpectedly broad selection rather than silently
 * receive a truncated archive.
 */
export const EXPORT_FILTER_PAGE_SIZE = 500;
export const EXPORT_FILTER_SAFETY_CAP = 5000;

/**
 * UTF-8 byte-order mark prepended to the CSV manifest. Excel-DE opens
 * UTF-8 CSV as Windows-1252 without it, garbling umlauts. Kept as a
 * named escape because lint forbids irregular whitespace in source.
 */
const UTF8_BOM = '\uFEFF';

export interface ResolvedExport {
  invoices: Invoice[];
  /** `auswahl` for ids-mode, `<year>` or `alle` for filter-mode. */
  scopeLabel: string;
}

/**
 * Resolve the caller's selection into a sorted, draft-free list. A
 * selection holding a backup-pending invoice is rejected with
 * `INVOICE_BACKUP_PENDING`.
 *
 * Sort order: `issueDate` ascending, then `number` ascending — gives the
 * bookkeeper a reproducible chronological manifest. Drafts (status =
 * 'draft', `number === null`) are excluded server-side regardless of
 * how they entered the input:
 *   - `ids` mode: drafts trigger 422 DRAFT_NOT_EXPORTABLE before the
 *     ZIP starts streaming (no partial-archive surprise).
 *   - `filter` mode: drafts are silently omitted. The brief permits
 *     `status: 'draft'` on the filter (mirrors the list endpoint) but
 *     the result set is then `[]` after this filter.
 */
export async function resolveExportInvoices(
  service: InvoiceService,
  caller: AuthUser,
  input: ExportInput,
): Promise<ResolvedExport> {
  const idsProvided = input.ids !== undefined;
  const filterProvided = input.filter !== undefined;
  if (idsProvided === filterProvided) {
    throw validationError(STRINGS.errors.exportRequiresIdsOrFilter);
  }

  let invoices: Invoice[];
  let scopeLabel: string;
  if (idsProvided) {
    invoices = await resolveByIds(service, caller, input.ids!);
    scopeLabel = 'auswahl';
  } else {
    invoices = await resolveByFilter(service, caller, input.filter!);
    scopeLabel = input.filter!.year !== undefined ? String(input.filter!.year) : 'alle';
  }

  // Reject rather than omit: the archive never silently drops an issued
  // invoice (architecture.md §11.14 "Backup gate").
  const pending = invoices.find((invoice) => invoice.backupPending);
  if (pending) {
    throw invoiceBackupPending(pending.id);
  }

  invoices.sort(compareForExport);
  return { invoices, scopeLabel };
}

async function resolveByIds(
  service: InvoiceService,
  caller: AuthUser,
  ids: string[],
): Promise<Invoice[]> {
  const out: Invoice[] = [];
  for (const id of ids) {
    // `service.get` raises 404 / 403 if the id is unknown / out of
    // scope — the route maps both via the global error handler.
    const invoice = await service.get(caller, id);
    if (invoice.status === 'draft') {
      throw draftNotExportable({ invoiceId: invoice.id });
    }
    out.push(invoice);
  }
  return out;
}

async function resolveByFilter(
  service: InvoiceService,
  caller: AuthUser,
  filter: ExportFilterInput,
): Promise<Invoice[]> {
  const baseOpts: ListInvoicesOpts = {
    ...(filter.year !== undefined ? { year: filter.year } : {}),
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    ...(filter.projectId !== undefined ? { projectId: filter.projectId } : {}),
    ...(filter.customerId !== undefined ? { customerId: filter.customerId } : {}),
    ...(filter.includeCancelled !== undefined ? { includeCancelled: filter.includeCancelled } : {}),
    ...(filter.search !== undefined ? { search: filter.search } : {}),
  };

  // First page doubles as a cheap upper-bound probe: `list()` returns
  // the unpaginated `total`, so we can reject a too-broad filter
  // BEFORE walking every page (and BEFORE pre-fetching PDF bytes).
  const firstPage = await service.list(caller, {
    ...baseOpts,
    limit: EXPORT_FILTER_PAGE_SIZE,
    offset: 0,
  });
  if (firstPage.total > EXPORT_FILTER_SAFETY_CAP) {
    throw exportTooLarge({ total: firstPage.total, cap: EXPORT_FILTER_SAFETY_CAP });
  }

  const collected: Invoice[] = [];
  for (const row of firstPage.data) {
    if (row.status !== 'draft') collected.push(row);
  }
  let offset = EXPORT_FILTER_PAGE_SIZE;
  while (offset < firstPage.total) {
    const page = await service.list(caller, {
      ...baseOpts,
      limit: EXPORT_FILTER_PAGE_SIZE,
      offset,
    });
    for (const row of page.data) {
      if (row.status !== 'draft') collected.push(row);
    }
    if (page.data.length < EXPORT_FILTER_PAGE_SIZE) break;
    offset += EXPORT_FILTER_PAGE_SIZE;
  }
  return collected;
}

/**
 * Stable sort: `issueDate` ascending (null pushed last — they're drafts
 * anyway and excluded above, but be defensive), then `number`
 * ascending. Both date and number are ISO-comparable as strings, so
 * lexicographic order matches chronological / numerical order
 * (`RE-2024-0001` < `RE-2024-0002` < `RE-2025-0001`).
 */
function compareForExport(a: Invoice, b: Invoice): number {
  const da = a.issueDate ?? '';
  const db = b.issueDate ?? '';
  if (da !== db) return da < db ? -1 : 1;
  const na = a.number ?? '';
  const nb = b.number ?? '';
  if (na !== nb) return na < nb ? -1 : 1;
  return 0;
}

/**
 * Render the CSV manifest for an export (German conventions —
 * UTF-8 BOM, semicolon separator, comma decimal).
 *
 * Columns: `Nr.;Datum;Empfänger;Netto;USt;Brutto;Status`.
 * One row per invoice, ordered as supplied (sort happens in
 * `resolveExportInvoices`). Drafts are excluded upstream — every row
 * here has a `number` and an `issueDate`.
 */
export function buildManifestCsv(invoices: Invoice[]): string {
  const header = ['Nr.', 'Datum', 'Empfänger', 'Netto', 'USt', 'Brutto', 'Status']
    .map(csvField)
    .join(';');
  const rows = invoices.map((invoice) =>
    [
      csvField(invoice.number ?? ''),
      csvField(formatGermanDate(invoice.issueDate)),
      csvField(invoice.recipient?.name ?? ''),
      csvField(formatGermanDecimal(invoice.totals.netGrandTotal)),
      csvField(formatGermanDecimal(invoice.totals.taxGrandTotal)),
      csvField(formatGermanDecimal(invoice.totals.grossGrandTotal)),
      csvField(statusLabel(invoice)),
    ].join(';'),
  );
  return UTF8_BOM + [header, ...rows].join('\r\n') + '\r\n';
}

/** RFC 4180-ish quoting: wrap on `;`, `"`, CR or LF; escape inner `"` as `""`. */
function csvField(value: string): string {
  if (/[;"\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** ISO `YYYY-MM-DD` → German `DD.MM.YYYY`. */
function formatGermanDate(iso: string | null): string {
  if (!iso) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

/** Number → German decimal with two fractional digits and `,` separator. */
function formatGermanDecimal(value: number): string {
  const fixed = value.toFixed(2);
  return fixed.replace('.', ',');
}

/**
 * Domain-aware label: Storno (cancellation sibling) ranks over the
 * `cancelled` flag on the original (the original is what's reachable
 * via the descriptor; the Storno is a sibling row).
 */
function statusLabel(invoice: Invoice): string {
  if (invoice.cancellationOf !== null) return 'Storno';
  if (invoice.status === 'cancelled') return 'Storniert';
  return 'Ausgestellt';
}

/** Today's `YYYY-MM-DD` in UTC — load-bearing in the download filename. */
export function todayIsoDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
