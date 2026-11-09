/**
 * Bulk-export manifest — a recipient name must not run as a spreadsheet
 * formula (OWASP CSV injection), and Storno totals must stay numeric.
 */

import { describe, it, expect } from 'vitest';
import type { Invoice } from '../../domain/invoice.js';
import { buildManifestCsv } from '../services/InvoiceExportService.js';

/** The manifest's single data row for a Storno addressed to `name`. */
function stornoRow(name: string): string {
  const csv = buildManifestCsv([
    {
      number: 'ST-2026-0001',
      issueDate: '2026-01-02',
      status: 'issued',
      cancellationOf: 'original-id',
      recipient: { name },
      totals: { netGrandTotal: -10, taxGrandTotal: -1.9, grossGrandTotal: -11.9 },
    } as unknown as Invoice,
  ]);
  return csv.slice(csv.indexOf('\r\n') + 2);
}

const rowWithNameCell = (cell: string): string =>
  `ST-2026-0001;02.01.2026;${cell};-10,00;-1,90;-11,90;Storno\r\n`;

describe('buildManifestCsv recipient name', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+1+1', "'+1+1"],
    ['-1+1', "'-1+1"],
    ['@SUM(1)', "'@SUM(1)"],
    ['＝1+1', "'＝1+1"],
    ['＋1+1', "'＋1+1"],
    ['－1+1', "'－1+1"],
    ['＠SUM(1)', "'＠SUM(1)"],
    ['\t=1+1', "\t'=1+1"],
    ['\r=1+1', `"\r'=1+1"`],
    ['\n=1+1', `"\n'=1+1"`],
    [' =1+1', "' =1+1"],
  ])('marks leading formula %j as text and leaves negative totals numeric', (name, cell) => {
    expect(stornoRow(name)).toBe(rowWithNameCell(cell));
  });

  // The row starts unquoted, so under another import separator these
  // characters end a cell or row and quoting the name would not help.
  it.each([
    ['Foo,=1+1,bar', "Foo,'=1+1,bar"],
    ['Foo\t=1+1\tbar', "Foo\t'=1+1\tbar"],
    ['Foo\n=1+1', `"Foo\n'=1+1"`],
    ['Foo\r\n=1+1', `"Foo\r\n'=1+1"`],
    ['Foo, =1+1,bar', "Foo,' =1+1,bar"],
    ['Foo,=1+1,=2+2,bar', "Foo,'=1+1,'=2+2,bar"],
  ])('marks formula %j after a possible cell boundary', (name, cell) => {
    expect(stornoRow(name)).toBe(rowWithNameCell(cell));
  });

  it('keeps the text marker inside the quotes when the name needs escaping', () => {
    expect(stornoRow('=HYPERLINK("x";"y")')).toBe(rowWithNameCell(`"'=HYPERLINK(""x"";""y"")"`));
  });

  it.each(['Müller GmbH', 'Müller, Schmidt GmbH', 'Meier-Schulz', 'A=B KG'])(
    'does not mark ordinary name %j',
    (name) => {
      expect(stornoRow(name)).toBe(rowWithNameCell(name));
    },
  );
});
