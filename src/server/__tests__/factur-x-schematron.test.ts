/**
 * AC-293 — `factur-x.xml` against the EN 16931 CII business
 * rules (CEN Schematron, `src/test/en16931/`), plus the XML sign
 * convention (data-model.md §5.15 *Signed amounts*) and the Storno's
 * preceding-invoice reference (#548, BT-25 / BT-26).
 *
 * Route-free: `buildFacturXml` is the XML the renderer embeds. Fixture
 * matrix: `standard` (7 % + 19 % lines) / `reverse_charge` × with /
 * without a negative line × invoice / Storno.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildFacturXml } from '../services/invoice/facturXmlBuilder.js';
import {
  computeInvoiceTotals,
  negateInvoiceLines,
  negateInvoiceTotals,
  type Invoice,
  type InvoiceLine,
  type TaxMode,
} from '../../domain/invoice.js';
import { compileEn16931Rules, validateEn16931 } from '../../test/en16931Schematron.js';

const ORIGINAL_ID = '00000000-0000-0000-0000-000000000001';

function lines(mode: TaxMode, withNegative: boolean): InvoiceLine[] {
  const rate = (r: number) => (mode === 'standard' ? r : 0);
  const base: InvoiceLine[] = [
    {
      description: 'Anstrich Wohnzimmer',
      quantity: 2,
      unit: 'Stück',
      unitPrice: 750,
      lineTotal: 1500,
      taxRate: rate(19),
    },
    {
      description: 'Fachbuch Farbgestaltung',
      quantity: 1,
      unit: 'Stück',
      unitPrice: 100,
      lineTotal: 100,
      taxRate: rate(7),
    },
  ];
  return withNegative
    ? [
        ...base,
        {
          description: 'abzgl. Abschlagszahlung',
          quantity: 2,
          unit: 'pauschal',
          unitPrice: -100,
          lineTotal: -200,
          taxRate: rate(19),
        },
      ]
    : base;
}

function invoice(mode: TaxMode, withNegative: boolean): Invoice {
  const l = lines(mode, withNegative);
  return {
    id: ORIGINAL_ID,
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
      footerText: null,
    },
    recipient: {
      name: 'Bau GmbH',
      address: { street: 'Bauweg 2', zip: '20097', city: 'Hamburg' },
      ustId: 'DE987654321',
    },
    lines: l,
    taxMode: mode,
    profile: 'zugferd-en16931',
    totals: computeInvoiceTotals(l, mode),
    issueDate: '2026-10-01',
    performanceDate: '2026-09-30',
    cancellationReason: null,
    renderedPdfBinaryDescriptorId: null,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
  };
}

function storno(original: Invoice): Invoice {
  return {
    ...original,
    id: '00000000-0000-0000-0000-000000000002',
    number: 'ST-2026-0001',
    cancellationOf: original.id,
    lines: negateInvoiceLines(original.lines),
    totals: negateInvoiceTotals(original.totals),
    cancellationReason: 'Falsches Aufmaß',
  };
}

/** What the cancel flow passes for the original (#548). */
const PRECEDING = { number: 'RE-2026-0001', issueDate: '2026-10-01' };

const AMOUNT_TAGS = [
  'ChargeAmount',
  'BilledQuantity',
  'LineTotalAmount',
  'CalculatedAmount',
  'BasisAmount',
  'TaxBasisTotalAmount',
  'TaxTotalAmount',
  'GrandTotalAmount',
  'DuePayableAmount',
] as const;

/** Every amount in document order, keyed by element name. */
function amounts(xml: string): Record<string, number[]> {
  return Object.fromEntries(
    AMOUNT_TAGS.map((tag) => [
      tag,
      [...xml.matchAll(new RegExp(`<ram:${tag}\\b[^>]*>([^<]+)</ram:${tag}>`, 'g'))].map((m) =>
        Number(m[1]),
      ),
    ]),
  );
}

const typeCode = (xml: string) =>
  /<rsm:ExchangedDocument>[\s\S]*?<ram:TypeCode>(\d+)<\/ram:TypeCode>/.exec(xml)?.[1];

const MATRIX = (['standard', 'reverse_charge'] as const).flatMap((mode) =>
  [false, true].flatMap((withNegative) =>
    (['invoice', 'storno'] as const).map((kind) => ({ mode, withNegative, kind })),
  ),
);

describe('AC-293: factur-x.xml passes the EN 16931 CII business rules', () => {
  let sef: string;

  beforeAll(() => {
    sef = compileEn16931Rules();
  }, 60_000);

  it.each(MATRIX)(
    '$mode, negative line: $withNegative, $kind — no fatal failed assert',
    ({ mode, withNegative, kind }) => {
      const original = invoice(mode, withNegative);
      const xml =
        kind === 'invoice' ? buildFacturXml(original) : buildFacturXml(storno(original), PRECEDING);
      const fatal = validateEn16931(sef, xml).filter((f) => f.flag === 'fatal');
      expect(fatal).toEqual([]);
    },
  );

  it('runs the vendored CEN artefact unmodified (src/test/en16931/README.md)', () => {
    const xslt = readFileSync(
      new URL('../../test/en16931/EN16931-CII-validation.xslt', import.meta.url),
    );
    expect(createHash('sha256').update(xslt).digest('hex')).toBe(
      '0757f07909938b1b297b8356ab7b66406c89f1b342325385d6a2def998c817f0',
    );
  });

  it('rejects a document no rule matches instead of passing it', () => {
    expect(() => validateEn16931(sef, '<x/>')).toThrow(/no EN 16931 rule fired/);
  });

  it('negative control: a negative ChargeAmount fails BR-27', () => {
    const xml = buildFacturXml(invoice('standard', false)).replace(
      /(<ram:NetPriceProductTradePrice><ram:ChargeAmount>)/,
      '$1-',
    );
    const ids = validateEn16931(sef, xml)
      .filter((f) => f.flag === 'fatal')
      .map((f) => f.id);
    expect(ids).toContain('BR-27');
  });
});

describe('data-model.md §5.15 Signed amounts — factur-x.xml', () => {
  it.each(['standard', 'reverse_charge'] as const)(
    '%s: an invoice carries 380 and the stored amounts; a negative line has BilledQuantity < 0 and ChargeAmount ≥ 0',
    (mode) => {
      const inv = invoice(mode, true);
      const xml = buildFacturXml(inv);
      expect(typeCode(xml)).toBe('380');
      const a = amounts(xml);
      expect(a.LineTotalAmount!.slice(0, inv.lines.length)).toEqual(
        inv.lines.map((l) => l.lineTotal),
      );
      expect(a.TaxBasisTotalAmount).toEqual([inv.totals.netGrandTotal]);
      expect(a.TaxTotalAmount).toEqual([inv.totals.taxGrandTotal]);
      expect(a.GrandTotalAmount).toEqual([inv.totals.grossGrandTotal]);
      expect(a.DuePayableAmount).toEqual([inv.totals.grossGrandTotal]);
      // The third line is the −100 × 2 deduction: the sign moves to the quantity.
      expect(a.ChargeAmount).toEqual(inv.lines.map((l) => Math.abs(l.unitPrice)));
      expect(a.BilledQuantity).toEqual(inv.lines.map((l) => Math.sign(l.unitPrice) * l.quantity));
    },
  );

  it.each(['standard', 'reverse_charge'] as const)(
    "%s: a Storno carries 381 and its original's line, per-rate and header amounts",
    (mode) => {
      const original = invoice(mode, true);
      const originalXml = buildFacturXml(original);
      const stornoXml = buildFacturXml(storno(original), PRECEDING);
      expect(typeCode(stornoXml)).toBe('381');
      expect(amounts(stornoXml)).toEqual(amounts(originalXml));
    },
  );
});

describe('#548: a Storno references its original by number', () => {
  it('carries the original number in BT-25 and its issue date in BT-26, not its id', () => {
    const original = invoice('standard', false);
    const xml = buildFacturXml(storno(original), PRECEDING);
    const ref = /<ram:InvoiceReferencedDocument>([\s\S]*?)<\/ram:InvoiceReferencedDocument>/.exec(
      xml,
    )?.[1];
    expect(ref).toContain('<ram:IssuerAssignedID>RE-2026-0001</ram:IssuerAssignedID>');
    expect(ref).toContain('<qdt:DateTimeString format="102">20261001</qdt:DateTimeString>');
    expect(xml).not.toContain(original.id);
  });

  it('refuses to render a Storno without its original', () => {
    expect(() => buildFacturXml(storno(invoice('standard', false)))).toThrow(/preceding invoice/);
  });
});
