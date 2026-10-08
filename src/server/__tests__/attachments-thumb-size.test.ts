/**
 * API integration tests — thumbnail size cap + complete-side HEAD
 * re-assertion under ADR-0024 (AC-245 / AC-212 thumb defence in depth).
 *
 * Two regression surfaces are pinned here:
 *
 *   1. `ciphertextThumbSizeBytes` is signed into the presigned PUT and
 *      re-asserted at HEAD time. Under e2e the size on the wire IS
 *      the ciphertext size; the row's persisted column reflects that.
 *
 *   2. The ciphertext-thumb size is persisted on the row at init and
 *      re-asserted against HEAD at `complete()`. Mirrors the
 *      original-side `ciphertextSizeBytes` re-assertion — without this
 *      branch, the SigV4 `Content-Length` pin is the sole defence; a
 *      signature bypass could land arbitrary bytes under the thumb key.
 *
 * Direct-storage uploads bypass the SigV4 path so the complete-side
 * HEAD check can be exercised in isolation. Same pattern the existing
 * AC-212 arms in `attachments-routes.test.ts` use for the original-
 * side size-mismatch case. Storage objects carry the sentinel
 * `application/octet-stream` content type per ADR-0024.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { createStorageClientFromEnv } from '../storage/fromEnv.js';
import { getEnv } from '../config/env.js';
import { photoInitBody } from '../../test/fixtures/attachmentInit.js';
import { TEST_OBJECT_METADATA } from '../../test/fixtures/objectEnvelope.js';

const year = new Date().getFullYear();

function storage() {
  const env = getEnv();
  return createStorageClientFromEnv(env);
}

async function seededProjectIdForOwner(ownerToken: string): Promise<string> {
  // Owner is unscoped; YYYY-007 is a known seeded project also reachable
  // by worker1 (used here for parity with attachments-routes.test.ts).
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (row) => row.number === `${year}-007`,
  );
  if (!p) throw new Error(`seed missing ${year}-007`);
  return p.id;
}

async function countAttachmentRows(): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM attachments`);
    return (res.rows[0] as { c: number }).c;
  } finally {
    await pool.end();
  }
}

async function fetchAttachmentStatus(id: string): Promise<string | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT status FROM attachments WHERE id = ${id} LIMIT 1`);
    const row = res.rows[0] as { status: string } | undefined;
    return row?.status ?? null;
  } finally {
    await pool.end();
  }
}

async function fetchPersistedThumbSize(id: string): Promise<number | null> {
  const { db, pool } = createDatabase();
  try {
    // ADR-0024: the column the route persists from the init payload is
    // `ciphertext_thumb_size_bytes`. Plaintext `thumb_size_bytes` no
    // longer rides the init wire — this assertion targets the
    // ciphertext-thumb column the HEAD-time check re-asserts against.
    const res = await db.execute(
      sql`SELECT ciphertext_thumb_size_bytes FROM attachments WHERE id = ${id} LIMIT 1`,
    );
    const row = res.rows[0] as { ciphertext_thumb_size_bytes: number | string | null } | undefined;
    if (!row || row.ciphertext_thumb_size_bytes === null) return null;
    // bigint columns come back as string for some drivers; coerce.
    return typeof row.ciphertext_thumb_size_bytes === 'string'
      ? Number(row.ciphertext_thumb_size_bytes)
      : row.ciphertext_thumb_size_bytes;
  } finally {
    await pool.end();
  }
}

describe('Attachment thumbnail-size cap + HEAD re-assertion', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    projectId = await seededProjectIdForOwner(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // Init validation — `ciphertextThumbSizeBytes` is the on-the-wire
  // value the server signs into the PUT's Content-Length. The cap is
  // enforced against the *plaintext* `thumbSizeBytes` (per-thumb cap
  // applies to the visible blob the user sees post-decrypt), not the
  // ciphertext figure — the ciphertext side is implementation-defined.
  //
  // Under ADR-0024 the route fixture maps `thumbSizeBytes` overrides to
  // the legacy plaintext slot only, but the per-thumb cap check no
  // longer fires on the wire (the wire shape carries ciphertext bytes
  // only). The cap-bypass guard moved to the upload pipeline (the
  // client knows the plaintext size before encrypt). The tests here
  // therefore pin the *ciphertext-side* persistence + HEAD-reassertion
  // contract — the two surfaces still in scope for the route layer
  // under e2e.
  // -------------------------------------------------------------------
  describe('init: thumbnail ciphertext-size persistence', () => {
    it('persists ciphertextThumbSizeBytes on the row + signs Content-Length on the presigned PUT', async () => {
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInitBody({ ciphertextThumbSizeBytes: 8000 }),
      );
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.attachment.id).toBeDefined();
      expect(body.attachment.status).toBe('pending');

      // The row must carry the declared ciphertext-thumb size — that's
      // the data the complete-side HEAD check re-asserts against.
      const persisted = await fetchPersistedThumbSize(body.attachment.id);
      expect(persisted).toBe(8000);

      // The presigned PUT pins the same value into Content-Length —
      // the SigV4 layer is the first defence; the persisted row + HEAD
      // re-assertion is the second.
      expect(body.thumbnailUpload.headers['Content-Length']).toBe('8000');
    });

    it('strips unknown body fields before the handler (Fastify ajv `removeAdditional` default)', async () => {
      const before = await countAttachmentRows();
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInitBody(),
        nonsense: true,
      });
      // Fastify's ajv compiler defaults to `removeAdditional: true` —
      // the unknown `nonsense` field is stripped before the handler
      // sees it, so the request succeeds (201) on the canonical
      // sanitized payload. `additionalProperties: false` in the schema
      // is what tells ajv WHICH fields to strip; a regression that
      // dropped that constraint would let the unknown field through
      // to the handler.
      expect(res.statusCode).toBe(201);
      expect(await countAttachmentRows()).toBe(before + 1);
    });
  });

  // -------------------------------------------------------------------
  // complete() — HEAD re-assertion against the persisted ciphertext
  // thumb size.
  //
  // Direct-storage upload bypasses the SigV4 Content-Length pin so the
  // service-layer guard is the only thing standing between a thumb-size
  // mismatch and a `ready` row. Mirrors the existing original-side
  // mismatch arm in attachments-routes.test.ts. Storage objects carry
  // the sentinel `application/octet-stream` content type per ADR-0024.
  // -------------------------------------------------------------------
  describe('complete: thumbnail HEAD re-assertion', () => {
    it('returns 409 CONFLICT when stored thumb size differs from declared ciphertextThumbSizeBytes', async () => {
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInitBody({ ciphertextThumbSizeBytes: 8000 }),
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();

      // Original matches the row's declared ciphertextSizeBytes (120064
      // by fixture default) so the original-side HEAD passes — the
      // failure must come from the thumb branch alone.
      await s.upload(
        body.attachment.originalKey,
        Buffer.alloc(120_064, 0xff),
        'application/octet-stream',
        TEST_OBJECT_METADATA,
      );
      // Upload a thumb of WRONG size (1 byte vs the row's 8000). HEAD
      // reports 1, the row says 8000 → declared-size mismatch.
      await s.upload(
        body.attachment.thumbKey,
        Buffer.from('x'),
        'application/octet-stream',
        TEST_OBJECT_METADATA,
      );

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');

      // Row stays pending; the reaper is the only remover.
      const status = await fetchAttachmentStatus(body.attachment.id);
      expect(status).toBe('pending');
    });

    it('flips pending → ready when stored thumb size matches declared ciphertextThumbSizeBytes', async () => {
      // Sanity arm — confirms the new HEAD assertion does not over-reject
      // the happy path.
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInitBody({ ciphertextThumbSizeBytes: 12 }),
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();

      await s.upload(
        body.attachment.originalKey,
        Buffer.alloc(120_064, 0xff),
        'application/octet-stream',
        TEST_OBJECT_METADATA,
      );
      // 12 bytes — matches the declared ciphertextThumbSizeBytes exactly.
      await s.upload(
        body.attachment.thumbKey,
        Buffer.from('octet-thmb12'),
        'application/octet-stream',
        TEST_OBJECT_METADATA,
      );

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ready');
    });
  });
});
