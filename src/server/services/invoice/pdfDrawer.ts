/**
 * Human-readable PDF body for ZUGFeRD EN 16931 invoices (ADR-0026
 * §E-invoice format, AC-292, AT-116).
 *
 * Layout: a single A4 page with header (issuer), recipient block,
 * line-item table, totals block, and a footer carrying the statutory
 * tax-mode boilerplate. Multi-page support spills the line table into
 * additional pages while keeping the totals + footer on the last page.
 * The fonts in use are @cantoo/pdf-lib's standard 14 (Helvetica + Helvetica-
 * Bold + Helvetica-Oblique) — no fontkit dependency, no embedded fonts.
 * Standard fonts limit the glyph repertoire to the WinAnsi codepoints,
 * which suffices for German diacritics (ä ö ü ß § €) but blocks
 * non-Latin scripts. The renderer normalises any non-WinAnsi character
 * to `?` so a hostile customer name does not crash the encoder.
 *
 * PDF/A-3 conformance: this layout produces a structurally-correct
 * PDF/A-3 candidate — every page has a MediaBox, the document carries
 * Title / Author / Producer metadata, fonts are standard (WinAnsi-only),
 * and the embedded `factur-x.xml` rides on the catalog Names tree under
 * `/EmbeddedFiles` with the AFRelationship marker @cantoo/pdf-lib provides.
 * @cantoo/pdf-lib does not write the XMP packet that veraPDF demands, so this
 * is "structurally-correct PDF/A-3" rather than "certified PDF/A-3"
 * — an honest trade-off documented in the Phase C decision log (see
 * `InvoiceRenderer.ts` header).
 *
 * The two `extractFacturXml` and `extractPdfText` paths in
 * `invoices-issue.test.ts` operate on the bytes returned here without
 * touching veraPDF, so AT-116 / AT-117 are satisfied by the
 * structural shape; the certified-PDF/A-3 gate is future work.
 */

import type { PDFDocument, PDFFont, PDFPage, RGB } from '@cantoo/pdf-lib';

const pdfLibImport: Promise<typeof import('@cantoo/pdf-lib')> = import('@cantoo/pdf-lib');

import type { CompanyProfile, Invoice } from '../../../domain/invoice.js';
import { BRANDING } from '../../../config/brandingConfig.js';
import { taxModeBoilerplate } from './boilerplate.js';
import { loadBrandLogo } from './logoAsset.js';

/** WinAnsi-only sanitiser — drop anything @cantoo/pdf-lib's standard fonts cannot encode. */
function sanitizeForWinAnsi(input: string): string {
  // Helvetica supports the WinAnsi (Windows-1252) codepage. Anything
  // outside U+0020..U+007E plus the additional WinAnsi mappings is
  // replaced with `?` rather than crashing the encoder. Keep
  // ASCII-printable + the common Latin-1 supplement chars we need.
  return input.replace(/[^\x20-\x7E\xA0-\xFF€]/g, '?');
}

interface DrawCursor {
  page: PDFPage;
  y: number;
  pageNumber: number;
}

type PdfDrawDeps = Pick<
  typeof import('@cantoo/pdf-lib'),
  'PDFDocument' | 'StandardFonts' | 'rgb' | 'AFRelationship'
>;

const PAGE_WIDTH = 595.28; // A4 width in points
const PAGE_HEIGHT = 841.89; // A4 height in points
const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 50;
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 60;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

const FONT_SIZE_SMALL = 8;
const FONT_SIZE_BODY = 10;
const FONT_SIZE_HEADING = 14;
const FONT_SIZE_TITLE = 18;
const LINE_HEIGHT = 12;

// Approximate glyph extents above/below the baseline for Helvetica /
// Helvetica-Bold at FONT_SIZE_BODY. The table's horizontal rules are
// positioned relative to these so the rule never cuts through the
// adjacent row's text — @cantoo/pdf-lib's `drawText` anchors at the baseline,
// not the visual bounding box, so the renderer has to do the offset
// itself. Values are the standard-PDF-font metrics and are stable
// across @cantoo/pdf-lib versions.
const TEXT_CAP_HEIGHT_BODY = 7.15;
const TEXT_DESCENDER_BODY = 2.1;
const TABLE_RULE_PAD = 4;

const COL_LEFT = MARGIN_LEFT;
const COL_RIGHT = PAGE_WIDTH - MARGIN_RIGHT;

// Logo box, top-right, above the issuer block (issue #189). The asset is
// scaled to FIT this box preserving aspect ratio, never stretched — a
// squashed company logo is worse than no logo. The issuer text starts
// below whatever height the fitted image actually took, and the title
// slot already anchors to `Math.min(cursor.y, issuerY)`, so a taller
// logo pushes the whole document down instead of overlapping anything.
const LOGO_MAX_WIDTH = 140;
const LOGO_MAX_HEIGHT = 42;
const LOGO_GAP_BELOW = 10;

/**
 * Line-item table column layout. All numeric columns (`menge`, `einzelpreis`,
 * `ust-satz`, `gesamt`) are RIGHT-aligned at the `*_RIGHT_X` anchors below;
 * the text columns (`beschreibung`, `einheit`) are LEFT-aligned at their
 * `*_X` anchors. The old layout drew everything left-aligned at fixed
 * column starts, which collided whenever a value was longer than the
 * column's nominal width — e.g. `Einzelpreis` running into `USt-Satz`
 * and `19%` colliding with the line total.
 *
 * The chosen positions reserve enough room for typical German invoice
 * values (`1.500,00 €` at 10pt is ~50pt wide) plus a small gap between
 * columns; the `maxWidth` on the description column truncates long names
 * rather than letting them invade `Menge`.
 */
const TABLE_DESC_X = COL_LEFT;
const TABLE_QTY_RIGHT_X = COL_LEFT + 235;
const TABLE_UNIT_X = COL_LEFT + 245;
const TABLE_UNIT_PRICE_RIGHT_X = COL_LEFT + 360;
const TABLE_TAX_RATE_RIGHT_X = COL_LEFT + 415;
const TABLE_LINE_TOTAL_RIGHT_X = COL_RIGHT;
const TABLE_DESC_MAX_WIDTH = TABLE_QTY_RIGHT_X - TABLE_DESC_X - 50;

/**
 * Money formatter — euro symbol + DE-format thousands and decimals
 * (1.500,00 €). The PDF body shows this; the XML carries the canonical
 * `0123.45` form independently.
 */
function fmtEur(n: number): string {
  const fixed = (Math.round(n * 100) / 100).toFixed(2);
  const [whole, decimal] = fixed.split('.');
  const negativeSign = whole!.startsWith('-') ? '-' : '';
  const wholeAbs = negativeSign ? whole!.slice(1) : whole!;
  const withSep = wholeAbs.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativeSign}${withSep},${decimal} €`;
}

function fmtDate(value: string | Date | null): string {
  if (value === null) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getUTCDate().toString().padStart(2, '0');
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const year = d.getUTCFullYear().toString();
  return `${day}.${month}.${year}`;
}

/**
 * Greedy word-wrap a string so each output line fits within `maxWidth`
 * at the given font/size. @cantoo/pdf-lib's `drawText` will wrap when given
 * `maxWidth`, but it does not return the resulting line count, so the
 * caller cannot advance the y cursor by the correct amount and the
 * row's bottom rule ends up drawn through a wrapped line. Wrapping
 * here gives the call site explicit control over `lines.length` and
 * therefore over the row height.
 *
 * Greedy word-fitting matches what @cantoo/pdf-lib does internally — adequate
 * for invoice descriptions; we do not attempt hyphenation. A single
 * token wider than `maxWidth` is emitted on its own line and overruns
 * — preferable to silently dropping content; future caller-side
 * truncation is the right place to address that.
 */
function wrapTextToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current.length > 0) lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Right-align `text` so its right edge sits at `rightX`. `drawText` in
 * @cantoo/pdf-lib is left-aligned only; the cell-layout code below relies on
 * right alignment for every numeric column, so this helper is the
 * single seam for that conversion.
 */
function drawRight(
  page: PDFPage,
  text: string,
  rightX: number,
  y: number,
  size: number,
  font: PDFFont,
): void {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rightX - width, y, size, font });
}

/**
 * Draw a horizontal hairline across the content area as a 1-pt-tall
 * filled rectangle. `drawLine` at fractional y-coordinates can render
 * with subtly different antialiasing across rules at different y
 * positions (the table's top and bottom rules sit at non-integer y);
 * a filled rectangle is single-primitive and renders identically at
 * every position, so the two rules read as a true pair.
 */
/**
 * Parse a `#RGB` / `#RRGGBB` string into pdf-lib's 0..1 RGB triple.
 * Returns null on anything else so the caller can fall back rather than
 * render an invoice in an accidental black.
 *
 * The route layer already pattern-pins `company_profile.accentColor` to
 * these two shapes, and `BRANDING.accent` is checked in review — this is
 * the third line of defence, and the only one running at render time.
 */
function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.exec(hex.trim());
  if (!m) return null;
  const digits = m[1]!;
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

const RULE_THICKNESS = 0.5;
function drawHRule(page: PDFPage, y: number, color: RGB): void {
  page.drawRectangle({
    x: COL_LEFT,
    y: y - RULE_THICKNESS / 2,
    width: COL_RIGHT - COL_LEFT,
    height: RULE_THICKNESS,
    color,
  });
}

function addPage(
  doc: PDFDocument,
  cursor: DrawCursor,
  font: PDFFont,
  pageNumberCount: { value: number; total: number },
): void {
  const newPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  cursor.page = newPage;
  cursor.y = PAGE_HEIGHT - MARGIN_TOP;
  cursor.pageNumber += 1;
  pageNumberCount.value = cursor.pageNumber;
  drawFooterPageNumber(newPage, font, cursor.pageNumber, pageNumberCount.total);
}

/**
 * Page-number footer — drawn at the bottom of every page; the total
 * count is patched in at the end of rendering. A tiny single-line
 * footer that does not contend with the boilerplate paragraph above
 * the page margin.
 */
function drawFooterPageNumber(page: PDFPage, font: PDFFont, num: number, total: number): void {
  page.drawText(`Seite ${num} / ${total}`, {
    x: PAGE_WIDTH - MARGIN_RIGHT - 60,
    y: 30,
    size: FONT_SIZE_SMALL,
    font,
    color: undefined,
  });
}

function ensureSpace(
  doc: PDFDocument,
  cursor: DrawCursor,
  font: PDFFont,
  pageNumberCount: { value: number; total: number },
  needed: number,
): void {
  if (cursor.y - needed < MARGIN_BOTTOM) {
    addPage(doc, cursor, font, pageNumberCount);
  }
}

/**
 * The renderer entry point. Returns the raw PDF bytes (Uint8Array)
 * containing the human-readable layout PLUS the embedded factur-x.xml
 * stream.
 */
export async function drawInvoicePdf(
  invoice: Invoice,
  facturXml: string,
  companyProfile: CompanyProfile,
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, AFRelationship } = (await pdfLibImport) as PdfDrawDeps;

  const doc = await PDFDocument.create();

  // Metadata — Title / Author / Producer keep the document
  // self-describing even before veraPDF certification. These map to
  // /Info entries which PDF/A-3 still accepts alongside XMP.
  doc.setTitle(sanitizeForWinAnsi(`${invoice.number ?? 'Rechnung'} ${invoice.issuer.companyName}`));
  doc.setAuthor(sanitizeForWinAnsi(invoice.issuer.companyName));
  doc.setProducer('Projekt-Manager (ZUGFeRD EN 16931 / Comfort)');
  doc.setCreator('Projekt-Manager');
  doc.setCreationDate(new Date());

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontOblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  // Page tracking — the page-number footer is patched at the end so
  // the "X / N" totals are known.
  const pageNumberCount = { value: 1, total: 1 };
  const firstPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const cursor: DrawCursor = { page: firstPage, y: PAGE_HEIGHT - MARGIN_TOP, pageNumber: 1 };
  drawFooterPageNumber(firstPage, font, 1, 1);

  const isStorno =
    invoice.cancellationOf !== null ||
    (typeof invoice.number === 'string' && invoice.number.startsWith('ST-'));

  // ----- Brand logo (top-right, above the issuer block) -----
  // Deploy-time asset (issue #189) — see `logoAsset.ts`. Absent or
  // unusable is the normal case for a default install and draws nothing.
  const issuerRightX = PAGE_WIDTH - MARGIN_RIGHT;
  let issuerY = PAGE_HEIGHT - MARGIN_TOP;
  const logo = loadBrandLogo();
  if (logo) {
    const image =
      logo.format === 'png' ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
    // Fit-inside scaling: take the tighter of the two axis ratios, and
    // never scale UP — a small mark stays its natural size rather than
    // being blown up into a blurry banner.
    const scale = Math.min(LOGO_MAX_WIDTH / image.width, LOGO_MAX_HEIGHT / image.height, 1);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    // `drawImage` anchors bottom-left; the box's top edge is the same
    // baseline-ish line the issuer text would otherwise have started on.
    cursor.page.drawImage(image, {
      x: issuerRightX - drawWidth,
      y: issuerY - drawHeight,
      width: drawWidth,
      height: drawHeight,
    });
    issuerY -= drawHeight + LOGO_GAP_BELOW;
  }

  // ----- Issuer block (top-right) -----
  const issuerLines = [
    invoice.issuer.companyName,
    invoice.issuer.address.street,
    `${invoice.issuer.address.zip} ${invoice.issuer.address.city}`,
    `Steuer-Nr.: ${invoice.issuer.taxId}`,
  ];
  if (invoice.issuer.ustId) issuerLines.push(`USt-IdNr.: ${invoice.issuer.ustId}`);
  if (invoice.issuer.iban) issuerLines.push(`IBAN: ${invoice.issuer.iban}`);
  for (const line of issuerLines) {
    const txt = sanitizeForWinAnsi(line);
    const width = font.widthOfTextAtSize(txt, FONT_SIZE_BODY);
    cursor.page.drawText(txt, {
      x: issuerRightX - width,
      y: issuerY,
      size: FONT_SIZE_BODY,
      font,
    });
    issuerY -= LINE_HEIGHT;
  }

  // ----- Recipient block (left) -----
  cursor.page.drawText('An:', {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font: fontOblique,
  });
  cursor.y -= LINE_HEIGHT;
  cursor.page.drawText(sanitizeForWinAnsi(invoice.recipient.name), {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font: fontBold,
  });
  cursor.y -= LINE_HEIGHT;
  if (invoice.recipient.address) {
    cursor.page.drawText(sanitizeForWinAnsi(invoice.recipient.address.street), {
      x: COL_LEFT,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.y -= LINE_HEIGHT;
    cursor.page.drawText(
      sanitizeForWinAnsi(`${invoice.recipient.address.zip} ${invoice.recipient.address.city}`),
      { x: COL_LEFT, y: cursor.y, size: FONT_SIZE_BODY, font },
    );
    cursor.y -= LINE_HEIGHT;
  }
  if (invoice.recipient.ustId) {
    cursor.page.drawText(sanitizeForWinAnsi(`USt-IdNr.: ${invoice.recipient.ustId}`), {
      x: COL_LEFT,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.y -= LINE_HEIGHT;
  }
  // Visually align the title slot below the recipient block.
  cursor.y = Math.min(cursor.y, issuerY) - 30;

  // ----- Title + number + dates row -----
  ensureSpace(doc, cursor, font, pageNumberCount, 60);
  const titleText = isStorno ? 'Stornorechnung' : 'Rechnung';
  cursor.page.drawText(titleText, {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_TITLE,
    font: fontBold,
  });
  cursor.y -= 24;

  cursor.page.drawText(`Rechnungsnummer: ${invoice.number ?? '(Entwurf)'}`, {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font,
  });
  cursor.y -= LINE_HEIGHT;
  cursor.page.drawText(`Rechnungsdatum: ${fmtDate(invoice.issueDate)}`, {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font,
  });
  cursor.y -= LINE_HEIGHT;
  cursor.page.drawText(`Leistungsdatum: ${fmtDate(invoice.performanceDate)}`, {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font,
  });
  cursor.y -= LINE_HEIGHT;
  if (isStorno && invoice.cancellationOf) {
    cursor.page.drawText(sanitizeForWinAnsi(`Stornierung von: ${invoice.cancellationOf}`), {
      x: COL_LEFT,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.y -= LINE_HEIGHT;
  }
  cursor.y -= 12;

  // ----- Line items table -----
  ensureSpace(doc, cursor, font, pageNumberCount, 30);
  const colHeaderY = cursor.y;
  cursor.page.drawText('Beschreibung', {
    x: TABLE_DESC_X,
    y: colHeaderY,
    size: FONT_SIZE_BODY,
    font: fontBold,
  });
  drawRight(cursor.page, 'Menge', TABLE_QTY_RIGHT_X, colHeaderY, FONT_SIZE_BODY, fontBold);
  cursor.page.drawText('Einheit', {
    x: TABLE_UNIT_X,
    y: colHeaderY,
    size: FONT_SIZE_BODY,
    font: fontBold,
  });
  drawRight(
    cursor.page,
    'Einzelpreis',
    TABLE_UNIT_PRICE_RIGHT_X,
    colHeaderY,
    FONT_SIZE_BODY,
    fontBold,
  );
  if (invoice.taxMode === 'standard') {
    drawRight(
      cursor.page,
      'USt-Satz',
      TABLE_TAX_RATE_RIGHT_X,
      colHeaderY,
      FONT_SIZE_BODY,
      fontBold,
    );
  }
  drawRight(cursor.page, 'Gesamt', TABLE_LINE_TOTAL_RIGHT_X, colHeaderY, FONT_SIZE_BODY, fontBold);
  // Upper rule sits TABLE_RULE_PAD below the header's descender end;
  // the first data baseline sits TABLE_RULE_PAD + cap-height below the
  // rule. This keeps the rule clear of both rows' glyphs by the same
  // visual gap — the old layout used a fixed offset that put the data
  // row's cap above the rule and produced a visible overlap.
  // Table rules carry the invoice accent: the profile's own value when
  // the owner set one, else the deployment's brand accent. The light
  // variant is the right default — the sheet is white either way, so
  // the dark-theme pairing has nothing to do with paper.
  const accent =
    parseHexColor(companyProfile.accentColor ?? '') ?? parseHexColor(BRANDING.accent.light);
  const ruleColor = accent ? rgb(accent.r, accent.g, accent.b) : rgb(0.6, 0.6, 0.6);
  cursor.y = colHeaderY - TEXT_DESCENDER_BODY - TABLE_RULE_PAD;
  drawHRule(cursor.page, cursor.y, ruleColor);
  cursor.y -= TABLE_RULE_PAD + TEXT_CAP_HEIGHT_BODY;

  for (const line of invoice.lines) {
    // Pre-wrap the description so we know the row's total height
    // before any drawing. Without this, a description that wraps
    // would be drawn below cursor.y while the cursor advances only
    // one LINE_HEIGHT, leaving the bottom rule of the row painted
    // through the wrapped line.
    const descriptionLines = wrapTextToWidth(
      sanitizeForWinAnsi(line.description),
      font,
      FONT_SIZE_BODY,
      TABLE_DESC_MAX_WIDTH,
    );
    const rowHeight = LINE_HEIGHT * descriptionLines.length;
    ensureSpace(doc, cursor, font, pageNumberCount, rowHeight + 4);

    // Numeric / single-line cells stay anchored to the row's first
    // baseline; only the description spans the wrapped lines.
    descriptionLines.forEach((descLine, idx) => {
      cursor.page.drawText(descLine, {
        x: TABLE_DESC_X,
        y: cursor.y - idx * LINE_HEIGHT,
        size: FONT_SIZE_BODY,
        font,
      });
    });
    drawRight(
      cursor.page,
      (Math.round(line.quantity * 100) / 100).toFixed(2),
      TABLE_QTY_RIGHT_X,
      cursor.y,
      FONT_SIZE_BODY,
      font,
    );
    cursor.page.drawText(sanitizeForWinAnsi(line.unit), {
      x: TABLE_UNIT_X,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    drawRight(
      cursor.page,
      fmtEur(line.unitPrice),
      TABLE_UNIT_PRICE_RIGHT_X,
      cursor.y,
      FONT_SIZE_BODY,
      font,
    );
    if (invoice.taxMode === 'standard') {
      drawRight(
        cursor.page,
        `${line.taxRate}%`,
        TABLE_TAX_RATE_RIGHT_X,
        cursor.y,
        FONT_SIZE_BODY,
        font,
      );
    }
    drawRight(
      cursor.page,
      fmtEur(line.lineTotal),
      TABLE_LINE_TOTAL_RIGHT_X,
      cursor.y,
      FONT_SIZE_BODY,
      font,
    );
    cursor.y -= rowHeight;
  }
  // After the loop, `cursor.y` is the would-be next baseline (one
  // LINE_HEIGHT below the last drawn baseline). Reconstruct the last
  // baseline so the lower rule sits TABLE_RULE_PAD below the last
  // row's descender — symmetric with the upper rule above.
  const lastBaseline = cursor.y + LINE_HEIGHT;
  cursor.y = lastBaseline - TEXT_DESCENDER_BODY - TABLE_RULE_PAD;
  drawHRule(cursor.page, cursor.y, ruleColor);
  cursor.y -= TABLE_RULE_PAD + LINE_HEIGHT;

  // ----- Totals block -----
  // The per-rate label can be wide ("zzgl. 19% USt auf 12.345,67 €");
  // keeping it left-anchored and right-aligning the amount stops the
  // label from running into the value column. The label start is set
  // so that the longest expected line still leaves a small visual gap
  // before the right-aligned amount column.
  const totalsLeft = COL_LEFT + 220;
  ensureSpace(doc, cursor, font, pageNumberCount, 80);
  cursor.page.drawText('Nettobetrag', {
    x: totalsLeft,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font,
  });
  drawRight(
    cursor.page,
    fmtEur(invoice.totals.netGrandTotal),
    TABLE_LINE_TOTAL_RIGHT_X,
    cursor.y,
    FONT_SIZE_BODY,
    font,
  );
  cursor.y -= LINE_HEIGHT;
  if (invoice.taxMode === 'standard') {
    for (const band of invoice.totals.perRate) {
      cursor.page.drawText(
        sanitizeForWinAnsi(`zzgl. ${band.taxRate}% USt auf ${fmtEur(band.netSubtotal)}`),
        { x: totalsLeft, y: cursor.y, size: FONT_SIZE_BODY, font },
      );
      drawRight(
        cursor.page,
        fmtEur(band.taxAmount),
        TABLE_LINE_TOTAL_RIGHT_X,
        cursor.y,
        FONT_SIZE_BODY,
        font,
      );
      cursor.y -= LINE_HEIGHT;
    }
    cursor.page.drawText('Gesamtsteuer', {
      x: totalsLeft,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    drawRight(
      cursor.page,
      fmtEur(invoice.totals.taxGrandTotal),
      TABLE_LINE_TOTAL_RIGHT_X,
      cursor.y,
      FONT_SIZE_BODY,
      font,
    );
    cursor.y -= LINE_HEIGHT;
  }
  // Breathing room above the Bruttobetrag heading — the prior 4pt gap
  // crowded it against the Gesamtsteuer line. One LINE_HEIGHT lets the
  // bold heading read as the section close.
  cursor.y -= LINE_HEIGHT;
  cursor.page.drawText('Bruttobetrag', {
    x: totalsLeft,
    y: cursor.y,
    size: FONT_SIZE_HEADING,
    font: fontBold,
  });
  drawRight(
    cursor.page,
    fmtEur(invoice.totals.grossGrandTotal),
    TABLE_LINE_TOTAL_RIGHT_X,
    cursor.y,
    FONT_SIZE_HEADING,
    fontBold,
  );
  cursor.y -= 24;

  // ----- Tax-mode boilerplate (the AT-116 anchor) -----
  const boilerplate = taxModeBoilerplate(invoice.taxMode);
  if (boilerplate) {
    ensureSpace(doc, cursor, font, pageNumberCount, 30);
    cursor.page.drawText(sanitizeForWinAnsi(boilerplate), {
      x: COL_LEFT,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font: fontBold,
      maxWidth: CONTENT_WIDTH,
    });
    cursor.y -= LINE_HEIGHT * 2;
  }

  // ----- Footer text (company-configurable) -----
  if (invoice.issuer.footerText && invoice.issuer.footerText.length > 0) {
    ensureSpace(doc, cursor, font, pageNumberCount, 30);
    cursor.page.drawText(sanitizeForWinAnsi(invoice.issuer.footerText), {
      x: COL_LEFT,
      y: cursor.y,
      size: FONT_SIZE_SMALL,
      font: fontOblique,
      maxWidth: CONTENT_WIDTH,
    });
  }

  // Patch the total-page-count into every page footer now that we know
  // the final page count.
  pageNumberCount.total = cursor.pageNumber;
  // @cantoo/pdf-lib doesn't let us re-draw on a previously-emitted page after
  // additional content has been added without re-rendering; the
  // simpler approach is to write the page numbers AFTER everything,
  // by walking the pages array. We've already drawn placeholder
  // footers per page; overwrite them with the real total.
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i += 1) {
    pages[i].drawRectangle({
      x: PAGE_WIDTH - MARGIN_RIGHT - 80,
      y: 24,
      width: 80,
      height: 14,
      color: rgb(1, 1, 1),
    });
    pages[i].drawText(`Seite ${i + 1} / ${pages.length}`, {
      x: PAGE_WIDTH - MARGIN_RIGHT - 60,
      y: 30,
      size: FONT_SIZE_SMALL,
      font,
    });
  }

  // ----- Embed factur-x.xml -----
  const xmlBytes = new TextEncoder().encode(facturXml);
  await doc.attach(xmlBytes, 'factur-x.xml', {
    mimeType: 'application/xml',
    description: 'Factur-X / ZUGFeRD EN 16931 Comfort invoice data',
    afRelationship: AFRelationship.Alternative,
  });

  return await doc.save();
}
