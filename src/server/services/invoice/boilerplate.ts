/**
 * Per-tax-mode legal boilerplate strings rendered on the human-readable
 * PDF body (ADR-0026 §Tax modes, AC-292).
 *
 * The §-references are statutory and must appear verbatim on the
 * rendered output; the surrounding German UI copy is `[C]` per
 * `architecture.md §11.14` and can drift, but the §-anchor string
 * (`§ 13b UStG`) is pinned by AC-292's assertions.
 *
 * `standard` mode carries no statutory boilerplate; per-line VAT and the
 * per-rate breakdown in the totals block are the legal anchors for that
 * mode and live in the layout, not in a fixed string.
 */
import type { TaxMode } from '../../../domain/invoice.js';

/**
 * Returns the boilerplate paragraph to render in the document body for
 * the given tax mode, or `null` for `standard` (which has no fixed
 * boilerplate line; the VAT breakdown table carries the statutory
 * shape instead).
 *
 * The strings include the German UI copy AND the §-reference; AC-292
 * asserts on the §-reference substring only, so a future translation
 * change does not break the test. The full sentence is what an actual
 * recipient expects on the invoice.
 */
export function taxModeBoilerplate(mode: TaxMode): string | null {
  switch (mode) {
    case 'standard':
      return null;
    case 'reverse_charge':
      return 'Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.';
    default: {
      const exhaustive: never = mode;
      throw new Error(`taxModeBoilerplate: unhandled tax mode ${String(exhaustive)}`);
    }
  }
}

/**
 * EN 16931 / UN/CEFACT VAT category code (CategoryCode element on
 * `ApplicableTradeTax`). The values are pinned by EN 16931 and
 * round-trip through the XSD; a mistyped code (`'X'`, `'XX'`) fails
 * the receiver's processor even when the XSD passes.
 *
 * - `S` — Standard rate (the regular 19% / 7% VAT).
 * - `AE` — VAT Reverse Charge (recipient liable, §13b UStG).
 */
export function taxModeCategoryCode(mode: TaxMode): 'S' | 'AE' {
  switch (mode) {
    case 'standard':
      return 'S';
    case 'reverse_charge':
      return 'AE';
    default: {
      const exhaustive: never = mode;
      throw new Error(`taxModeCategoryCode: unhandled tax mode ${String(exhaustive)}`);
    }
  }
}

/**
 * Statutory anchor for the BT-120 ExemptionReason element. For
 * reverse-charge (`AE`) supplies, EN 16931 expects a free-text
 * justification on the header-level ApplicableTradeTax. We mirror the
 * PDF body copy here for receiver-readability.
 *
 * `standard` mode does not require an ExemptionReason — return `null`
 * and the XML builder omits the element.
 */
export function taxModeExemptionReason(mode: TaxMode): string | null {
  return taxModeBoilerplate(mode);
}
