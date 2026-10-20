import { describe, it, expect } from 'vitest';
import { deriveInvoiceLine } from '../invoice';
import { round2 } from '../money';

/**
 * Money rounding (data-model.md §5.15 "Money arithmetic is decimal",
 * AC-384): decimal values, half away from zero.
 */
describe('invoice money rounding', () => {
  it('rounds an exact half-cent away from zero for both signs', () => {
    expect(round2(0.475)).toBe(0.48);
    expect(round2(-0.475)).toBe(-0.48);
  });

  it('is sign-symmetric for the 19 % VAT of every cent value up to 2000.00', () => {
    const asymmetric: number[] = [];
    for (let cents = 1; cents <= 200_000; cents++) {
      const vat = ((cents / 100) * 19) / 100;
      if (round2(-vat) !== -round2(vat)) asymmetric.push(cents);
    }
    expect(asymmetric).toEqual([]);
  });

  it('derives lineTotal from the decimal product, not the binary one', () => {
    // 0.5 × 2.01 is 1.00499… in binary floating point.
    const line = deriveInvoiceLine({
      description: 'x',
      quantity: 0.5,
      unit: 'h',
      unitPrice: 2.01,
      taxRate: 19,
    });
    expect(line.lineTotal).toBe(1.01);
  });
});
