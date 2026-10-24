/**
 * Invoice domain types — the API-facing shape of an invoice row, plus
 * the value-level constants the service and route layers depend on.
 *
 * Sourced from data-model.md §5.15 (Invoice), §5.17 (CompanyProfile),
 * and ADR-0026. Kept under `src/domain/` so both server services and
 * (eventually) UI code can import a single canonical shape without
 * pulling in the Drizzle table types — those carry SQL-side concerns
 * (Date instances, raw `bigint`) that the wire contract does not.
 */

import Big from 'big.js';
import { sanitiseFilenameSegment } from './filename.js';
import { hasAtMostDecimals, round2, round2Decimal } from './money.js';

/** §5.15 — three-state machine: draft (editable) → issued (frozen) → cancelled (flag). */
export const INVOICE_STATUSES = ['draft', 'issued', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * §5.15 / §5.17 — the supported tax modes (ADR-0026 § Tax modes), each
 * rendered with its boilerplate (AC-292).
 *
 * - `standard`: per-line VAT (19% / 7% / 0%); per-rate totals.
 * - `reverse_charge`: §13b UStG; no VAT on lines, totals=net.
 */
export const TAX_MODES = ['standard', 'reverse_charge'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

/** Profile discriminator on the invoice row (ADR-0026 §E-invoice format). */
export const INVOICE_PROFILES = ['zugferd-en16931'] as const;
export type InvoiceProfile = (typeof INVOICE_PROFILES)[number];

/** §5.15 — invoice sequence kind; one row per (year, kind). */
export const INVOICE_SEQUENCE_KINDS = ['invoice', 'storno'] as const;
export type InvoiceSequenceKind = (typeof INVOICE_SEQUENCE_KINDS)[number];

/** §5.15 line shape — frozen at issuance; lineTotal = quantity * unitPrice rounded to 2dp. */
export interface InvoiceLine {
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
  taxRate: number;
}

/** A line as the client writes it — `lineTotal` is server-derived (AC-384). */
export type InvoiceLineInput = Omit<InvoiceLine, 'lineTotal'>;

/** §5.15 issuer snapshot — copied from `company_profile` at issuance. */
export interface InvoiceIssuerSnapshot {
  companyName: string;
  address: { street: string; zip: string; city: string };
  taxId: string;
  ustId?: string | null;
  iban?: string | null;
  footerText?: string | null;
}

/** §5.15 recipient snapshot — copied from the project's customer at issuance. */
export interface InvoiceRecipientSnapshot {
  name: string;
  address?: { street: string; zip: string; city: string } | null;
  ustId?: string | null;
}

/** §5.15 totals shape — server-computed from `lines + taxMode`. */
export interface InvoiceTotals {
  perRate: { taxRate: number; netSubtotal: number; taxAmount: number }[];
  netGrandTotal: number;
  taxGrandTotal: number;
  grossGrandTotal: number;
}

/**
 * §5.15 — the API-facing invoice shape returned by every read endpoint
 * (GET list, GET single, write endpoints on success). ISO 8601 strings
 * for every date/time field so the wire contract is timezone-stable.
 */
export interface Invoice {
  id: string;
  number: string | null;
  status: InvoiceStatus;

  projectId: string;
  cancellationOf: string | null;

  issuer: InvoiceIssuerSnapshot;
  recipient: InvoiceRecipientSnapshot;
  lines: InvoiceLine[];
  taxMode: TaxMode;
  profile: InvoiceProfile;
  totals: InvoiceTotals;

  issueDate: string | null;
  performanceDate: string | null;

  cancellationReason: string | null;
  renderedPdfBinaryDescriptorId: string | null;

  /** True while the parent project is archived: no change is offered (AC-514). */
  projectArchived: boolean;

  /** Concurrency token (data-model.md §6.4); frozen once issued. */
  version: number;

  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

/**
 * §5.17 — company-profile singleton shape returned by GET / PUT. The
 * `id` is stable for the lifetime of the deployment (baseline seed)
 * but is exposed so audit-log rows for `entity_type = 'company_profile'`
 * round-trip cleanly. `updatedAt` / `updatedBy` follow the §5.5 audit-
 * metadata rules.
 */
export interface CompanyProfile {
  id: string;
  companyName: string;
  address: { street: string; zip: string; city: string };
  taxId: string;
  ustId: string | null;
  iban: string | null;
  accentColor: string | null;
  footerText: string | null;
  defaultTaxMode: TaxMode;
  /** Concurrency token (data-model.md §6.4). */
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Compute the missing-field list for a candidate company-profile snapshot
 * (data-model.md §5.17 — required in every tax mode). The order is the
 * order of `details.missingFields`. Shared between the upsert validator
 * (AC-303) and the issue-time gate (AC-289(i) / AC-305) so the two paths
 * cannot drift.
 *
 * Empty strings count as missing — the column-level defaults ship empty
 * (data-model.md §5.17 design notes) and the spec normative language is
 * "non-empty", not "non-null".
 */
export function companyProfileMissingFields(
  profile: Pick<CompanyProfile, 'companyName' | 'address' | 'taxId' | 'ustId'>,
): string[] {
  const missing: string[] = [];
  if (!profile.companyName || profile.companyName.length === 0) missing.push('companyName');
  if (!profile.address?.street || profile.address.street.length === 0)
    missing.push('address.street');
  if (!profile.address?.zip || profile.address.zip.length === 0) missing.push('address.zip');
  if (!profile.address?.city || profile.address.city.length === 0) missing.push('address.city');
  if (!profile.taxId || profile.taxId.length === 0) missing.push('taxId');
  if (!profile.ustId || profile.ustId.length === 0) missing.push('ustId');
  return missing;
}

/** §5.15 — the VAT rates a line may carry, in percent. */
export const INVOICE_TAX_RATES = [0, 7, 19] as const;

/** `standard` excludes 0: an S-category line at 0 % breaks EN 16931 BR-S-05. */
const STANDARD_TAX_RATES: readonly number[] = INVOICE_TAX_RATES.filter((r) => r !== 0);

/** §5.15 — the rates a line may carry under `mode`. */
export function taxRatesFor(mode: TaxMode): readonly number[] {
  return mode === 'standard' ? STANDARD_TAX_RATES : INVOICE_TAX_RATES;
}

/** §5.15 — `unitPrice` carries at most this many decimals. */
export const UNIT_PRICE_MAX_DECIMALS = 4;

/** Derive `lineTotal` from `quantity` and `unitPrice` (AC-384). */
export function deriveInvoiceLine(line: InvoiceLineInput): InvoiceLine {
  return { ...line, lineTotal: round2(new Big(line.quantity).times(line.unitPrice)) };
}

const INPUT_LINE_FIELDS = ['description', 'quantity', 'unit', 'unitPrice', 'taxRate'] as const;

/**
 * Fields of a client-written line that break the §5.15 write rules
 * (AC-384); empty when the line is valid, every field when it is not an
 * object. `unitPrice` carries no sign rule: a Storno line negates it.
 */
export function invalidInputLineFields(
  line: unknown,
  rates: readonly number[] = INVOICE_TAX_RATES,
): (keyof InvoiceLine)[] {
  if (typeof line !== 'object' || line === null) return [...INPUT_LINE_FIELDS];
  const l = line as Record<string, unknown>;
  const invalid: (keyof InvoiceLine)[] = [];
  if (typeof l.description !== 'string') invalid.push('description');
  if (!Number.isFinite(l.quantity) || (l.quantity as number) <= 0) invalid.push('quantity');
  if (typeof l.unit !== 'string') invalid.push('unit');
  if (
    !Number.isFinite(l.unitPrice) ||
    !hasAtMostDecimals(l.unitPrice as number, UNIT_PRICE_MAX_DECIMALS)
  ) {
    invalid.push('unitPrice');
  }
  if (!(rates as readonly unknown[]).includes(l.taxRate)) invalid.push('taxRate');
  return invalid;
}

/**
 * `invalidInputLineFields` for a stored line, which must also carry the
 * derived `lineTotal` (AC-384). Shared by the issue preconditions and the
 * import (AC-386): a stored mismatch is rejected, never re-derived.
 */
export function invalidStoredLineFields(
  line: unknown,
  rates: readonly number[] = INVOICE_TAX_RATES,
): (keyof InvoiceLine)[] {
  const invalid = invalidInputLineFields(line, rates);
  if (invalid.includes('quantity') || invalid.includes('unitPrice')) return invalid;
  const l = line as InvoiceLine;
  if (l.lineTotal !== deriveInvoiceLine(l).lineTotal) invalid.push('lineTotal');
  return invalid;
}

/**
 * Tax-mode → German display label. Single source so the company-profile
 * select and the draft-form select cannot drift from each other (and
 * from anywhere else the label is rendered).
 *
 * Lives next to the `TaxMode` definition rather than in `strings.ts` so
 * the discriminator and its display copy stay structurally paired —
 * adding a `TaxMode` triggers a TS exhaustiveness error here.
 */
export function labelForTaxMode(
  mode: TaxMode,
  copy: { standard: string; reverseCharge: string },
): string {
  switch (mode) {
    case 'standard':
      return copy.standard;
    case 'reverse_charge':
      return copy.reverseCharge;
  }
}

/**
 * Re-derive totals from a line list + tax mode. The service calls this
 * on every draft PATCH and on the issue transaction so totals are never
 * client-trusted (AC-286).
 *
 * `standard`: lines summed per rate; each band's VAT is its rounded net
 *   × rate (EN 16931 BR-CO-17).
 * `reverse_charge`: no VAT on lines — taxGrandTotal=0,
 *   perRate=[], grossGrandTotal=netGrandTotal.
 */
export function computeInvoiceTotals(lines: InvoiceLine[], mode: TaxMode): InvoiceTotals {
  if (lines.length === 0) {
    return { perRate: [], netGrandTotal: 0, taxGrandTotal: 0, grossGrandTotal: 0 };
  }

  const net = round2Decimal(sum(lines.map((l) => l.lineTotal)));
  const netGrandTotal = net.toNumber();

  if (mode === 'reverse_charge') {
    return {
      perRate: [],
      netGrandTotal,
      taxGrandTotal: 0,
      grossGrandTotal: netGrandTotal,
    };
  }

  // standard — aggregate by tax rate.
  const byRate = new Map<number, number[]>();
  for (const line of lines) {
    const lineTotals = byRate.get(line.taxRate) ?? [];
    lineTotals.push(line.lineTotal);
    byRate.set(line.taxRate, lineTotals);
  }
  const perRate = [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([taxRate, lineTotals]) => {
      const netSubtotal = round2Decimal(sum(lineTotals));
      return {
        taxRate,
        netSubtotal,
        taxAmount: round2Decimal(netSubtotal.times(taxRate).div(100)),
      };
    });
  const tax = round2Decimal(sum(perRate.map((p) => p.taxAmount)));
  return {
    perRate: perRate.map((p) => ({
      taxRate: p.taxRate,
      netSubtotal: p.netSubtotal.toNumber(),
      taxAmount: p.taxAmount.toNumber(),
    })),
    netGrandTotal,
    taxGrandTotal: tax.toNumber(),
    grossGrandTotal: round2(net.plus(tax)),
  };
}

/** Exact decimal sum. Every value must be finite: `Big` rejects `±Infinity`. */
function sum(values: Big.BigSource[]): Big {
  return values.reduce<Big>((acc, v) => acc.plus(v), new Big(0));
}

/**
 * False when an amount overflows a double. JSONB would store it as
 * `null`, so a write or an issue with such totals is rejected.
 */
export function invoiceTotalsAreFinite(totals: InvoiceTotals): boolean {
  return [
    totals.netGrandTotal,
    totals.taxGrandTotal,
    totals.grossGrandTotal,
    ...totals.perRate.flatMap((p) => [p.netSubtotal, p.taxAmount]),
  ].every(Number.isFinite);
}

/**
 * True when stored `totals` equal the `derived` ones (§5.15 "Totals are
 * server-computed"; AC-386). An overflowing derived amount never matches.
 * `===` treats a negated zero on a Storno as zero.
 */
export function invoiceTotalsMatch(totals: unknown, derived: InvoiceTotals): boolean {
  if (typeof totals !== 'object' || totals === null) return false;
  const t = totals as Partial<InvoiceTotals>;
  if (!Array.isArray(t.perRate) || t.perRate.length !== derived.perRate.length) return false;
  return (
    t.netGrandTotal === derived.netGrandTotal &&
    t.taxGrandTotal === derived.taxGrandTotal &&
    t.grossGrandTotal === derived.grossGrandTotal &&
    derived.perRate.every((d, k) => {
      const p = t.perRate![k];
      return (
        p?.taxRate === d.taxRate && p.netSubtotal === d.netSubtotal && p.taxAmount === d.taxAmount
      );
    })
  );
}

/**
 * Sign-flip a line list for a Storno row (AC-290). Both `unitPrice` and
 * `lineTotal` are negated; `quantity` / `description` / `unit` / `taxRate`
 * are copied unchanged, as `quantity` stays positive (§5.15).
 */
export function negateInvoiceLines(lines: InvoiceLine[]): InvoiceLine[] {
  return lines.map((line) => ({
    ...line,
    unitPrice: -line.unitPrice,
    lineTotal: -line.lineTotal,
  }));
}

/**
 * Negate an issued invoice's stored totals for its Storno (AC-290).
 * Never re-derived: the Storno cancels the document as issued.
 */
export function negateInvoiceTotals(totals: InvoiceTotals): InvoiceTotals {
  return {
    perRate: totals.perRate.map((p) => ({
      taxRate: p.taxRate,
      netSubtotal: -p.netSubtotal,
      taxAmount: -p.taxAmount,
    })),
    netGrandTotal: -totals.netGrandTotal,
    taxGrandTotal: -totals.taxGrandTotal,
    grossGrandTotal: -totals.grossGrandTotal,
  };
}

/** Format an invoice number from a sequence kind, year, and integer value. */
export function formatInvoiceNumber(
  kind: InvoiceSequenceKind,
  year: number,
  value: number,
): string {
  const prefix = kind === 'invoice' ? 'RE' : 'ST';
  const suffix = String(value).padStart(4, '0');
  return `${prefix}-${year}-${suffix}`;
}

/**
 * Human-friendly PDF download filename for an issued / cancelled invoice.
 *
 * Shape: `{number}_{recipient}.pdf` — e.g. `RE-2026-0001_Mustermann-GmbH.pdf`.
 * The number-prefix (`RE-` regular, `ST-` Storno) already discriminates the
 * kind at a glance; including the recipient gives the user a meaningful
 * label when scanning a downloads folder.
 *
 * Sanitisation rules (intentionally conservative — the filename leaves
 * the server boundary and lands on arbitrary user filesystems):
 *  - Whitespace collapses to `-`.
 *  - Path separators and control bytes are stripped.
 *  - The recipient slug is trimmed to 40 chars so the full name stays
 *    on-screen in most browsers' download confirmation dialogs.
 *  - Falls back to `{number}.pdf` when the recipient name is missing
 *    or sanitises to empty, and to `invoice-{id}.pdf` when the number
 *    is null (defensive — issued invoices always have a number).
 */
export function buildInvoiceDownloadFilename(
  invoice: Pick<Invoice, 'id' | 'number' | 'recipient'>,
): string {
  const numberPart = invoice.number ?? `invoice-${invoice.id}`;
  const recipientSlug = sanitiseFilenameSegment(invoice.recipient?.name ?? '');
  return recipientSlug.length > 0 ? `${numberPart}_${recipientSlug}.pdf` : `${numberPart}.pdf`;
}
