/**
 * API integration tests: Audit list filter `entityLabelQuery`.
 *
 * Covers the substring filter on `audit_log.entity_label` exposed at
 * `GET /api/audit` (verification.md §15.23, ui/management.md §8.13). The filter
 * replaces the UUID `entityId` input in the Aktivität view — the API still
 * accepts `entityId` for the project-detail contextual feed, but the
 * filter-bar surface is now substring-based.
 *
 * The suite is file-local rather than appended to `audit-log.test.ts`
 * because that file pins AC/AT markers per describe block; this is a
 * filter-behavior suite that does not correspond to a single AT.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

interface AuditApiEntry {
  id: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  action: string;
}

describe('Audit list filter: entityLabelQuery', () => {
  let ownerToken: string;
  let seededCustomerId: string;
  // Distinctive substring embedded in fixture labels — unique enough
  // to not collide with seed data. Base36 timestamp suffix gives a
  // fresh marker per test run.
  const MARKER = `elqtest${Date.now().toString(36)}`;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    const custList = await authGet(ownerToken, '/api/customers?limit=1');
    const customers = custList.json().customers as { id: string }[];
    if (!customers || customers.length === 0) {
      throw new Error('entityLabelQuery fixtures: seed produced no customers');
    }
    seededCustomerId = customers[0]!.id;

    // Fixture project whose title carries a LIKE-metachar (`_`) next to
    // the marker. The escape test queries with the underscore verbatim
    // and asserts only this row matches — if the repo skipped the
    // escape, the `_` would act as a one-char wildcard and the query
    // would also match the control title that has no underscore.
    const projectRes = await authPost(ownerToken, '/api/projects', {
      number: `ELQ-${Date.now().toString(36)}`,
      title: `Projekt ${MARKER}_alpha`,
      customerId: seededCustomerId,
    });
    expect(projectRes.statusCode).toBe(201);

    // Control row without the underscore. Same marker prefix — so a
    // naive LIKE match on `${MARKER}_alpha` (with `_` unescaped) would
    // also match this title via the one-char wildcard.
    const controlRes = await authPost(ownerToken, '/api/projects', {
      number: `ELQ-${Date.now().toString(36)}-C`,
      title: `Projekt ${MARKER}xalpha`,
      customerId: seededCustomerId,
    });
    expect(controlRes.statusCode).toBe(201);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('returns rows whose entity_label contains the substring (case-insensitive)', async () => {
    const res = await authGet(
      ownerToken,
      `/api/audit?limit=100&entityLabelQuery=${encodeURIComponent(MARKER.toUpperCase())}`,
    );
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as AuditApiEntry[];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(entry.entityLabel?.toLowerCase()).toContain(MARKER);
    }
  });

  it('escapes LIKE metacharacters so `_` is matched literally, not as a wildcard', async () => {
    const res = await authGet(
      ownerToken,
      `/api/audit?limit=100&entityLabelQuery=${encodeURIComponent(`${MARKER}_alpha`)}`,
    );
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as AuditApiEntry[];
    // Exactly one fixture label matches literally (`..._alpha`). The
    // control fixture (`...xalpha`) must NOT appear — if it does, the
    // `_` was treated as a LIKE wildcard, i.e. the escape is broken.
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries) {
      expect(entry.entityLabel).toContain(`${MARKER}_alpha`);
      expect(entry.entityLabel).not.toContain(`${MARKER}xalpha`);
    }
  });

  it('excludes rows with a null entity_label (filter-by-label cannot match NULL)', async () => {
    // Every row the fixture produces carries a label, so a query for
    // the marker returns only labeled rows. The assertion is the
    // invariant: no returned row has `entityLabel: null`. If a future
    // write path landed with a NULL label and this filter silently
    // matched it, that would be a bug.
    const res = await authGet(
      ownerToken,
      `/api/audit?limit=100&entityLabelQuery=${encodeURIComponent(MARKER)}`,
    );
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as AuditApiEntry[];
    for (const entry of entries) {
      expect(entry.entityLabel).not.toBeNull();
    }
  });

  it('rejects queries shorter than 3 characters (below trigram-index minimum)', async () => {
    // The error handler maps JSON-schema validation failures to 422 for
    // consistency with application-level validation errors (e.g. the
    // inverted date-range check in this same route).
    const res = await authGet(ownerToken, '/api/audit?entityLabelQuery=ab');
    expect(res.statusCode).toBe(422);
  });

  it('accepts the minimum-length query (exactly 3 characters)', async () => {
    const res = await authGet(
      ownerToken,
      `/api/audit?limit=10&entityLabelQuery=${encodeURIComponent(MARKER.slice(0, 3))}`,
    );
    expect(res.statusCode).toBe(200);
  });
});
