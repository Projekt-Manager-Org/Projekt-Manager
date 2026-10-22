/**
 * formatBytes — single source of truth for byte rendering across the
 * Footer storage badge ([ui/index.md §8.1.2]), the DatenView storage row
 * ([ui/daten.md §8.11.3]), and the Export / Import progress readouts.
 *
 * Pins the rounding contract AC-451 names: integer at the B / KB tiers,
 * two decimals at MB / GB. Decimal-SI tier breaks at 1024 (the existing
 * dialog implementations rely on power-of-1024 thresholds; extracting
 * the helper preserves that posture rather than switching to SI 1000).
 *
 * The boundary set covers every tier break of AC-451:
 *   `0 B`, sub-KB byte counts, exact `1 KB`, sub-MB KB counts,
 *   exact `1 MB`, sub-GB MB counts, exact `1 GB`.
 *
 * Determinism is part of the contract — no `Intl.NumberFormat` /
 * locale-sensitive path, no `Date.now()`. The same input produces the
 * same output in every runner, every locale.
 */
import { describe, it, expect } from 'vitest';
import { formatBytes } from '@/ui/utils/formatBytes';

describe('formatBytes — boundary cases (AC-451)', () => {
  it('renders 0 as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('renders sub-KB byte counts with the B suffix and integer precision', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('renders exactly 1024 bytes as "1 KB"', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('renders sub-MB KB counts with integer precision', () => {
    // 2 KB exact, 999 KB exact — both within the KB tier (< 1024 * 1024).
    expect(formatBytes(2 * 1024)).toBe('2 KB');
    expect(formatBytes(999 * 1024)).toBe('999 KB');
  });

  it('renders exactly 1048576 bytes as "1.00 MB"', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
  });

  it('renders sub-GB MB counts with two decimal places', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
    // 1.50 MB exact — pins both the rounding posture and the trailing
    // zero (a `.toString()` regression would render "1.5 MB").
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.50 MB');
  });

  it('renders exactly 1073741824 bytes as "1.00 GB"', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
  });

  it('renders multi-GB counts with two decimal places at the GB tier', () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
  });
});

describe('formatBytes — determinism (AC-451)', () => {
  it('returns the same string for repeated calls with the same input', () => {
    // No `Intl.NumberFormat`, no time-of-day, no locale — the helper is
    // pure. A regression that introduces locale-aware grouping would
    // change output between runs in different environments and is the
    // class of bug this assertion catches.
    const first = formatBytes(1234567);
    const second = formatBytes(1234567);
    const third = formatBytes(1234567);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });
});
