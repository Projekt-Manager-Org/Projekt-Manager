/**
 * Decimal money primitives (data-model.md §5.15 "Money arithmetic is
 * decimal"). A binary double enters `Big` as its shortest decimal form,
 * so `2.01` is exactly 2.01 here, never 2.0099999….
 */

import Big from 'big.js';

/** Round to two decimals, half away from zero (kaufmännisches Runden). */
export function round2Decimal(value: Big.BigSource): Big {
  return new Big(value).round(2, Big.roundHalfUp);
}

/** `round2Decimal` as a number; a magnitude beyond a double is `±Infinity`. */
export function round2(value: Big.BigSource): number {
  return round2Decimal(value).toNumber();
}

/** True when `value` carries no more than `dp` decimals. */
export function hasAtMostDecimals(value: number, dp: number): boolean {
  return new Big(value).round(dp, Big.roundDown).eq(value);
}

/**
 * Plain-notation decimal string (`.` separator, no exponent), padded to
 * at least `minDp` decimals. With `maxDp`, rounded half away from zero
 * to that many decimals; without, exact. Zero renders unsigned: a
 * negated zero on a Storno is not `-0.00`.
 */
export function formatDecimal(value: number, minDp: number, maxDp?: number): string {
  const exact = new Big(value);
  const rounded = maxDp === undefined ? exact : exact.round(maxDp, Big.roundHalfUp);
  if (rounded.eq(0)) return new Big(0).toFixed(minDp);
  const plain = rounded.toFixed();
  const dp = plain.split('.')[1]?.length ?? 0;
  return dp < minDp ? rounded.toFixed(minDp) : plain;
}
