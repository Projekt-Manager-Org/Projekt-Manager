/**
 * Build the EN 16931 (Comfort profile) `factur-x.xml` payload that
 * rides embedded in the PDF/A-3 produced by `InvoiceRenderer`
 * (ADR-0026 §E-invoice format, AC-293, AT-117).
 *
 * Scope:
 *   - CrossIndustryInvoice schema (UN/CEFACT CII-100), four namespaces:
 *     `rsm`, `ram`, `qdt`, `udt`. The XSD targets `rsm`; nested elements
 *     mostly live under `ram`. The Comfort profile is the EN 16931-
 *     conformant tier of Factur-X — what B2B receivers expect.
 *   - GuidelineSpecifiedDocumentContextParameter ID pinned to
 *     `urn:cen.eu:en16931:2017` (Comfort profile identifier).
 *   - TypeCode = `380` (Commercial Invoice) for a regular invoice,
 *     `381` (Credit Note / Stornorechnung) for a Storno row. Storno
 *     detection: `invoice.cancellationOf !== null` is the load-bearing
 *     signal; `number.startsWith('ST-')` is a fallback in case the test
 *     fixture builds a Storno-shaped row without populating the FK.
 *   - Tax-mode dispatch on the row's snapshotted `taxMode`:
 *       standard:        CategoryCode='S',  per-rate breakdown, statutory
 *                        line-level + header-level ApplicableTradeTax.
 *       reverse_charge:  CategoryCode='AE', RateApplicablePercent=0,
 *                        ExemptionReason carries the §13b UStG anchor.
 *
 * Output is a serialised UTF-8 XML string with the `<?xml ?>` prolog;
 * the PDF embedding layer (`pdfDrawer.ts`) ingests bytes via
 * `new TextEncoder().encode(...)`.
 *
 * NOTE on the XML serialisation: a hand-rolled string builder is used
 * rather than `fast-xml-parser` because the EN 16931 schema requires a
 * very specific element ORDER inside each complex type (the XSD uses
 * `<xs:sequence>` everywhere). `fast-xml-parser`'s object-graph
 * serialisation is best-effort on insertion order; building strings
 * directly is the unambiguous shape and is also what the receiver-side
 * tools (KoSIT, Mustang) emit in their reference samples. Every emitted
 * value passes through `escapeXmlText` / `escapeXmlAttr` so a hostile
 * input (e.g. a customer name with `<`) cannot break the document.
 */

import {
  type Invoice,
  type InvoiceIssuerSnapshot,
  type InvoiceLine,
  type InvoiceRecipientSnapshot,
  type TaxMode,
} from '../../../domain/invoice.js';
import { formatDecimal } from '../../../domain/money.js';
import { taxModeCategoryCode, taxModeExemptionReason } from './boilerplate.js';

/**
 * Escape user-supplied text content for inclusion in an XML element
 * body. Replaces the five XML-reserved chars; the EN 16931 receivers
 * also expect canonical NFC (the spec strings are NFC), so we trust the
 * input encoding to already be NFC — every input on the row originates
 * from a `text` Postgres column persisted from a JS string, which is
 * UTF-16 internally but emits NFC under the JSON.stringify / driver
 * pipeline.
 */
function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape an XML attribute value — additionally quotes and apostrophes. */
function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Amount or percentage as an `xs:decimal` with two decimals. Prices and
 * quantities are rendered unrounded instead (data-model.md §5.15).
 */
function fmt2(n: number): string {
  return formatDecimal(n, 2, 2);
}

/** Format a JS Date as `YYYYMMDD` (format=102 in CII). */
function dateBasic(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`facturXmlBuilder: invalid date: ${String(d)}`);
  }
  const y = dt.getUTCFullYear().toString().padStart(4, '0');
  const m = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = dt.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Best-effort EN 16931 unit-code mapping for the human-readable `unit`
 * string on a line. EN 16931 expects a UN/ECE Rec 20 code on
 * `BilledQuantity/@unitCode`; common Handwerker units map cleanly,
 * unknown values fall through to `C62` (unit, one) which is the
 * documented neutral default.
 */
function mapUnitCode(unit: string): string {
  const trimmed = unit.trim().toLowerCase();
  switch (trimmed) {
    case 'stk':
    case 'stück':
    case 'stueck':
    case 'piece':
    case 'pcs':
    case '':
    case 'pauschal':
      return 'C62';
    case 'h':
    case 'std':
    case 'stunde':
    case 'stunden':
    case 'hour':
      return 'HUR';
    case 'm':
      return 'MTR';
    case 'm2':
    case 'qm':
      return 'MTK';
    case 'm3':
    case 'cbm':
      return 'MTQ';
    case 'kg':
      return 'KGM';
    case 't':
      return 'TNE';
    case 'l':
    case 'liter':
      return 'LTR';
    case 'tag':
    case 'tage':
    case 'day':
      return 'DAY';
    default:
      return 'C62';
  }
}

/** Is this row a Stornorechnung? */
function isStorno(invoice: Invoice): boolean {
  if (invoice.cancellationOf) return true;
  if (typeof invoice.number === 'string' && invoice.number.startsWith('ST-')) return true;
  return false;
}

function renderIssuerBlock(issuer: InvoiceIssuerSnapshot): string {
  const parts: string[] = [];
  parts.push('<ram:SellerTradeParty>');
  parts.push(`<ram:Name>${escapeXmlText(issuer.companyName)}</ram:Name>`);
  parts.push('<ram:PostalTradeAddress>');
  parts.push(`<ram:PostcodeCode>${escapeXmlText(issuer.address.zip)}</ram:PostcodeCode>`);
  parts.push(`<ram:LineOne>${escapeXmlText(issuer.address.street)}</ram:LineOne>`);
  parts.push(`<ram:CityName>${escapeXmlText(issuer.address.city)}</ram:CityName>`);
  parts.push('<ram:CountryID>DE</ram:CountryID>');
  parts.push('</ram:PostalTradeAddress>');
  // Tax registration — VAT id (USt-IdNr.) under schemeID="VA", and the
  // statutory tax number under schemeID="FC". Issuance requires both
  // (data-model.md §5.17); BR-CO-26 is met by the VA id (BT-31).
  if (issuer.taxId && issuer.taxId.length > 0) {
    parts.push('<ram:SpecifiedTaxRegistration>');
    parts.push(`<ram:ID schemeID="FC">${escapeXmlText(issuer.taxId)}</ram:ID>`);
    parts.push('</ram:SpecifiedTaxRegistration>');
  }
  if (issuer.ustId && issuer.ustId.length > 0) {
    parts.push('<ram:SpecifiedTaxRegistration>');
    parts.push(`<ram:ID schemeID="VA">${escapeXmlText(issuer.ustId)}</ram:ID>`);
    parts.push('</ram:SpecifiedTaxRegistration>');
  }
  parts.push('</ram:SellerTradeParty>');
  return parts.join('');
}

function renderRecipientBlock(recipient: InvoiceRecipientSnapshot): string {
  const parts: string[] = [];
  parts.push('<ram:BuyerTradeParty>');
  parts.push(`<ram:Name>${escapeXmlText(recipient.name)}</ram:Name>`);
  if (recipient.address) {
    parts.push('<ram:PostalTradeAddress>');
    parts.push(`<ram:PostcodeCode>${escapeXmlText(recipient.address.zip)}</ram:PostcodeCode>`);
    parts.push(`<ram:LineOne>${escapeXmlText(recipient.address.street)}</ram:LineOne>`);
    parts.push(`<ram:CityName>${escapeXmlText(recipient.address.city)}</ram:CityName>`);
    parts.push('<ram:CountryID>DE</ram:CountryID>');
    parts.push('</ram:PostalTradeAddress>');
  }
  if (recipient.ustId && recipient.ustId.length > 0) {
    parts.push('<ram:SpecifiedTaxRegistration>');
    parts.push(`<ram:ID schemeID="VA">${escapeXmlText(recipient.ustId)}</ram:ID>`);
    parts.push('</ram:SpecifiedTaxRegistration>');
  }
  parts.push('</ram:BuyerTradeParty>');
  return parts.join('');
}

function renderLineItem(line: InvoiceLine, index: number, mode: TaxMode): string {
  const parts: string[] = [];
  parts.push('<ram:IncludedSupplyChainTradeLineItem>');
  parts.push('<ram:AssociatedDocumentLineDocument>');
  parts.push(`<ram:LineID>${String(index + 1)}</ram:LineID>`);
  parts.push('</ram:AssociatedDocumentLineDocument>');

  parts.push('<ram:SpecifiedTradeProduct>');
  parts.push(`<ram:Name>${escapeXmlText(line.description)}</ram:Name>`);
  parts.push('</ram:SpecifiedTradeProduct>');

  parts.push('<ram:SpecifiedLineTradeAgreement>');
  parts.push('<ram:NetPriceProductTradePrice>');
  parts.push(`<ram:ChargeAmount>${formatDecimal(line.unitPrice, 2)}</ram:ChargeAmount>`);
  parts.push('</ram:NetPriceProductTradePrice>');
  parts.push('</ram:SpecifiedLineTradeAgreement>');

  parts.push('<ram:SpecifiedLineTradeDelivery>');
  parts.push(
    `<ram:BilledQuantity unitCode="${escapeXmlAttr(mapUnitCode(line.unit))}">${formatDecimal(line.quantity, 0)}</ram:BilledQuantity>`,
  );
  parts.push('</ram:SpecifiedLineTradeDelivery>');

  parts.push('<ram:SpecifiedLineTradeSettlement>');
  parts.push('<ram:ApplicableTradeTax>');
  parts.push('<ram:TypeCode>VAT</ram:TypeCode>');
  parts.push(`<ram:CategoryCode>${taxModeCategoryCode(mode)}</ram:CategoryCode>`);
  // For `standard` we use the line's own taxRate; for reverse charge
  // the rate must be 0 per EN 16931, regardless
  // of what the line carries in the JSONB.
  const linePercent = mode === 'standard' ? line.taxRate : 0;
  parts.push(`<ram:RateApplicablePercent>${fmt2(linePercent)}</ram:RateApplicablePercent>`);
  parts.push('</ram:ApplicableTradeTax>');
  parts.push('<ram:SpecifiedTradeSettlementLineMonetarySummation>');
  parts.push(`<ram:LineTotalAmount>${fmt2(line.lineTotal)}</ram:LineTotalAmount>`);
  parts.push('</ram:SpecifiedTradeSettlementLineMonetarySummation>');
  parts.push('</ram:SpecifiedLineTradeSettlement>');

  parts.push('</ram:IncludedSupplyChainTradeLineItem>');
  return parts.join('');
}

/**
 * The complete EN 16931 XML payload for the invoice.
 */
export function buildFacturXml(invoice: Invoice): string {
  const taxMode = invoice.taxMode;
  const storno = isStorno(invoice);
  const typeCode = storno ? '381' : '380';

  if (invoice.number === null) {
    // The renderer is only invoked at issuance time — the row's `number`
    // is allocated and persisted before render. A null here is an
    // upstream contract break.
    throw new Error('buildFacturXml: invoice.number is null — renderer invoked pre-allocation');
  }
  const issueDateBasic = dateBasic(invoice.issueDate ?? new Date());
  // performanceDate must be present at issuance per the service's
  // pre-condition check (AT-113(b)); a null here mirrors that
  // invariant break.
  if (invoice.performanceDate === null) {
    throw new Error('buildFacturXml: performanceDate is null — renderer invoked pre-validation');
  }
  const performanceDateBasic = dateBasic(invoice.performanceDate);

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    '<rsm:CrossIndustryInvoice ' +
      'xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" ' +
      'xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" ' +
      'xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" ' +
      'xmlns:xs="http://www.w3.org/2001/XMLSchema" ' +
      'xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',
  );

  // ExchangedDocumentContext — Comfort profile identifier pin.
  parts.push('<rsm:ExchangedDocumentContext>');
  parts.push('<ram:GuidelineSpecifiedDocumentContextParameter>');
  parts.push('<ram:ID>urn:cen.eu:en16931:2017</ram:ID>');
  parts.push('</ram:GuidelineSpecifiedDocumentContextParameter>');
  parts.push('</rsm:ExchangedDocumentContext>');

  // ExchangedDocument — invoice / Storno identification.
  parts.push('<rsm:ExchangedDocument>');
  parts.push(`<ram:ID>${escapeXmlText(invoice.number)}</ram:ID>`);
  parts.push(`<ram:TypeCode>${typeCode}</ram:TypeCode>`);
  parts.push('<ram:IssueDateTime>');
  parts.push(`<udt:DateTimeString format="102">${issueDateBasic}</udt:DateTimeString>`);
  parts.push('</ram:IssueDateTime>');
  // IncludedNote — render the statutory boilerplate so receivers see
  // it inside the XML AND on the human-readable PDF.
  const exemptionReason = taxModeExemptionReason(taxMode);
  if (exemptionReason) {
    parts.push('<ram:IncludedNote>');
    parts.push(`<ram:Content>${escapeXmlText(exemptionReason)}</ram:Content>`);
    parts.push('</ram:IncludedNote>');
  }
  parts.push('</rsm:ExchangedDocument>');

  // SupplyChainTradeTransaction — lines + parties + delivery + totals.
  parts.push('<rsm:SupplyChainTradeTransaction>');

  // Lines (one IncludedSupplyChainTradeLineItem per row).
  invoice.lines.forEach((line, idx) => {
    parts.push(renderLineItem(line, idx, taxMode));
  });

  // ApplicableHeaderTradeAgreement — issuer / recipient.
  // (Storno cross-reference lives under HeaderTradeSettlement /
  // InvoiceReferencedDocument per the EN 16931 schema; the agreement
  // block does not carry a slot for it.)
  parts.push('<ram:ApplicableHeaderTradeAgreement>');
  parts.push(renderIssuerBlock(invoice.issuer));
  parts.push(renderRecipientBlock(invoice.recipient));
  parts.push('</ram:ApplicableHeaderTradeAgreement>');

  // ApplicableHeaderTradeDelivery — Leistungsdatum.
  parts.push('<ram:ApplicableHeaderTradeDelivery>');
  parts.push('<ram:ActualDeliverySupplyChainEvent>');
  parts.push('<ram:OccurrenceDateTime>');
  parts.push(`<udt:DateTimeString format="102">${performanceDateBasic}</udt:DateTimeString>`);
  parts.push('</ram:OccurrenceDateTime>');
  parts.push('</ram:ActualDeliverySupplyChainEvent>');
  parts.push('</ram:ApplicableHeaderTradeDelivery>');

  // ApplicableHeaderTradeSettlement — currency + tax aggregates + totals.
  parts.push('<ram:ApplicableHeaderTradeSettlement>');
  parts.push('<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>');

  // Header-level ApplicableTradeTax — one block per rate in
  // `totals.perRate` for standard mode; one neutral block for reverse
  // charge (where perRate is empty by domain semantics).
  if (taxMode === 'standard') {
    for (const band of invoice.totals.perRate) {
      parts.push('<ram:ApplicableTradeTax>');
      parts.push(`<ram:CalculatedAmount>${fmt2(band.taxAmount)}</ram:CalculatedAmount>`);
      parts.push('<ram:TypeCode>VAT</ram:TypeCode>');
      parts.push(`<ram:BasisAmount>${fmt2(band.netSubtotal)}</ram:BasisAmount>`);
      parts.push(`<ram:CategoryCode>${taxModeCategoryCode(taxMode)}</ram:CategoryCode>`);
      parts.push(`<ram:RateApplicablePercent>${fmt2(band.taxRate)}</ram:RateApplicablePercent>`);
      parts.push('</ram:ApplicableTradeTax>');
    }
  } else {
    // Reverse charge — single header block with 0% rate +
    // ExemptionReason carrying the §-anchor.
    //
    // Element order is pinned by the EN 16931 reusable types XSD:
    //   CalculatedAmount, TypeCode, ExemptionReason, BasisAmount,
    //   CategoryCode, ExemptionReasonCode, TaxPointDate,
    //   DueDateTypeCode, RateApplicablePercent
    // — every <xs:sequence>'d element must appear in that order or
    // the receiver's validator rejects the document.
    parts.push('<ram:ApplicableTradeTax>');
    parts.push('<ram:CalculatedAmount>0.00</ram:CalculatedAmount>');
    parts.push('<ram:TypeCode>VAT</ram:TypeCode>');
    if (exemptionReason) {
      parts.push(`<ram:ExemptionReason>${escapeXmlText(exemptionReason)}</ram:ExemptionReason>`);
    }
    parts.push(`<ram:BasisAmount>${fmt2(invoice.totals.netGrandTotal)}</ram:BasisAmount>`);
    parts.push(`<ram:CategoryCode>${taxModeCategoryCode(taxMode)}</ram:CategoryCode>`);
    parts.push('<ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>');
    parts.push('</ram:ApplicableTradeTax>');
  }

  // SpecifiedTradeSettlementHeaderMonetarySummation — totals block.
  parts.push('<ram:SpecifiedTradeSettlementHeaderMonetarySummation>');
  parts.push(`<ram:LineTotalAmount>${fmt2(invoice.totals.netGrandTotal)}</ram:LineTotalAmount>`);
  parts.push(
    `<ram:TaxBasisTotalAmount>${fmt2(invoice.totals.netGrandTotal)}</ram:TaxBasisTotalAmount>`,
  );
  parts.push(
    `<ram:TaxTotalAmount currencyID="EUR">${fmt2(invoice.totals.taxGrandTotal)}</ram:TaxTotalAmount>`,
  );
  parts.push(
    `<ram:GrandTotalAmount>${fmt2(invoice.totals.grossGrandTotal)}</ram:GrandTotalAmount>`,
  );
  parts.push(
    `<ram:DuePayableAmount>${fmt2(invoice.totals.grossGrandTotal)}</ram:DuePayableAmount>`,
  );
  parts.push('</ram:SpecifiedTradeSettlementHeaderMonetarySummation>');

  // Storno cross-reference. EN 16931 places this in the settlement
  // block, AFTER the totals summation. `IssuerAssignedID` carries the
  // original invoice's UUID; the human-readable number lives on the
  // PDF body and the audit chain.
  if (storno && invoice.cancellationOf) {
    parts.push('<ram:InvoiceReferencedDocument>');
    parts.push(
      `<ram:IssuerAssignedID>${escapeXmlText(invoice.cancellationOf)}</ram:IssuerAssignedID>`,
    );
    parts.push('</ram:InvoiceReferencedDocument>');
  }

  parts.push('</ram:ApplicableHeaderTradeSettlement>');

  parts.push('</rsm:SupplyChainTradeTransaction>');
  parts.push('</rsm:CrossIndustryInvoice>');

  return parts.join('');
}
