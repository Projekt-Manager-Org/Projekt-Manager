/**
 * Server-side coverage for the import-token binary-leg fixup (issue #230).
 *
 * The Layer 1 import envelope expanded to include `users`. An override
 * commit TRUNCATEs `users`, which cascades through `sessions.user_id ON
 * DELETE CASCADE` and evaporates the operator's session mid-flow. The
 * binary leg of the takeout-zip restore (per-attachment init / PUT /
 * complete) then 401s because the session it relied on is gone.
 *
 * The fix: the text-leg response carries a short-lived bearer token
 * alongside `sessionInvalidated: true`. The binary-leg attachment
 * endpoints accept this token via `Authorization: Bearer <token>` as
 * an alternative to session-cookie auth. This file pins:
 *
 *   - Mint: the override commit returns a base64url string of the right
 *     shape (~43 chars from 32 random bytes).
 *   - Verify: an `init` call carrying the Bearer header succeeds even
 *     when the session cookie is dead.
 *   - Expiry: the same call past TTL (5 min) returns 401
 *     `IMPORT_TOKEN_INVALID`.
 *   - Revoke: explicit revoke takes effect immediately.
 *   - Scope (positive): the token is accepted on every binary-leg
 *     endpoint — the test walks init → upload → complete → DELETE
 *     under the same Bearer.
 *   - Multi-use within TTL: the same token admits a second init call
 *     (per AC-314 — TTL is the bound, not a use counter).
 *   - User deactivated mid-import: a token whose user is flipped to
 *     `active = false` mid-flight rejects on the next call with
 *     IMPORT_TOKEN_INVALID. This is the entire reason the bearer
 *     path does a DB roundtrip per call.
 *   - Scope (negative): on a non-binary-leg endpoint
 *     (`GET /api/users`), the response is byte-equivalent
 *     (status + code) whether the request carries no auth, a valid
 *     Bearer, or a bogus Bearer — the standard auth middleware does
 *     not consult `Authorization`.
 *   - Empty-target import: no token issued (session is still alive).
 *   - Dry-run: no token issued (read-only path).
 *   - Header trumps session: a request carrying both a stale cookie
 *     and a valid Bearer succeeds (the Bearer is the explicit signal).
 *
 * Expiry uses `vi.useFakeTimers()` to advance wall clock past the
 * five-minute TTL without sleeping. The store is reset between cases
 * via the `_resetImportTokenStoreForTests` seam so a leak from one test
 * cannot mask a regression in another.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { authGet, authPost, getApp, login, startApp, stopApp } from '../../test/api-helpers.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';
import {
  EXPECTED_RESTORE_PHRASE,
  SEED_DEFAULT_PASSWORD,
  SEED_USERS,
} from '../../test/seedAssumptions.js';
import { createDatabase, type Database } from '../db/connection.js';
import { seed } from '../seed.js';
import type pg from 'pg';
import {
  IMPORT_TOKEN_TTL_MS,
  _resetImportTokenStoreForTests,
} from '../services/importTokenStore.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';

const year = new Date().getFullYear();

/**
 * Seeded operator UUID — `inhaber` per `fixtures/seed-users.json`. The
 * import-token design assumes the operator's row round-trips through
 * the envelope, so the test fixture pins this id on the imported owner
 * to reproduce the real flow. Drift between this constant and the
 * fixture would silently turn the verify-positive cases into
 * IMPORT_TOKEN_INVALID without surfacing a meaningful failure.
 */
const SEEDED_INHABER_UUID = '11111111-1111-1111-1111-111111111111';

/**
 * Build a minimal but valid v3 envelope. We reuse the larger fixture
 * shape from `data-exchange-import-expanded.test.ts` for the override
 * mint path; the override is the only path that yields a token, so the
 * fixture must satisfy every required cross-ref.
 *
 * `ownerId` defaults to the seeded `inhaber` UUID so the envelope
 * round-trips the operator's row — that's the load-bearing scenario
 * the import-token design assumes (`feedback_orchestrator_pattern`
 * carried over from the spec): "After the TRUNCATE, that user-id
 * matches the imported user with the same id (the envelope round-
 * trips the operator's row); the token works on the new user's
 * behalf." A test that pinned a different id would mint a token whose
 * `userId` never resolves post-import, which would mask the real
 * verify path under IMPORT_TOKEN_INVALID (the load-bearing positive
 * coverage would silently break with no symptom).
 */
function buildOverrideEnvelope(ownerId = SEEDED_INHABER_UUID): Record<string, unknown> {
  const workerId = '22222222-2222-4222-8222-222222222222';
  const cpId = '33333333-3333-4333-8333-333333333333';
  const customerId = '44444444-4444-4444-8444-444444444444';
  const projectId = '55555555-5555-4555-8555-555555555555';

  return {
    schema_version: 3,
    exported_at: new Date().toISOString(),
    users: [
      {
        id: ownerId,
        username: 'imp-owner',
        displayName: 'Import Owner',
        passwordHash: '$2b$10$DummyHashForFixture000000000000000000000000000000aa',
        roles: ['owner'],
        email: 'imp-owner@example.de',
        active: true,
        themePreference: 'system',
        pushMuted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        lastLoginAt: null,
        createdBy: null,
        updatedBy: null,
      },
      {
        id: workerId,
        username: 'imp-worker',
        displayName: 'Import Worker',
        passwordHash: '$2b$10$DummyHashForFixture000000000000000000000000000000bb',
        roles: ['worker'],
        email: null,
        active: true,
        themePreference: 'light',
        pushMuted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: null,
        createdBy: null,
        updatedBy: null,
      },
    ],
    company_profile: [
      {
        id: cpId,
        companyName: 'Import Maler GmbH',
        address: { street: 'Importstr. 1', zip: '10115', city: 'Berlin' },
        taxId: '111/222/33333',
        ustId: 'DE123456789',
        iban: null,
        accentColor: null,
        footerText: null,
        logoBinaryDescriptorId: null,
        defaultTaxMode: 'standard',
        updatedAt: '2026-01-03T00:00:00.000Z',
        updatedBy: ownerId,
      },
    ],
    customers: [
      {
        id: customerId,
        name: 'Import Kunde',
        phone: null,
        email: null,
        address: { street: 'Kundenstr. 5', zip: '20095', city: 'Hamburg' },
        ustId: null,
        notes: null,
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        createdBy: ownerId,
        updatedBy: ownerId,
      },
    ],
    projects: [
      {
        id: projectId,
        number: `${year}-IMP-1`,
        title: 'Import Projekt',
        status: 'anfrage',
        statusChangedAt: '2026-01-10T00:00:00.000Z',
        customerId,
        siteAddress: null,
        plannedStart: null,
        plannedEnd: null,
        estimatedValue: null,
        notes: null,
        deleted: false,
        createdAt: '2026-01-10T00:00:00.000Z',
        updatedAt: '2026-01-10T00:00:00.000Z',
        createdBy: ownerId,
        updatedBy: ownerId,
      },
    ],
    project_workers: [{ projectId, userId: workerId }],
    invoices: [],
    invoice_sequence: [],
    confirmation_phrase: EXPECTED_RESTORE_PHRASE,
  };
}

/** Helper: POST `/api/projects/:id/attachments/init` with a Bearer token. */
async function injectInitWithBearer(
  projectId: string,
  token: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return getApp().inject({
    method: 'POST',
    url: `/api/projects/${projectId}/attachments/init`,
    headers: { authorization: `Bearer ${token}`, ...extraHeaders },
    payload: body,
  });
}

/**
 * Helper: POST `/api/projects/:id/attachments/:attId/complete` with a
 * Bearer token. Used to verify the complete route honours
 * `attachment:write` on the import-token capability set (AC-313).
 */
async function injectCompleteWithBearer(projectId: string, attId: string, token: string) {
  return getApp().inject({
    method: 'POST',
    url: `/api/projects/${projectId}/attachments/${attId}/complete`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Helper: DELETE `/api/projects/:id/attachments/:attId` with a Bearer
 * token. Used to verify the delete (soft-hide) route honours
 * `attachment:hide` on the import-token capability set (AC-313).
 */
async function injectDeleteWithBearer(projectId: string, attId: string, token: string) {
  return getApp().inject({
    method: 'DELETE',
    url: `/api/projects/${projectId}/attachments/${attId}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function storage() {
  const env = getEnv();
  return createStorageClient({
    endpoint: env.STORAGE_ENDPOINT!,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY!,
    secretKey: env.STORAGE_SECRET_KEY!,
  });
}

/** Helper: hit the seeded project's id. */
async function seededProjectId(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const projects = res.json().data as { id: string; number: string }[];
  const p = projects.find((r) => r.number === `${year}-007`);
  if (!p) throw new Error(`seed missing ${year}-007`);
  return p.id;
}

describe('Import-token (issue #230 fixup)', () => {
  let db: Database;
  let pool: pg.Pool;
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterEach(() => {
    // Reset the in-memory store so a token minted in one test cannot
    // leak into the next. Combined with `vi.useRealTimers()` to undo any
    // fake-timer state from the expiry test below.
    _resetImportTokenStoreForTests();
    vi.useRealTimers();
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await stopApp();
  });

  // -------------------------------------------------------------------
  // Mint shape. The override commit returns `importToken` as a base64url
  // string of the right length (32 random bytes = 43 chars).
  // -------------------------------------------------------------------
  describe('mint shape', () => {
    it('override commit returns importToken as a base64url string (~43 chars)', async () => {
      try {
        const res = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          sessionInvalidated: boolean;
          importToken: string;
        };
        expect(body.sessionInvalidated).toBe(true);
        expect(typeof body.importToken).toBe('string');
        // 32 random bytes, base64url-encoded (no padding) = 43 chars.
        expect(body.importToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // Verify (positive). An `init` call carrying the Bearer header
  // succeeds even though the session cookie that minted the token is
  // dead (cascaded out by the TRUNCATE).
  //
  // Strategy: the override commit returns a token bound to the operator
  // user id. The envelope happens to round-trip an `owner`-roled user
  // with the same id, so the freshly-inserted row is what the auth path
  // loads. The same user must have `attachment:write` (owner does), so
  // the call sails through `requirePermission` because the token carries
  // the matching permission set.
  // -------------------------------------------------------------------
  describe('verify — Bearer header carries the binary-leg call past the dead cookie', () => {
    it('init succeeds with Authorization: Bearer <importToken> and no session cookie', async () => {
      try {
        // Override: imports the envelope, wipes the operator's session.
        // The response carries the token; the imported envelope's owner
        // row carries the same id as the token's `userId`.
        const importRes = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(importRes.statusCode).toBe(200);
        const { importToken } = importRes.json() as { importToken: string };
        expect(importToken).toBeTruthy();

        // The imported envelope carries one project (`<YYYY>-IMP-1`).
        // We need its id for the init URL — and the envelope pinned it
        // to `55555555-…`, so use the fixture's value directly.
        const projectId = '55555555-5555-4555-8555-555555555555';

        const initRes = await injectInitWithBearer(
          projectId,
          importToken,
          binaryInitBody({ fileName: 'restored.pdf', sizeBytes: 100, label: 'sonstiges' }),
        );
        // 201 = init landed (post-create). Anything else means the
        // Bearer header path didn't authorise the request — the
        // load-bearing assertion of this whole module.
        expect(initRes.statusCode).toBe(201);
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // Expiry. Past TTL the token is gone from the store; the same
  // Bearer header rejects with 401 IMPORT_TOKEN_INVALID — the import
  // orchestrator can then distinguish a dead token from a real session
  // expiry.
  //
  // Implementation note: `vi.useFakeTimers()` stalls every other
  // `setTimeout` consumer (pg client pool, log serializer, …), which
  // deadlocks the inject path. We therefore use fake timers only to
  // drive the store's eviction synchronously, then drop back to real
  // timers BEFORE hitting the route. The route then looks up the now-
  // absent token under real timers and surfaces IMPORT_TOKEN_INVALID
  // — the load-bearing assertion of this case.
  // -------------------------------------------------------------------
  describe('expiry — token rejects with IMPORT_TOKEN_INVALID past TTL', () => {
    it('store evicts the token past TTL; init with the evicted token returns 401', async () => {
      try {
        const importRes = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(importRes.statusCode).toBe(200);
        const { importToken } = importRes.json() as { importToken: string };
        expect(importToken).toBeTruthy();

        // Verify the store accepts the token under real timers — sanity
        // baseline before we evict it.
        const { verifyImportToken } = await import('../services/importTokenStore.js');
        expect(verifyImportToken(importToken)).not.toBeNull();

        // Advance fake timers past TTL inside a synchronous window (no
        // `await` between `useFakeTimers` and `useRealTimers`); the
        // store's `Date.now()` reads the fake clock and the entry gets
        // evicted on the verify call. Then drop back so the route's
        // inject path is not held hostage to a stalled clock.
        vi.useFakeTimers({ now: Date.now() + IMPORT_TOKEN_TTL_MS + 1_000 });
        const recordAfterTtl = verifyImportToken(importToken);
        vi.useRealTimers();
        expect(recordAfterTtl).toBeNull();

        const projectId = '55555555-5555-4555-8555-555555555555';
        const res = await injectInitWithBearer(
          projectId,
          importToken,
          binaryInitBody({ fileName: 'expired.pdf', sizeBytes: 100, label: 'sonstiges' }),
        );
        expect(res.statusCode).toBe(401);
        expect(res.json().code).toBe('IMPORT_TOKEN_INVALID');
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // Revoke. Even before TTL elapses, an explicit revoke takes effect
  // immediately. There is no live revoke route today, so we exercise
  // the in-process API directly — what the future completion-signal
  // would call.
  // -------------------------------------------------------------------
  describe('revoke — explicit revoke rejects the token immediately', () => {
    it('init with a revoked token returns 401 IMPORT_TOKEN_INVALID', async () => {
      try {
        const importRes = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(importRes.statusCode).toBe(200);
        const { importToken } = importRes.json() as { importToken: string };
        expect(importToken).toBeTruthy();

        const { revokeImportToken } = await import('../services/importTokenStore.js');
        revokeImportToken(importToken);

        const projectId = '55555555-5555-4555-8555-555555555555';
        const res = await injectInitWithBearer(
          projectId,
          importToken,
          binaryInitBody({ fileName: 'revoked.pdf', sizeBytes: 100, label: 'sonstiges' }),
        );
        expect(res.statusCode).toBe(401);
        expect(res.json().code).toBe('IMPORT_TOKEN_INVALID');
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // Scope — non-binary-leg endpoints reject the Bearer header. The
  // standard auth middleware never looks at `Authorization`; a request
  // carrying only a Bearer (no cookie) gets the standard
  // `UNAUTHENTICATED` 401 instead of admission.
  // -------------------------------------------------------------------
  describe('scope — non-binary-leg endpoints ignore the Bearer header', () => {
    it('GET /api/users returns the SAME response with and without a valid Bearer (header not consulted)', async () => {
      try {
        const importRes = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(importRes.statusCode).toBe(200);
        const { importToken } = importRes.json() as { importToken: string };
        expect(importToken).toBeTruthy();

        // No auth at all — baseline 401.
        const noAuth = await getApp().inject({
          method: 'GET',
          url: '/api/users',
        });
        expect(noAuth.statusCode).toBe(401);
        const noAuthCode = noAuth.json().code as string;
        expect(['UNAUTHENTICATED', 'SESSION_EXPIRED']).toContain(noAuthCode);

        // Valid Bearer, no cookie — the load-bearing assertion: the
        // standard auth middleware does NOT consult the Authorization
        // header on `/api/users`, so the response is byte-equivalent
        // (status + code) to the no-auth case. A future regression
        // wiring `createAuthMiddlewareWithImportToken` to this route
        // would either admit the call (200) or surface
        // `IMPORT_TOKEN_INVALID`; the equality assertion catches both
        // drifts.
        const withValidBearer = await getApp().inject({
          method: 'GET',
          url: '/api/users',
          headers: { authorization: `Bearer ${importToken}` },
        });
        expect(withValidBearer.statusCode).toBe(noAuth.statusCode);
        expect(withValidBearer.json().code).toBe(noAuthCode);

        // Bogus Bearer — same expectation. If the route consulted the
        // header at all, this would surface IMPORT_TOKEN_INVALID.
        const withBogusBearer = await getApp().inject({
          method: 'GET',
          url: '/api/users',
          headers: { authorization: 'Bearer not-a-real-token-just-noise' },
        });
        expect(withBogusBearer.statusCode).toBe(noAuth.statusCode);
        expect(withBogusBearer.json().code).toBe(noAuthCode);
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // Bearer admits the FULL binary-leg trio — not just `init`. The file
  // header advertises coverage for init / complete / DELETE; this case
  // walks the full chain so a scope regression that drops
  // `attachment:write` or `attachment:hide` from
  // `IMPORT_TOKEN_PERMISSIONS` surfaces here, not in production.
  // -------------------------------------------------------------------
  describe('scope — Bearer admits init, complete, AND DELETE on the binary leg', () => {
    it('walks init → upload → complete → DELETE all under Bearer auth', async () => {
      try {
        const importRes = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(importRes.statusCode).toBe(200);
        const { importToken } = importRes.json() as { importToken: string };
        expect(importToken).toBeTruthy();

        const projectId = '55555555-5555-4555-8555-555555555555';

        // 1) init under Bearer
        const initRes = await injectInitWithBearer(
          projectId,
          importToken,
          binaryInitBody({
            fileName: 'restored.pdf',
            sizeBytes: 100,
            label: 'sonstiges',
            ciphertextSizeBytes: 116,
          }),
        );
        expect(initRes.statusCode).toBe(201);
        const initBody = initRes.json();
        const attId = initBody.attachment.id as string;
        const originalKey = initBody.attachment.originalKey as string;

        // 2) PUT the ciphertext directly via the storage helper. The
        //    presigned URL path is exercised under the standard auth
        //    flow elsewhere; here we want to land bytes against the
        //    declared `ciphertextSizeBytes` (116) so `complete` does
        //    not 409 on size mismatch.
        await storage().upload(originalKey, Buffer.alloc(116, 0xff), 'application/octet-stream');

        // 3) complete under Bearer — same token, second call
        const completeRes = await injectCompleteWithBearer(projectId, attId, importToken);
        expect(completeRes.statusCode).toBe(200);
        expect(completeRes.json().status).toBe('ready');

        // 4) DELETE under Bearer — same token, third call
        const deleteRes = await injectDeleteWithBearer(projectId, attId, importToken);
        // 204 is the documented soft-hide response.
        expect([200, 204]).toContain(deleteRes.statusCode);
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // Multi-use within TTL. A single import drives N init + N complete +
  // possibly DELETE-rollback calls under the same token (per AC-314
  // "multi-use within that window"). A regression turning the token
  // single-use would only surface on a full restore in production.
  // -------------------------------------------------------------------
  describe('multi-use within TTL', () => {
    it('accepts the same token on two init calls (no single-use ceiling)', async () => {
      try {
        const importRes = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(importRes.statusCode).toBe(200);
        const { importToken } = importRes.json() as { importToken: string };
        expect(importToken).toBeTruthy();

        const projectId = '55555555-5555-4555-8555-555555555555';

        const init1 = await injectInitWithBearer(
          projectId,
          importToken,
          binaryInitBody({ fileName: 'a.pdf', sizeBytes: 100, label: 'sonstiges' }),
        );
        expect(init1.statusCode).toBe(201);

        const init2 = await injectInitWithBearer(
          projectId,
          importToken,
          binaryInitBody({ fileName: 'b.pdf', sizeBytes: 200, label: 'sonstiges' }),
        );
        expect(init2.statusCode).toBe(201);
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // User deactivated mid-import — the freshness check on every bearer-
  // path call (per the `auth.ts` design comment: caching `users.active`
  // inside the token would let a deactivated user keep restoring for
  // the rest of the 5-min TTL). This is the entire reason the Bearer
  // path does a DB roundtrip per call. Untested before this commit.
  // -------------------------------------------------------------------
  describe('user deactivated mid-import — token rejects on next call', () => {
    it('returns 401 IMPORT_TOKEN_INVALID after the token-bearer user is deactivated', async () => {
      try {
        const importRes = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(importRes.statusCode).toBe(200);
        const { importToken } = importRes.json() as { importToken: string };
        expect(importToken).toBeTruthy();

        // Sanity: the token works pre-deactivation.
        const projectId = '55555555-5555-4555-8555-555555555555';
        const initOk = await injectInitWithBearer(
          projectId,
          importToken,
          binaryInitBody({ fileName: 'before.pdf', sizeBytes: 100, label: 'sonstiges' }),
        );
        expect(initOk.statusCode).toBe(201);

        // Deactivate the token's user (the imported owner) directly in
        // the DB — simulates an admin flipping the active flag while
        // an import is in flight. The fresh DB lookup on the next
        // bearer call must surface IMPORT_TOKEN_INVALID rather than
        // admit the request against a stale cached user row.
        await db.execute(sql`UPDATE users SET active = false WHERE id = ${SEEDED_INHABER_UUID}`);

        const initRejected = await injectInitWithBearer(
          projectId,
          importToken,
          binaryInitBody({ fileName: 'after.pdf', sizeBytes: 100, label: 'sonstiges' }),
        );
        expect(initRejected.statusCode).toBe(401);
        expect(initRejected.json().code).toBe('IMPORT_TOKEN_INVALID');
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // Empty-target import — no token issued. Session is alive, no
  // sessionInvalidated, no `importToken`.
  //
  // The empty-target path does NOT wipe `users`, so the envelope's
  // user-id values MUST NOT collide with the seeded `inhaber` /
  // `buero` / … rows. We pass a non-seed UUID for the envelope owner
  // to dodge the PK collision; the resulting token-mint contract is
  // unaffected (this path never mints anyway).
  // -------------------------------------------------------------------
  describe('empty-target import — no token issued', () => {
    it('importToken is null when the import did not wipe sessions', async () => {
      try {
        // Wipe business data but leave users alone — so the import
        // lands into an empty business set without triggering the
        // override path that wipes users.
        await db.execute(
          sql`TRUNCATE TABLE
            attachments,
            invoices,
            invoice_sequence,
            project_workers,
            projects,
            customers,
            company_profile
          RESTART IDENTITY CASCADE`,
        );

        // Non-colliding owner UUID — the seed retains its `11111111-…`
        // inhaber row, so the envelope owner uses a prefix-derived
        // value that no seed fixture mints. confirmation_phrase is
        // unused on empty-target — strip it explicitly to mirror the
        // production code path.
        const env = buildOverrideEnvelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        const { confirmation_phrase: _drop, ...envWithoutPhrase } = env as Record<string, unknown>;
        void _drop;

        const res = await authPost(ownerToken, '/api/import', envWithoutPhrase);
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          sessionInvalidated: boolean;
          importToken: string | null;
        };
        expect(body.sessionInvalidated).toBe(false);
        expect(body.importToken).toBeNull();
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // Dry-run import — never reaches the commit branch and never mints a
  // token. The dry-run preview shape omits `importToken` entirely.
  // -------------------------------------------------------------------
  describe('dry-run import — no token issued', () => {
    it('importToken is absent on the dry-run preview shape', async () => {
      const env = buildOverrideEnvelope();
      const { confirmation_phrase: _drop, ...envWithoutPhrase } = env as Record<string, unknown>;
      void _drop;
      const res = await authPost(ownerToken, '/api/import?dry_run=true', envWithoutPhrase);
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      // Dry-run response shape — see `DryRunPreview` in domain/dataExchange.ts.
      // `importToken` must not appear; an `undefined`/absent field is the
      // contract, not `null` (we shipped this as part of the preview's
      // intentional shape divergence from `ImportResult`).
      expect('importToken' in body).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Header trumps session — both a stale cookie AND a valid Bearer
  // header on the same request. The Bearer wins; the call succeeds.
  // The cookie is known to be dead post-cascade; the Bearer is the
  // explicit auth signal.
  // -------------------------------------------------------------------
  describe('header trumps cookie — Bearer wins when both are present', () => {
    it('init with a stale cookie + valid Bearer succeeds (Bearer is authoritative)', async () => {
      try {
        const importRes = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(importRes.statusCode).toBe(200);
        const { importToken } = importRes.json() as { importToken: string };
        expect(importToken).toBeTruthy();

        const projectId = '55555555-5555-4555-8555-555555555555';

        // The original `ownerToken` is stale post-override-import (the
        // wipe cascaded into sessions). Pass it via the cookie header
        // alongside a fresh Bearer; the Bearer must win.
        const res = await getApp().inject({
          method: 'POST',
          url: `/api/projects/${projectId}/attachments/init`,
          headers: {
            authorization: `Bearer ${importToken}`,
            cookie: `session=${ownerToken}`,
          },
          payload: binaryInitBody({
            fileName: 'both.pdf',
            sizeBytes: 100,
            label: 'sonstiges',
          }),
        });
        expect(res.statusCode).toBe(201);
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // Defense in depth — malformed / unknown Bearer surfaces
  // IMPORT_TOKEN_INVALID rather than falling through to the cookie
  // path. The header is the explicit signal: if it's present and
  // wrong, the request is wrong.
  // -------------------------------------------------------------------
  describe('unknown Bearer rejects with IMPORT_TOKEN_INVALID (does not silently fall through)', () => {
    it('init with a bogus Bearer header returns 401 IMPORT_TOKEN_INVALID even when a valid cookie is set', async () => {
      const projectId = await seededProjectId(ownerToken);
      const res = await getApp().inject({
        method: 'POST',
        url: `/api/projects/${projectId}/attachments/init`,
        headers: {
          authorization: 'Bearer not-a-real-token',
          cookie: `session=${ownerToken}`,
        },
        payload: binaryInitBody({ fileName: 'bogus.pdf', sizeBytes: 100, label: 'sonstiges' }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('IMPORT_TOKEN_INVALID');
    });
  });

  // -------------------------------------------------------------------
  // Identity attribution — the token is tied to the operator's user id
  // (the same id round-trips through the envelope into the new `users`
  // row). After the cascade + import, the auth middleware loads the
  // freshly-inserted user; the audit / repo writes from a subsequent
  // init carry the operator's id.
  //
  // The fixture pins the operator-owner row to the seeded `inhaber`
  // UUID so the round-trip identity matches — that's the design
  // contract. We assert the `created_by` value on the resulting row
  // resolves to the same UUID.
  // -------------------------------------------------------------------
  describe('identity — token-authenticated request loads the operator user id', () => {
    it('init under Bearer attributes the row to the imported operator user id', async () => {
      try {
        const importRes = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(importRes.statusCode).toBe(200);
        const { importToken } = importRes.json() as { importToken: string };
        expect(importToken).toBeTruthy();

        // Sanity: after the override, the imported envelope's owner row
        // is present under the seeded operator UUID — that's the round-
        // trip the token relies on.
        const inspect = await db.execute<{ id: string }>(
          sql`SELECT id::text AS id FROM users WHERE username = 'imp-owner' LIMIT 1`,
        );
        expect(inspect.rows[0]?.id).toBe(SEEDED_INHABER_UUID);

        // Init under Bearer — the row's `created_by` is set from
        // `request.user!.id`. The middleware loaded that from the
        // token's `userId`, which matches the imported envelope row.
        const projectId = '55555555-5555-4555-8555-555555555555';
        const res = await injectInitWithBearer(
          projectId,
          importToken,
          binaryInitBody({
            fileName: 'identity.pdf',
            sizeBytes: 100,
            label: 'sonstiges',
          }),
        );
        expect(res.statusCode).toBe(201);

        // Pull the row directly — the route response carries
        // `attachment.id` but the AC asserts against the persisted row.
        const id = res.json().attachment.id as string;
        const row = await db.execute<{ created_by: string }>(
          sql`SELECT created_by::text AS created_by FROM attachments WHERE id = ${id} LIMIT 1`,
        );
        expect(row.rows[0]?.created_by).toBe(SEEDED_INHABER_UUID);
      } finally {
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });
});
