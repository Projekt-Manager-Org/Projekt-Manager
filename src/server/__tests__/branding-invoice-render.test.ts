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
const WIDE_LOGO_PATH = path.join(BRAND_DIR, 'ac362-wide.png');

/**
 * A real 1x1 PNG — pdf-lib parses it, so the embed path runs for real.
 * Smaller than the logo box on both axes, which is what makes it the
 * never-enlarge fixture.
 */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A real 200x100 PNG — larger than the 140x42pt box on both axes, and
 * non-square, so fit-inside has to pick the tighter ratio (42/100) and
 * a stretch-to-fill would show up as a different width.
 */
const WIDE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAIAAABM5OhcAAABG0lEQVR4nO3SQQkAIADAQHvZztC+LeEQ5OAC7LEx14brxvMCvmQsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYicQCdbsgdbWH2cwAAAABJRU5ErkJggg==',
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

/**
 * The size, in points, the logo was actually drawn at.
 *
 * `drawImage` emits its own `q … Q` block whose `cm` matrices compose
 * into the placement — pdf-lib writes the scale as a matrix of its own,
 * alongside a translate and two identities. Multiplying the `a` and `d`
 * components across the block up to the `Do` yields the drawn size;
 * nothing here rotates, so the diagonal is the whole story.
 */
async function drawnLogoSize(
  pdfBytes: Uint8Array,
): Promise<{ width: number; height: number } | null> {
  const stream = await contentStreamText(pdfBytes);
  const doIndex = stream.indexOf('/Image-');
  if (doIndex === -1) return null;
  // The image's own block, not any earlier `q` in the document.
  const block = stream.slice(0, doIndex).slice(stream.slice(0, doIndex).lastIndexOf('\nq\n'));

  let width = 1;
  let height = 1;
  for (const m of block.matchAll(
    /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g,
  )) {
    width *= Number(m[1]);
    height *= Number(m[4]);
  }
  return { width, height };
}

beforeAll(() => {
  mkdirSync(BRAND_DIR, { recursive: true });
  writeFileSync(LOGO_PATH, ONE_PIXEL_PNG);
  writeFileSync(WIDE_LOGO_PATH, WIDE_PNG);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(LOGO_PATH, { force: true });
  rmSync(WIDE_LOGO_PATH, { force: true });
});

describe('InvoiceRenderer branding — AC-362', () => {
  it('embeds the configured logo as an image XObject', async () => {
    configureLogo('/brand/ac362-logo.png');

    const { pdfBytes } = await new InvoiceRenderer().render({ invoice, companyProfile: profile });

    expect(await countEmbeddedImages(pdfBytes)).toBe(1);
  });

  it('scales the logo to fit its box, preserving aspect ratio', async () => {
    configureLogo('/brand/ac362-wide.png');

    const { pdfBytes } = await new InvoiceRenderer().render({ invoice, companyProfile: profile });

    // 200x100 into the 140x42pt box: the height ratio (0.42) is tighter
    // than the width ratio (0.7), so both axes take 0.42 and the 2:1
    // aspect survives. A stretch-to-fill would be 140x42.
    expect(await drawnLogoSize(pdfBytes)).toEqual({ width: 84, height: 42 });
  });

  it('never enlarges a logo past its natural size', async () => {
    configureLogo('/brand/ac362-logo.png');

    const { pdfBytes } = await new InvoiceRenderer().render({ invoice, companyProfile: profile });

    // 1x1 fits the box many times over; without the upper bound of 1 on
    // the scale factor it would be blown up to a blurry 42x42 banner.
    expect(await drawnLogoSize(pdfBytes)).toEqual({ width: 1, height: 1 });
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
    expect(await drawnLogoSize(pdfBytes)).toBeNull();
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

    // The route layer pattern-pins `accentColor`, but the import path
    // does not — a restored envelope can carry anything, so the render
    // must land on the brand accent, not merely survive. `%PDF-` alone
    // is true of a black or grey render too.
    expect(Buffer.from(pdfBytes).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await contentStreamText(pdfBytes)).toMatch(/0\.231\d* 0\.509\d* 0\.964\d* rg/);
  });
});
