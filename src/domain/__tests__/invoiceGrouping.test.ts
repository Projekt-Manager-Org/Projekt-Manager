import { describe, it, expect } from 'vitest';
import { orderInvoicesWithStornoGrouping } from '../invoiceGrouping';
import type { Invoice } from '../invoice';

/**
 * Tests for the Storno-sibling display rule (ui/invoices.md §8.16.1).
 *
 * The helper is consumed by both the per-project block and the
 * cross-project list view — the grouping must be identical across
 * surfaces. The cases below pin every branch named in the helper
 * docstring (input order independence, multi-original sets, orphan
 * Stornos, multi-Storno-per-original, duplicate id, empty input).
 */

function mkInvoice(id: string, cancellationOf: string | null): Invoice {
  return {
    id,
    number: cancellationOf ? `ST-2026-${id}` : `RE-2026-${id}`,
    status: 'issued',
    projectId: 'p1',
    cancellationOf,
    issuer: {
      companyName: 'Test',
      address: { street: 's', zip: 'z', city: 'c' },
      taxId: 't',
    },
    recipient: { name: 'r' },
    lines: [],
    taxMode: 'standard',
    profile: 'zugferd-en16931',
    totals: { perRate: [], netGrandTotal: 0, taxGrandTotal: 0, grossGrandTotal: 0 },
    issueDate: '2026-04-12',
    performanceDate: null,
    cancellationReason: null,
    renderedPdfBinaryDescriptorId: null,
    backupPending: false,
    createdAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-04-12T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
  };
}

describe('orderInvoicesWithStornoGrouping', () => {
  it('returns empty output for empty input', () => {
    expect(orderInvoicesWithStornoGrouping([])).toEqual([]);
  });

  it('places original first then storno regardless of input order', () => {
    const original = mkInvoice('a', null);
    const storno = mkInvoice('b', 'a');

    // Server sort (issueDate DESC, createdAt DESC) puts the newer Storno
    // above the original — the helper must invert that into Storno
    // below.
    expect(orderInvoicesWithStornoGrouping([storno, original]).map((i) => i.id)).toEqual([
      'a',
      'b',
    ]);
    expect(orderInvoicesWithStornoGrouping([original, storno]).map((i) => i.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('groups stornos with their parent and keeps other originals untouched', () => {
    const a = mkInvoice('a', null);
    const b = mkInvoice('b', null);
    const stornoOfA = mkInvoice('s1', 'a');

    expect(orderInvoicesWithStornoGrouping([b, stornoOfA, a]).map((i) => i.id)).toEqual([
      'b',
      'a',
      's1',
    ]);
  });

  it('renders multiple stornos for the same original in input order under that original', () => {
    const a = mkInvoice('a', null);
    const s1 = mkInvoice('s1', 'a');
    const s2 = mkInvoice('s2', 'a');

    expect(orderInvoicesWithStornoGrouping([s2, s1, a]).map((i) => i.id)).toEqual([
      'a',
      's2',
      's1',
    ]);
  });

  it('appends orphan stornos (cancellationOf not present in input) at the end', () => {
    const a = mkInvoice('a', null);
    const orphan = mkInvoice('ghost', 'not-in-list');

    expect(orderInvoicesWithStornoGrouping([a, orphan]).map((i) => i.id)).toEqual(['a', 'ghost']);
  });

  it('emits a duplicate id only once (defensive de-dup)', () => {
    const a = mkInvoice('a', null);

    expect(orderInvoicesWithStornoGrouping([a, a]).map((i) => i.id)).toEqual(['a']);
  });
});
