/**
 * Negative coverage for `validateFacturXml` — the existing
 * happy-path arms in `invoice-renderer-shape.test.ts` and
 * `invoices-issue.test.ts` only assert `not.toThrow()`, which would
 * silently pass even if the validator were stubbed out. A renderer
 * regression that produced a structurally-broken `factur-x.xml` would
 * land on the binary without anyone noticing.
 *
 * This file pins the rejection contract — one assertion per failure
 * mode straight from the EN 16931 Comfort XSD bundle wired into
 * `xsdValidator.ts`:
 *
 *   - Missing required element  (drop `<ram:ID>` from `ExchangedDocument`)
 *   - Wrong root namespace      (rename `rsm:CrossIndustryInvoice` to a
 *                                fictitious namespace URI)
 *   - Type violation            (put a non-numeric in `xs:decimal`)
 *
 * Plus one positive arm so a future refactor that broke schema-loading
 * (e.g., dropping the cached parse, breaking the import-path layout
 * that lets libxml2 resolve sibling XSDs) trips this file first rather
 * than skipping the validator silently.
 *
 * Pins AC-700 (an XML failing the XSD fails the issuance; the negative
 * coverage block) and AC-693 (the embedded XML conforms; positive sanity).
 */
import { describe, it, expect } from 'vitest';
import { validateFacturXml, FacturXValidationError } from '../services/invoice/xsdValidator.js';

/**
 * Minimal known-good `factur-x.xml` — shape matches what
 * `facturXmlBuilder.ts` emits for a single-line standard-mode invoice.
 * Kept inline (rather than calling the builder) so a future builder
 * refactor cannot mask a validator regression: the validator must
 * accept this exact byte sequence regardless of the renderer's state.
 */
const GOOD_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rsm:CrossIndustryInvoice ',
  'xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" ',
  'xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" ',
  'xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" ',
  'xmlns:xs="http://www.w3.org/2001/XMLSchema" ',
  'xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',
  '<rsm:ExchangedDocumentContext>',
  '<ram:GuidelineSpecifiedDocumentContextParameter>',
  '<ram:ID>urn:cen.eu:en16931:2017</ram:ID>',
  '</ram:GuidelineSpecifiedDocumentContextParameter>',
  '</rsm:ExchangedDocumentContext>',
  '<rsm:ExchangedDocument>',
  '<ram:ID>RE-2026-0001</ram:ID>',
  '<ram:TypeCode>380</ram:TypeCode>',
  '<ram:IssueDateTime>',
  '<udt:DateTimeString format="102">20260512</udt:DateTimeString>',
  '</ram:IssueDateTime>',
  '</rsm:ExchangedDocument>',
  '<rsm:SupplyChainTradeTransaction>',
  '<ram:IncludedSupplyChainTradeLineItem>',
  '<ram:AssociatedDocumentLineDocument>',
  '<ram:LineID>1</ram:LineID>',
  '</ram:AssociatedDocumentLineDocument>',
  '<ram:SpecifiedTradeProduct>',
  '<ram:Name>Anstrich Fassade</ram:Name>',
  '</ram:SpecifiedTradeProduct>',
  '<ram:SpecifiedLineTradeAgreement>',
  '<ram:NetPriceProductTradePrice>',
  '<ram:ChargeAmount>1500.00</ram:ChargeAmount>',
  '</ram:NetPriceProductTradePrice>',
  '</ram:SpecifiedLineTradeAgreement>',
  '<ram:SpecifiedLineTradeDelivery>',
  '<ram:BilledQuantity unitCode="C62">1.00</ram:BilledQuantity>',
  '</ram:SpecifiedLineTradeDelivery>',
  '<ram:SpecifiedLineTradeSettlement>',
  '<ram:ApplicableTradeTax>',
  '<ram:TypeCode>VAT</ram:TypeCode>',
  '<ram:CategoryCode>S</ram:CategoryCode>',
  '<ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>',
  '</ram:ApplicableTradeTax>',
  '<ram:SpecifiedTradeSettlementLineMonetarySummation>',
  '<ram:LineTotalAmount>1500.00</ram:LineTotalAmount>',
  '</ram:SpecifiedTradeSettlementLineMonetarySummation>',
  '</ram:SpecifiedLineTradeSettlement>',
  '</ram:IncludedSupplyChainTradeLineItem>',
  '<ram:ApplicableHeaderTradeAgreement>',
  '<ram:SellerTradeParty>',
  '<ram:Name>Test Maler GmbH</ram:Name>',
  '<ram:PostalTradeAddress>',
  '<ram:PostcodeCode>10115</ram:PostcodeCode>',
  '<ram:LineOne>Werkstr. 1</ram:LineOne>',
  '<ram:CityName>Berlin</ram:CityName>',
  '<ram:CountryID>DE</ram:CountryID>',
  '</ram:PostalTradeAddress>',
  '<ram:SpecifiedTaxRegistration>',
  '<ram:ID schemeID="VA">DE123456789</ram:ID>',
  '</ram:SpecifiedTaxRegistration>',
  '</ram:SellerTradeParty>',
  '<ram:BuyerTradeParty>',
  '<ram:Name>Buyer GmbH</ram:Name>',
  '<ram:PostalTradeAddress>',
  '<ram:PostcodeCode>20097</ram:PostcodeCode>',
  '<ram:LineOne>Recipient Str. 1</ram:LineOne>',
  '<ram:CityName>Hamburg</ram:CityName>',
  '<ram:CountryID>DE</ram:CountryID>',
  '</ram:PostalTradeAddress>',
  '</ram:BuyerTradeParty>',
  '</ram:ApplicableHeaderTradeAgreement>',
  '<ram:ApplicableHeaderTradeDelivery>',
  '<ram:ActualDeliverySupplyChainEvent>',
  '<ram:OccurrenceDateTime>',
  '<udt:DateTimeString format="102">20260410</udt:DateTimeString>',
  '</ram:OccurrenceDateTime>',
  '</ram:ActualDeliverySupplyChainEvent>',
  '</ram:ApplicableHeaderTradeDelivery>',
  '<ram:ApplicableHeaderTradeSettlement>',
  '<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>',
  '<ram:ApplicableTradeTax>',
  '<ram:CalculatedAmount>285.00</ram:CalculatedAmount>',
  '<ram:TypeCode>VAT</ram:TypeCode>',
  '<ram:BasisAmount>1500.00</ram:BasisAmount>',
  '<ram:CategoryCode>S</ram:CategoryCode>',
  '<ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>',
  '</ram:ApplicableTradeTax>',
  '<ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
  '<ram:LineTotalAmount>1500.00</ram:LineTotalAmount>',
  '<ram:TaxBasisTotalAmount>1500.00</ram:TaxBasisTotalAmount>',
  '<ram:TaxTotalAmount currencyID="EUR">285.00</ram:TaxTotalAmount>',
  '<ram:GrandTotalAmount>1785.00</ram:GrandTotalAmount>',
  '<ram:DuePayableAmount>1785.00</ram:DuePayableAmount>',
  '</ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
  '</ram:ApplicableHeaderTradeSettlement>',
  '</rsm:SupplyChainTradeTransaction>',
  '</rsm:CrossIndustryInvoice>',
].join('');

describe('validateFacturXml — positive sanity (AC-693)', () => {
  it('accepts a minimal known-good EN 16931 Comfort document', async () => {
    // If this arm regresses, the schema loader is broken (wrong path,
    // dropped sibling import, cache invariant violated) — the negative
    // arms below would still pass for the wrong reason.
    await expect(validateFacturXml(GOOD_XML)).resolves.toBeUndefined();
  });
});

describe('validateFacturXml — negative coverage (AC-700)', () => {
  it('rejects an XML missing a required child of <ram:SpecifiedTradeProduct>', async () => {
    // Drop `<ram:Name>` from the line's SpecifiedTradeProduct. The
    // element is mandatory under EN 16931 (BT-153 / "Item name"), so
    // the validator must surface a violation. Picked over dropping
    // `<ram:ID>` from ExchangedDocument because the EN 16931 minOccurs
    // on Name is unambiguous across the bundled schemas.
    const xml = GOOD_XML.replace('<ram:Name>Anstrich Fassade</ram:Name>', '');
    await expect(validateFacturXml(xml)).rejects.toThrow(FacturXValidationError);
  });

  it('rejects an XML whose root element uses a fake namespace', async () => {
    // Rename only the root element's namespace URI — descendants still
    // bind to the EN 16931 URIs via their own `xmlns:ram=` / `xmlns:udt=`
    // attributes, so the violation is specifically the missing global
    // element declaration for `{fake}CrossIndustryInvoice`.
    const xml = GOOD_XML.replace(
      'xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
      'xmlns:rsm="urn:fake:not-a-real-namespace:999"',
    );
    await expect(validateFacturXml(xml)).rejects.toThrow(FacturXValidationError);
  });

  it('rejects an XML carrying a non-numeric value in an xs:decimal field', async () => {
    // GrandTotalAmount is typed as `udt:AmountType` → `xs:decimal`
    // (see UnqualifiedDataType_100.xsd). A non-numeric string violates
    // the type and the validator must reject it. Pins type-level
    // checks, not just structural ones.
    const xml = GOOD_XML.replace(
      '<ram:GrandTotalAmount>1785.00</ram:GrandTotalAmount>',
      '<ram:GrandTotalAmount>not-a-decimal</ram:GrandTotalAmount>',
    );
    await expect(validateFacturXml(xml)).rejects.toThrow(FacturXValidationError);
  });

  it('FacturXValidationError carries the validator messages on .errors', async () => {
    // Pin the error shape — callers may surface the field to operators
    // (the issuance route logs it before rolling back). A regression
    // that collapsed `errors` into a plain `Error` would silently strip
    // the diagnostic surface.
    const xml = GOOD_XML.replace('<ram:Name>Anstrich Fassade</ram:Name>', '');
    try {
      await validateFacturXml(xml);
      expect.fail('expected validateFacturXml to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FacturXValidationError);
      const e = err as FacturXValidationError;
      expect(Array.isArray(e.errors)).toBe(true);
      expect(e.errors.length).toBeGreaterThan(0);
    }
  });
});
