/**
 * Renderer tests — brand logo and invoice accent (issue #189, AC-362).
 *
 * Route-free, like `invoice-renderer-shape.test.ts`: the renderer is
 * pure-Node, so the branding surface can be pinned without HTTP, DB or
 * object storage in the way.
 *
 * Two properties matter here. The logo must actually reach the PDF as an
 * image XObject when a deployment configures one — "it did not throw" is
 * not evidence that anything was drawn. And a misconfigured asset must
 * still produce a valid invoice: this code path runs inside the issuance
 * transaction that holds the gapless number-sequence lock, so degrading
 * is mandatory and failing is not an option.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BRANDING } from '../../config/brandingConfig.js';
import { DIST_ROOT } from '../staticRoot.js';
import { InvoiceRenderer } from '../services/InvoiceRenderer.js';
import type { CompanyProfile, Invoice } from '../../domain/invoice.js';

const BRAND_DIR = path.join(DIST_ROOT, 'brand');
const LOGO_PATH = path.join(BRAND_DIR, 'ac362-logo.png');

/** A real 1x1 PNG — pdf-lib parses it, so the embed path runs for real. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ORIGINAL_MARK = { ...BRANDING.mark };

function configureLogo(value: string | undefined): void {
  vi.spyOn(BRANDING, 'mark', 'get').mockReturnValue({ ...ORIGINAL_MARK, logo: value });
}

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

const invoice: Invoice = {
  id: '00000000-0000-0000-0000-000000000001',
  number: 'RE-2026-0001',
  status: 'issued',
  projectId: '00000000-0000-0000-0000-000000000099',
  cancellationOf: null,
  issuer: {
    companyName: 'Test Maler GmbH',
    address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
    taxId: '111/222/33333',
    ustId: 'DE123456789',
    iban: 'DE89370400440532013000',
    footerText: 'Vielen Dank.',
  },
  recipient: {
    name: 'Buyer GmbH',
    address: { street: 'Recipient Str. 1', zip: '20097', city: 'Hamburg' },
    ustId: null,
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
  taxMode: 'standard',
  profile: 'zugferd-en16931',
  totals: {
    perRate: [{ taxRate: 19, netSubtotal: 1500, taxAmount: 285 }],
    netGrandTotal: 1500,
    taxGrandTotal: 285,
    grossGrandTotal: 1785,
  },
  issueDate: '2026-05-12',
  performanceDate: '2026-04-10',
  cancellationReason: null,
  renderedPdfBinaryDescriptorId: null,
  createdAt: '2026-05-12T00:00:00Z',
  updatedAt: '2026-05-12T00:00:00Z',
  createdBy: null,
  updatedBy: null,
};

/**
 * Count image XObjects across the document's pages. An embedded image
 * lands as a `PDFRawStream` whose `/Subtype` lives on the stream's dict,
 * not on the stream object itself.
 */
async function countEmbeddedImages(pdfBytes: Uint8Array): Promise<number> {
  const { PDFDocument, PDFName, PDFDict, PDFRawStream } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.load(pdfBytes);
  let images = 0;
  for (const page of doc.getPages()) {
    const xObjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xObjects) continue;
    for (const key of xObjects.keys()) {
      const entry = xObjects.lookup(key);
      if (
        entry instanceof PDFRawStream &&
        entry.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
      ) {
        images += 1;
      }
    }
  }
  return images;
}

/**
 * Concatenated, decompressed page content streams. pdf-lib Flate-encodes
 * them on save, so the drawing operators — including the `r g b rg` fill
 * colour the table rules are painted with — are not greppable in the raw
 * file bytes.
 */
async function contentStreamText(pdfBytes: Uint8Array): Promise<string> {
  const { PDFDocument, PDFName, PDFRawStream, PDFArray } = await import('@cantoo/pdf-lib');
  const { inflateSync } = await import('node:zlib');
  const doc = await PDFDocument.load(pdfBytes);
  const chunks: string[] = [];
  for (const page of doc.getPages()) {
    const ctx = page.node.context;
    const resolved = ctx.lookup(page.node.get(PDFName.of('Contents')));
    const streams =
      resolved instanceof PDFArray ? resolved.asArray().map((r) => ctx.lookup(r)) : [resolved];
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream)) continue;
      const raw = Buffer.from(stream.contents);
      const filter = stream.dict.get(PDFName.of('Filter'))?.toString() ?? '';
      chunks.push(
        filter.includes('Flate') ? inflateSync(raw).toString('latin1') : raw.toString('latin1'),
      );
    }
  }
  return chunks.join('\n');
}

beforeAll(() => {
  mkdirSync(BRAND_DIR, { recursive: true });
  writeFileSync(LOGO_PATH, ONE_PIXEL_PNG);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(LOGO_PATH, { force: true });
});

describe('InvoiceRenderer branding — AC-362', () => {
  it('embeds the configured logo as an image XObject', async () => {
    configureLogo('/brand/ac362-logo.png');

    const { pdfBytes } = await new InvoiceRenderer().render({ invoice, companyProfile: profile });

    expect(await countEmbeddedImages(pdfBytes)).toBe(1);
  });

  it('draws no image when no logo is configured (the default install)', async () => {
    configureLogo(undefined);

    const { pdfBytes } = await new InvoiceRenderer().render({ invoice, companyProfile: profile });

    expect(await countEmbeddedImages(pdfBytes)).toBe(0);
  });

  it('still renders a valid invoice when the configured asset is missing', async () => {
    configureLogo('/brand/ac362-typo.png');

    const { pdfBytes } = await new InvoiceRenderer().render({ invoice, companyProfile: profile });

    // Degraded, not failed: a PDF came back, it just has no logo on it.
    expect(Buffer.from(pdfBytes).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await countEmbeddedImages(pdfBytes)).toBe(0);
  });

  it('paints the table rules in the profile accent', async () => {
    configureLogo(undefined);

    const { pdfBytes } = await new InvoiceRenderer().render({ invoice, companyProfile: profile });

    // `#f60` -> rgb(1, 0.4, 0), written as a fill-colour operator.
    expect(await contentStreamText(pdfBytes)).toContain('1 0.4 0 rg');
  });

  it('falls back to the brand accent when the profile sets none', async () => {
    configureLogo(undefined);

    const { pdfBytes } = await new InvoiceRenderer().render({
      invoice,
      companyProfile: { ...profile, accentColor: null },
    });

    // BRANDING.accent.light is #3b82f6 -> 0.231… 0.509… 0.964…
    const stream = await contentStreamText(pdfBytes);
    expect(stream).not.toContain('1 0.4 0 rg');
    expect(stream).toMatch(/0\.231\d* 0\.509\d* 0\.964\d* rg/);
  });

  it('falls back rather than throwing on a malformed accent value', async () => {
    configureLogo(undefined);

    const { pdfBytes } = await new InvoiceRenderer().render({
      invoice,
      companyProfile: { ...profile, accentColor: 'not-a-color' },
    });

    expect(Buffer.from(pdfBytes).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
