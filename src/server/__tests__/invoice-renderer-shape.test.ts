/**
 * Isolated renderer contract test — exercises `InvoiceRenderer`
 * without the HTTP / DB / storage plumbing so AT-116 / AT-117
 * assertions (boilerplate text, embedded `factur-x.xml`, EN 16931 XSD
 * validation) are pinned independently of Phase D's routing layer.
 *
 * The full route-driven integration arms in `invoices-issue.test.ts`
 * cover the same shape via `POST /api/invoices/:id/issue` once the
 * route lands. This file is the route-free shape pin — the renderer
 * is pure-Node by construction and must produce the same bytes
 * regardless of where it is invoked from.
 *
 * Pins:
 *   - PDF magic = `%PDF-`.
 *   - PDF text content carries the per-mode boilerplate (AT-116).
 *   - The catalog Names tree has `factur-x.xml` as an embedded file
 *     (AT-117 first assertion).
 *   - The embedded XML validates against the EN 16931 Comfort XSD
 *     (AT-117 load-bearing assertion).
 */
import { describe, it, expect } from 'vitest';
import { InvoiceRenderer } from '../services/InvoiceRenderer.js';
import { validateFacturXml } from '../services/invoice/xsdValidator.js';
import type { CompanyProfile, Invoice, TaxMode } from '../../domain/invoice.js';

const profile: CompanyProfile = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  companyName: 'Test Maler GmbH',
  address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
  taxId: '111/222/33333',
  ustId: 'DE123456789',
  iban: 'DE89370400440532013000',
  accentColor: '#f60',
  footerText: 'Vielen Dank.',
  defaultTaxMode: 'standard',
  updatedAt: '2026-05-12T00:00:00Z',
  updatedBy: null,
};

function makeInvoice(mode: TaxMode): Invoice {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    number: 'RE-2026-0001',
    status: 'issued',
    projectId: '00000000-0000-0000-0000-000000000099',
    cancellationOf: null,
    issuer: {
      companyName: 'Test Maler GmbH',
      address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
      taxId: '111/222/33333',
      ustId: mode === 'kleinunternehmer' ? null : 'DE123456789',
      iban: 'DE89370400440532013000',
      footerText: 'Vielen Dank.',
    },
    recipient: {
      name: 'Buyer GmbH',
      address: { street: 'Recipient Str. 1', zip: '20097', city: 'Hamburg' },
      ustId: mode === 'reverse_charge' ? 'DE987654321' : null,
    },
    lines: [
      {
        description: 'Anstrich Fassade',
        quantity: 1,
        unit: 'pauschal',
        unitPrice: 1500,
        lineTotal: 1500,
        taxRate: 19,
      },
    ],
    taxMode: mode,
    profile: 'zugferd-en16931',
    totals:
      mode === 'standard'
        ? {
            perRate: [{ taxRate: 19, netSubtotal: 1500, taxAmount: 285 }],
            netGrandTotal: 1500,
            taxGrandTotal: 285,
            grossGrandTotal: 1785,
          }
        : { perRate: [], netGrandTotal: 1500, taxGrandTotal: 0, grossGrandTotal: 1500 },
    issueDate: '2026-05-12',
    performanceDate: '2026-04-10',
    cancellationReason: null,
    renderedPdfBinaryDescriptorId: null,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
    createdBy: null,
    updatedBy: null,
  };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

describe('InvoiceRenderer — boilerplate (AT-116 shape, route-free)', () => {
  const renderer = new InvoiceRenderer();

  it('standard mode: 19% + 285 visible, no §19 / §13b anchors', async () => {
    const out = await renderer.render({
      invoice: makeInvoice('standard'),
      companyProfile: profile,
    });
    expect(Buffer.from(out.pdfBytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
    const text = await pdfText(out.pdfBytes);
    expect(text).toContain('19%');
    expect(text).toMatch(/285[.,]?\s*(00|–|-)?/);
    expect(text).not.toContain('§ 19 UStG');
    expect(text).not.toContain('§ 13b UStG');
  });

  it('kleinunternehmer mode: contains §19 UStG, omits §13b', async () => {
    const out = await renderer.render({
      invoice: makeInvoice('kleinunternehmer'),
      companyProfile: profile,
    });
    const text = await pdfText(out.pdfBytes);
    expect(text).toContain('§ 19 UStG');
    expect(text).not.toContain('§ 13b UStG');
  });

  it('reverse_charge mode: contains §13b UStG, omits §19', async () => {
    const out = await renderer.render({
      invoice: makeInvoice('reverse_charge'),
      companyProfile: profile,
    });
    const text = await pdfText(out.pdfBytes);
    expect(text).toContain('§ 13b UStG');
    expect(text).not.toContain('§ 19 UStG');
  });
});

describe('InvoiceRenderer — factur-x.xml + EN 16931 XSD (AT-117 shape, route-free)', () => {
  const renderer = new InvoiceRenderer();

  it('embeds factur-x.xml in the catalog Names tree and the XML validates against the EN 16931 XSD', async () => {
    const out = await renderer.render({
      invoice: makeInvoice('standard'),
      companyProfile: profile,
    });

    // Walk the catalog Names tree to confirm the embedded file lands
    // under the exact `factur-x.xml` name. This mirrors what AT-117's
    // `extractFacturXml` helper does inside `invoices-issue.test.ts`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfLib = (await import('@cantoo/pdf-lib')) as any;
    const doc = await pdfLib.PDFDocument.load(out.pdfBytes);
    const namesDict = doc.catalog.lookup(pdfLib.PDFName.of('Names'), pdfLib.PDFDict);
    const ef = namesDict.lookup(pdfLib.PDFName.of('EmbeddedFiles'), pdfLib.PDFDict);
    const arr = ef.lookup(pdfLib.PDFName.of('Names'), pdfLib.PDFArray);
    let found = false;
    for (let i = 0; i < (arr.size() as number); i += 2) {
      const entry = arr.get(i);
      let nameStr = '';
      if (entry instanceof pdfLib.PDFString) nameStr = entry.decodeText();
      if (entry instanceof pdfLib.PDFHexString) nameStr = entry.decodeText();
      if (nameStr === 'factur-x.xml') {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);

    // Explicit AT-117 anchor: assert the embedded XML validates
    // against the EN 16931 Comfort XSD. The renderer also validates
    // internally and would throw before returning — this re-check
    // pins the assertion even if the internal step is ever
    // refactored away.
    await expect(validateFacturXml(out.facturXml)).resolves.toBeUndefined();
  });
});
