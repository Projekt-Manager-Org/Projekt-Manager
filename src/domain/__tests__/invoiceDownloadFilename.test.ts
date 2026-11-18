import { describe, it, expect } from 'vitest';
import { buildInvoiceDownloadFilename } from '../invoice';

/**
 * The download file name of an issued invoice or Storno
 * (data-model.md §5.15 Rendered document): `<number>_<recipient name>.pdf`,
 * the name reduced to characters safe in a file name; `<number>.pdf`
 * without one. Both the server download and the client save use it.
 */

const invoice = (number: string, name: string) => ({ id: 'inv-1', number, recipient: { name } });

describe('AC-711: invoice download file name', () => {
  it('joins the number and the recipient name', () => {
    expect(buildInvoiceDownloadFilename(invoice('RE-2026-0001', 'Mustermann GmbH'))).toBe(
      'RE-2026-0001_Mustermann-GmbH.pdf',
    );
    expect(buildInvoiceDownloadFilename(invoice('ST-2026-0001', 'Mustermann GmbH'))).toBe(
      'ST-2026-0001_Mustermann-GmbH.pdf',
    );
  });

  it('drops characters unsafe in a file name', () => {
    expect(buildInvoiceDownloadFilename(invoice('RE-2026-0002', 'A/B\\C: "Bau" <GmbH>\n'))).toBe(
      'RE-2026-0002_ABC-Bau-GmbH.pdf',
    );
  });

  it('falls back to the number when the name is missing or nothing safe remains', () => {
    expect(buildInvoiceDownloadFilename(invoice('RE-2026-0003', ''))).toBe('RE-2026-0003.pdf');
    expect(buildInvoiceDownloadFilename(invoice('RE-2026-0004', ' /:* '))).toBe('RE-2026-0004.pdf');
  });
});
