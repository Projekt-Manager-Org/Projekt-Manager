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

import { sanitiseFilenameSegment } from './filename.js';

/** §5.15 — three-state machine: draft (editable) → issued (frozen) → cancelled (flag). */
export const INVOICE_STATUSES = ['draft', 'issued', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * §5.15 / §5.17 — three tax modes in v1, each rendered with the
 * statute-mandated boilerplate (AC-292).
 *
 * - `standard`: per-line VAT (19% / 7% / 0%); per-rate totals.
 * - `kleinunternehmer`: §19 UStG; no VAT on lines, totals=net.
 * - `reverse_charge`: §13b UStG; no VAT on lines, totals=net.
 */
export const TAX_MODES = ['standard', 'kleinunternehmer', 'reverse_charge'] as const;
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
  logoBinaryDescriptorId: string | null;
  defaultTaxMode: TaxMode;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * The set of fields the issue-time / upsert-time validation gate checks
 * against the singleton. The order is the order in which `details.missingFields`
 * is reported, so the UI can focus the first offending input deterministically.
 *
 * `ustId` is only required when `defaultTaxMode ∈ {standard, reverse_charge}`;
 * see `companyProfileMissingFieldsForMode()` below.
 */
export const COMPANY_PROFILE_ALWAYS_REQUIRED = [
  'companyName',
  'address.street',
  'address.zip',
  'address.city',
  'taxId',
] as const;

/**
 * Compute the missing-field list for a candidate company-profile snapshot
 * under the given tax mode. Shared between the upsert validator
 * (AC-303) and the issue-time gate (AC-289(i) / AC-305) so the two paths
 * cannot drift.
 *
 * Empty strings count as missing — the column-level defaults ship empty
 * (data-model.md §5.17 design notes) and the spec normative language is
 * "non-empty", not "non-null".
 */
export function companyProfileMissingFieldsForMode(
  profile: Pick<CompanyProfile, 'companyName' | 'address' | 'taxId' | 'ustId'>,
  mode: TaxMode,
): string[] {
  const missing: string[] = [];
  if (!profile.companyName || profile.companyName.length === 0) missing.push('companyName');
  if (!profile.address?.street || profile.address.street.length === 0)
    missing.push('address.street');
  if (!profile.address?.zip || profile.address.zip.length === 0) missing.push('address.zip');
  if (!profile.address?.city || profile.address.city.length === 0) missing.push('address.city');
  if (!profile.taxId || profile.taxId.length === 0) missing.push('taxId');
  if (mode !== 'kleinunternehmer') {
    if (!profile.ustId || profile.ustId.length === 0) missing.push('ustId');
  }
  return missing;
}

/** Round to two decimals using half-away-from-zero (German invoicing convention). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Tax-mode → German display label. Single source so the company-profile
 * select and the draft-form select cannot drift from each other (and
 * from anywhere else the label is rendered).
 *
 * Lives next to the `TaxMode` definition rather than in `strings.ts` so
 * the discriminator and its display copy stay structurally paired —
 * adding a fourth `TaxMode` triggers a TS exhaustiveness error here.
 */
export function labelForTaxMode(
  mode: TaxMode,
  copy: { standard: string; kleinunternehmer: string; reverseCharge: string },
): string {
  switch (mode) {
    case 'standard':
      return copy.standard;
    case 'kleinunternehmer':
      return copy.kleinunternehmer;
    case 'reverse_charge':
      return copy.reverseCharge;
  }
}

/**
 * Re-derive totals from a line list + tax mode. The service calls this
 * on every draft PATCH and on the issue transaction so totals are never
 * client-trusted (AC-286).
 *
 * `standard`: per-line VAT, aggregated to per-rate bands.
 * `kleinunternehmer` / `reverse_charge`: no VAT on lines — taxGrandTotal=0,
 *   perRate=[], grossGrandTotal=netGrandTotal.
 *
 * Lines are negative on a Storno (AC-290 sign-flip) — the same formula
 * works for both signs.
 */
export function computeInvoiceTotals(lines: InvoiceLine[], mode: TaxMode): InvoiceTotals {
  if (lines.length === 0) {
    return { perRate: [], netGrandTotal: 0, taxGrandTotal: 0, grossGrandTotal: 0 };
  }

  const netGrandTotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));

  if (mode === 'kleinunternehmer' || mode === 'reverse_charge') {
    return {
      perRate: [],
      netGrandTotal,
      taxGrandTotal: 0,
      grossGrandTotal: netGrandTotal,
    };
  }

  // standard — aggregate by tax rate.
  const byRate = new Map<number, { netSubtotal: number; taxAmount: number }>();
  for (const line of lines) {
    const rate = line.taxRate;
    const existing = byRate.get(rate) ?? { netSubtotal: 0, taxAmount: 0 };
    existing.netSubtotal += line.lineTotal;
    existing.taxAmount += (line.lineTotal * rate) / 100;
    byRate.set(rate, existing);
  }
  const perRate = [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([taxRate, { netSubtotal, taxAmount }]) => ({
      taxRate,
      netSubtotal: round2(netSubtotal),
      taxAmount: round2(taxAmount),
    }));
  const taxGrandTotal = round2(perRate.reduce((sum, p) => sum + p.taxAmount, 0));
  return {
    perRate,
    netGrandTotal,
    taxGrandTotal,
    grossGrandTotal: round2(netGrandTotal + taxGrandTotal),
  };
}

/**
 * Sign-flip a line list for a Storno row (AC-290). Both `unitPrice` and
 * `lineTotal` are negated; `quantity` / `description` / `unit` / `taxRate`
 * are copied unchanged so the rendered output reads as "-1 × 1500.00 EUR"
 * rather than "1 × -1500.00 EUR".
 */
export function negateInvoiceLines(lines: InvoiceLine[]): InvoiceLine[] {
  return lines.map((line) => ({
    ...line,
    unitPrice: -line.unitPrice,
    lineTotal: -line.lineTotal,
  }));
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
