/**
 * AC-354 — the error-code catalogue's runtime definition.
 *
 * `ERROR_CODES` is the single form of the set: `ErrorCode` is derived
 * from it, and `scripts/generate-error-codes.ts` publishes it into
 * api.md §14.4.1. Both of those are structural — the type derivation is
 * enforced by the compiler, the publication by the drift check — so what
 * is left to test here is what neither can see.
 *
 * A duplicate entry is the one corruption the compiler is blind to:
 * `(typeof ERROR_CODES)[number]` deduplicates as a union, so a code
 * pasted twice type-checks perfectly and publishes twice.
 *
 * `methodNotAllowed()` is pinned because it is the code the catalogue
 * was missing: four route sites answered `405 METHOD_NOT_ALLOWED` with a
 * hand-rolled object literal, outside `AppError` and outside the type,
 * while api.md §14.2 required the response in six places. Routing those
 * sites through a factory is what puts the code under the compiler; this
 * pins the shape they now emit.
 */

import { describe, it, expect } from 'vitest';
import { ERROR_CODES, methodNotAllowed } from '../errors.js';
import { STRINGS } from '../../config/strings.js';

describe('AC-354: error-code catalogue', () => {
  it('declares each code exactly once', () => {
    // Not a tautology over a literal array: the union derived from it
    // collapses duplicates, so this is the only place a repeated entry
    // is observable before it reaches the published catalogue.
    const seen = new Set(ERROR_CODES);
    expect(seen.size).toBe(ERROR_CODES.length);
  });
});

describe('AC-354: methodNotAllowed()', () => {
  it('carries the catalogued code, 405, and the German user message', () => {
    const err = methodNotAllowed();

    expect(err.code).toBe('METHOD_NOT_ALLOWED');
    expect(ERROR_CODES).toContain(err.code);
    expect(err.statusCode).toBe(405);
    // The hand-rolled literals this factory replaces carried an English
    // message ('Only GET is allowed on this endpoint.') where §14.4 puts
    // a German one. Pinned to STRINGS rather than to the text so a
    // wording change stays a one-line edit.
    expect(err.userMessage).toBe(STRINGS.errors.methodNotAllowed);
    expect(err.toResponse()).toEqual({
      code: 'METHOD_NOT_ALLOWED',
      message: STRINGS.errors.methodNotAllowed,
    });
  });
});
