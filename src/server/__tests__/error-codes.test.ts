/**
 * AC-354 — the error-code catalogue's runtime definition.
 *
 * `ERROR_CODES` is the single form of the set: `ErrorCode` is derived
 * from it (the compiler's job), and api.md §14.4.1's
 * `CHECKED:error-codes` block publishes it (pinned here, in both drift
 * directions — a code the array gained and a code the block invented are
 * the same equality failure). Why checked rather than generated:
 * ARCHITECTURE.md § Error-Code Catalogue.
 *
 * The rest is what neither the compiler nor the doc check can see. A
 * duplicate entry: `(typeof ERROR_CODES)[number]` deduplicates as a
 * union, so a code pasted twice type-checks perfectly and publishes
 * twice. And an entry *no factory mints*: the compiler proves every
 * `AppError` carries a catalogued code, never the converse, so the
 * catalogue can promise a response the module cannot construct.
 *
 * Note the exact claim there: a *factory exists*, not that a request can
 * reach it. Reachability is a route test's job.
 */

import { describe, it, expect } from 'vitest';
import * as errors from '../errors.js';
import { AppError, ERROR_CODES, type ErrorCode } from '../errors.js';
import { readCheckedBlock } from '../../test/checkedBlock.js';

/**
 * Every factory, with arguments good enough to call it. Hand-maintained
 * on purpose — the arities differ and a reflective caller would have to
 * guess payload shapes. A new code whose factory is missing here fails
 * `every catalogued code is minted by a factory` below.
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

describe('AC-354: error-code catalogue', () => {
  it('api.md §14.4.1 publishes exactly ERROR_CODES', () => {
    // Throws on lost markers rather than returning an empty block.
    const block = readCheckedBlock('docs/spec/api.md', 'error-codes');
    const published = [...block.matchAll(/`([A-Z_]+)`/g)].map(([, code]) => code);
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
