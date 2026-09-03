/**
 * AC-354 — the error-code catalogue's runtime definition.
 *
 * `ERROR_CODES` is the single form of the set: `ErrorCode` is derived
 * from it, and api.md §14.4.1's `CHECKED:error-codes` block publishes
 * it. The derivation is the compiler's job; the publication is pinned
 * here (`publishes exactly ERROR_CODES`), because the block is a
 * transcription of the array and a transcription is not worth a
 * generator — ARCHITECTURE.md § Error-Code Catalogue owns that call.
 *
 * Beyond those two, what is left to test is what neither the compiler
 * nor the doc check can see.
 *
 * Two such gaps. A duplicate entry: `(typeof ERROR_CODES)[number]`
 * deduplicates as a union, so a code pasted twice type-checks perfectly
 * and publishes twice. And an entry *no factory mints*: the compiler
 * proves every `AppError` carries a catalogued code, but nothing proves
 * the converse — a code the catalogue publishes and the module cannot
 * construct promises clients a response they will never receive. It had
 * already drifted that way: `INVOICE_NUMBER_FORMAT` was catalogued in
 * §14.4.1 and in the array with no factory anywhere, and was deleted
 * rather than given one — the only application-side check that could
 * have raised it duplicated the `invoices_number_format` DB CHECK
 * against inputs that cannot fail it.
 *
 * Note the exact claim: this pins that a *factory exists*, not that a
 * request can reach it. A factory whose call site is unreachable passes
 * here — which is how the deleted code passed before review caught it.
 * Reachability is a route test's job.
 *
 * Both directions of the doc drift are covered by one assertion: a code
 * the array gained and the block did not, and a code the block carries
 * that the array does not, are the same equality failure.
 *
 * `methodNotAllowed()` gets its own block: it is the code the catalogue
 * was missing, and the four route sites now route through it, so this
 * pins the shape they emit — `Allow` included. Why the header rides on
 * the error rather than sitting beside it: ARCHITECTURE.md § Error-Code
 * Catalogue.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as errors from '../errors.js';
import { AppError, ERROR_CODES, methodNotAllowed, type ErrorCode } from '../errors.js';
import { STRINGS } from '../../config/strings.js';

const API_DOC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/spec/api.md');
const CHECKED_BLOCK =
  /<!-- CHECKED:error-codes:START[\s\S]*?-->([\s\S]*?)<!-- CHECKED:error-codes:END -->/;

/**
 * Every factory, with arguments good enough to call it. Hand-maintained
 * on purpose — the arities differ and a reflective caller would have to
 * guess payload shapes — but not hand-*trusted*: `covers every exported
 * factory` below fails on an entry that is missing from this table, so
 * the table cannot silently fall behind the module.
 */
const FACTORY_CALLS: [name: string, invoke: () => AppError][] = [
  ['invalidCredentials', () => errors.invalidCredentials()],
  ['unauthenticated', () => errors.unauthenticated()],
  ['sessionExpired', () => errors.sessionExpired()],
  ['notPermitted', () => errors.notPermitted()],
  ['validationError', () => errors.validationError('any')],
  ['conflict', () => errors.conflict('any')],
  ['idempotencyConflict', () => errors.idempotencyConflict()],
  ['schemaVersionMismatch', () => errors.schemaVersionMismatch(1, 2)],
  ['targetNotEmpty', () => errors.targetNotEmpty()],
  ['restoreConfirmationMismatch', () => errors.restoreConfirmationMismatch()],
  ['missingUserRefs', () => errors.missingUserRefs({ missingUserIds: [], references: [] })],
  ['exportJobActive', () => errors.exportJobActive('job-id')],
  ['importJobActive', () => errors.importJobActive('job-id')],
  ['exportJobNotReady', () => errors.exportJobNotReady()],
  ['uploadHeaderInvalid', () => errors.uploadHeaderInvalid('Upload-Length')],
  ['uploadOffsetConflict', () => errors.uploadOffsetConflict()],
  ['uploadTooLarge', () => errors.uploadTooLarge()],
  ['uploadNotAccepted', () => errors.uploadNotAccepted()],
  ['notFound', () => errors.notFound()],
  ['routeNotFound', () => errors.routeNotFound()],
  ['methodNotAllowed', () => errors.methodNotAllowed(['GET'])],
  ['gone', () => errors.gone('any')],
  ['rateLimited', () => errors.rateLimited()],
  ['serverError', () => errors.serverError()],
  ['bulkLimitExceeded', () => errors.bulkLimitExceeded({ limits: { maxFiles: 1, maxBytes: 1 } })],
  ['dekUnwrapFailed', () => errors.dekUnwrapFailed()],
  ['invoiceFrozen', () => errors.invoiceFrozen()],
  ['invoiceProjectState', () => errors.invoiceProjectState()],
  ['invoiceNotIssued', () => errors.invoiceNotIssued()],
  ['invoiceAlreadyCancelled', () => errors.invoiceAlreadyCancelled()],
  ['companyProfileRequired', () => errors.companyProfileRequired({ missingFields: [] })],
  ['customerHasInvoices', () => errors.customerHasInvoices({ invoiceCount: 1 })],
  ['projectHasInvoices', () => errors.projectHasInvoices({ invoiceCount: 1 })],
  ['draftNotExportable', () => errors.draftNotExportable({ invoiceId: 'invoice-id' })],
  ['exportTooLarge', () => errors.exportTooLarge({ total: 2, cap: 1 })],
];

/**
 * Exported functions that are deliberately not factories. Declared
 * rather than pattern-matched so adding one is a decision that shows up
 * in review instead of a name that happens to miss a heuristic.
 */
const NON_FACTORY_EXPORTS = new Set([
  'AppError', // the class itself
  'extractPgConstraint', // error-chain readers, return string | null
  'extractSqlState',
  'mapFastify4xx', // re-wraps a FastifyError; mints no code of its own
]);

describe('AC-354: error-code catalogue', () => {
  it('api.md §14.4.1 publishes exactly ERROR_CODES', () => {
    const block = CHECKED_BLOCK.exec(readFileSync(API_DOC, 'utf8'))?.[1];
    // A lost marker must fail rather than skip: the equality below would
    // otherwise pass vacuously on a document that no longer carries the
    // block at all.
    expect(block, 'CHECKED:error-codes markers not found in docs/spec/api.md').toBeDefined();

    const published = [...(block ?? '').matchAll(/`([A-Z_]+)`/g)].map(([, code]) => code);
    // Order included — declaration order is publication order, and a
    // sorted catalogue loses the domain grouping that is its only
    // structure. One equality covers both drift directions: a code the
    // array gained and a code the document invented fail the same way.
    expect(published).toEqual([...ERROR_CODES]);
  });

  it('declares each code exactly once', () => {
    // Not a tautology over a literal array: the union derived from it
    // collapses duplicates, so this is the only place a repeated entry
    // is observable before it reaches the published catalogue.
    const seen = new Set(ERROR_CODES);
    expect(seen.size).toBe(ERROR_CODES.length);
  });

  it('covers every exported factory', () => {
    const tabled = new Set(FACTORY_CALLS.map(([name]) => name));
    const untabled = Object.entries(errors)
      .filter(([name, value]) => typeof value === 'function' && !NON_FACTORY_EXPORTS.has(name))
      .map(([name]) => name)
      .filter((name) => !tabled.has(name));

    // A new factory added to errors.ts without a table entry lands here,
    // which is what keeps the membership assertions below honest.
    expect(untabled).toEqual([]);
  });

  it('every catalogued code is minted by a factory', () => {
    const minted = new Set<ErrorCode>(FACTORY_CALLS.map(([, invoke]) => invoke().code));
    const unminted = ERROR_CODES.filter((code) => !minted.has(code));

    // The direction the compiler cannot see. A code here is published in
    // api.md §14.4.1 as part of the API contract while the module has no
    // way to construct it — the catalogue over-promising rather than
    // drifting. Existence of a factory only; whether a request can reach
    // that factory is a route test's question.
    expect(unminted).toEqual([]);
  });
});

describe('AC-354: methodNotAllowed()', () => {
  it('carries the catalogued code, 405, and the German user message', () => {
    const err = methodNotAllowed(['GET']);

    expect(err.code).toBe('METHOD_NOT_ALLOWED');
    expect(ERROR_CODES).toContain(err.code);
    expect(err.statusCode).toBe(405);
    // Pinned to STRINGS, not to the text, so a wording change stays a
    // one-line edit — and so a regression to a hand-rolled English
    // literal fails here rather than shipping.
    expect(err.userMessage).toBe(STRINGS.errors.methodNotAllowed);
    expect(err.toResponse()).toEqual({
      code: 'METHOD_NOT_ALLOWED',
      message: STRINGS.errors.methodNotAllowed,
    });
  });

  it('carries Allow, so a guard cannot ship the status without the header', () => {
    // Taking the verbs as a *required* argument is the whole mechanism:
    // it is what makes status and header inseparable. Pinned here so a
    // signature change that reintroduces an optional header fails.
    expect(methodNotAllowed(['GET']).headers).toEqual({ allow: 'GET' });
    expect(methodNotAllowed(['GET', 'PUT']).headers).toEqual({ allow: 'GET, PUT' });
  });
});
