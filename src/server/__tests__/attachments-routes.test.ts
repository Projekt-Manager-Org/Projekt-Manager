/**
 * API integration tests — attachment route surface (issue #108, #148).
 *
 * Pins the HTTP contract for every endpoint on
 * `/api/projects/:id/attachments/...` against the spec in api.md §14.2.11
 * and the error paths in §14.4.1.
 *
 * AC coverage in this file:
 *   - AC-245: init — presigned-PUT signed-header pins (ciphertext shape
 *             under ADR-0024) + validation rejects on MIME / label /
 *             size / fileName / dekMaterial / ciphertextSizeBytes /
 *             ciphertextContentMd5.
 *   - AC-212: complete — HEAD-verify state machine against ciphertext
 *             metadata (size against `ciphertextSizeBytes`, sentinel
 *             content-type), 409 on mismatch / double ack, 404 when
 *             the reaper has already removed the row.
 *   - AC-216: bulk-fetch — per-file payloads (presigned GETs + DEK
 *             material), 20-file / 20 MB plaintext caps,
 *             BULK_LIMIT_EXCEEDED, cross-project id rejection, pending-
 *             or-hidden in batch rejection. Replaces the retired
 *             bulk-download zip path (ADR-0024).
 *   - AC-225: upload-failure error envelope categories (maps to the
 *             client banner's "Erneut versuchen" surface).
 *   - AC-241: download-url — `{ url, expiresAt, dekMaterial }` shape,
 *             dekMaterial is the unwrapped DEK (32 bytes after
 *             base64-decode), thumbnail-on-non-photo rejection,
 *             unknown-variant rejection, hidden-row 404. Server never
 *             persists the unwrapped DEK.
 *   - AC-244 (server side): per-row unwrap-failure surfaces as 422
 *             with code `DEK_UNWRAP_FAILED`. The SW translates the
 *             code to the placeholder render path; the route-level
 *             surface is what this file pins.
 *
 * Storage: the test harness points at the real MinIO endpoint
 * (`startApp()` → `validateEnvRuntime()`). Direct-storage seeding uses the
 * pattern in backup.test.ts. MinIO is never mocked (CONTRIBUTING.md
 * §Testing "Integration prerequisites").
 *
 * Under ADR-0024 every PUT happens against ciphertext bytes, so the
 * test fixtures synthesize opaque ciphertext (random bytes) rather
 * than JPEG/PDF magic — see `ciphertextBuffer()` below.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { createStorageClient } from '../storage/client.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import { AttachmentService } from '../services/AttachmentService.js';
import { KeyEnvelopeService } from '../services/KeyEnvelopeService.js';
import type { AuthUser } from '../middleware/auth.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';
import { STRINGS } from '../../config/strings.js';
import { getEnv } from '../config/env.js';
import type { Attachment } from '../../domain/types.js';

const year = new Date().getFullYear();

/**
 * RFC 1864 base64 of MD5 — 16 bytes, base64-padded to 24 chars
 * (`==`-suffixed). The init route validates with the same regex; any
 * body matching this shape is accepted at schema validation. Tests that
 * exercise integrity at storage level supply the real MD5 of the body.
 */
const STUB_MD5_BASE64 = '1B2M2Y8AsgTpgAmY7PhCfg=='; // MD5("") — shape-valid placeholder

/**
 * Generate a fresh 32-byte DEK encoded as base64. Mirrors what the
 * browser produces via `crypto.getRandomValues(new Uint8Array(32))`
 * before calling init. The server validates the length-after-decode
 * at the route layer per AC-245.
 */
function freshDekMaterial(): string {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Synthesize an opaque ciphertext-shaped buffer of `length` bytes.
 * Under ADR-0024 the bytes the browser PUTs are AES-256-GCM ciphertext
 * with a leading nonce — random bytes are the canonical test fixture
 * (real ciphertext is computationally indistinguishable from random).
 */
function ciphertextBuffer(length: number): Buffer {
  return crypto.randomBytes(length);
}

/**
 * Wrap a fresh 32-byte DEK against the per-fork test binary identity
 * (see `src/test/integration-setup.ts` — `BINARY_AGE_RECIPIENT` /
 * `BINARY_AGE_IDENTITY_PATH` are exported there). Returns `{ dek,
 * wrappedBase64 }` so tests that need to compare unwrapped output
 * against the input DEK (AC-241 "different DEKs") have both halves.
 *
 * Direct DB seeds use the base64 envelope on `wrapped_dek` so the
 * route's per-request unwrap succeeds. Synthetic Buffer.alloc envelopes
 * fail at AEAD verification under any real KeyEnvelopeService impl —
 * happy-path tests must wrap a real DEK.
 *
 * Reads `process.env` directly because the env zod schema does not yet
 * carry `BINARY_AGE_*` (implementer agent extends it in step 5). Once
 * the schema lands, this helper can collapse to `getEnv()`.
 */
async function wrapFreshDek(): Promise<{ dek: Buffer; wrappedBase64: string }> {
  const recipient = process.env.BINARY_AGE_RECIPIENT;
  const identityPath = process.env.BINARY_AGE_IDENTITY_PATH;
  if (!recipient || !identityPath) {
    throw new Error(
      'wrapFreshDek: BINARY_AGE_RECIPIENT / BINARY_AGE_IDENTITY_PATH not configured. ' +
        'Per-fork identity is set in src/test/integration-setup.ts — verify it ran before this import.',
    );
  }
  const identity = readFileSync(identityPath, 'utf-8').trim();
  const service = new KeyEnvelopeService({ recipient, identity });
  const dek = crypto.randomBytes(32);
  const envelope = await service.wrap(dek);
  return { dek, wrappedBase64: Buffer.from(envelope).toString('base64') };
}

/**
 * Minimal photo-mime init payload used by every happy-path test. The
 * server fixes `originalKey` / `thumbKey` — clients never send them.
 *
 * Under ADR-0024 the init body carries:
 *   - plaintext `mimeType`, `fileName`, `sizeBytes`, `label`,
 *     `hasThumbnail` (the row metadata; storage never sees these on
 *     the wire),
 *   - per-blob `dekMaterial` (base64 of 32 random bytes),
 *   - per-blob `ciphertextSizeBytes` + `ciphertextContentMd5` — the
 *     server signs these into the presigned PUT.
 *
 * The plaintext `contentMd5` field from the pre-e2e shape is GONE —
 * what the client computes and the server signs is the *ciphertext*
 * MD5, not the plaintext one.
 */
function photoInit(projectId: string) {
  return {
    projectId,
    fileName: `test-${crypto.randomUUID().slice(0, 8)}.jpg`,
    mimeType: 'image/jpeg',
    sizeBytes: 120_000, // plaintext — for the per-file cap + export envelope
    label: 'foto' as const,
    hasThumbnail: true,
    thumbSizeBytes: 8_000, // plaintext thumb size
    // Ciphertext shape: the per-blob DEK + ciphertext size/MD5. The
    // server wraps the DEK and signs the PUT against the ciphertext
    // size / MD5 / sentinel content-type.
    dekMaterial: freshDekMaterial(),
    ciphertextSizeBytes: 120_064,
    ciphertextContentMd5: STUB_MD5_BASE64,
    thumbDekMaterial: freshDekMaterial(),
    ciphertextThumbSizeBytes: 8_064,
    ciphertextThumbContentMd5: STUB_MD5_BASE64,
  };
}

/**
 * Direct-storage helper — puts bytes under the server-issued key so a
 * complete() HEAD succeeds. Used only by the "happy path" arm; all
 * other complete arms exercise the failure surface.
 */
function storage() {
  const env = getEnv();
  return createStorageClient({
    endpoint: env.STORAGE_ENDPOINT!,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY!,
    secretKey: env.STORAGE_SECRET_KEY!,
  });
}

async function seededProjectIdForWorker1(ownerToken: string): Promise<string> {
  // Worker1 (arbeiter1) is assigned to YYYY-007, -008, -009, -011. Pick
  // a project they can reach so positive-scope arms read meaningfully.
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (row) => row.number === `${year}-007`,
  );
  if (!p) throw new Error(`seed missing ${year}-007`);
  return p.id;
}

async function seededProjectIdUnassigned(ownerToken: string): Promise<string> {
  // YYYY-001 is unassigned — the "worker out of scope" arm reads it.
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (row) => row.number === `${year}-001`,
  );
  if (!p) throw new Error(`seed missing ${year}-001`);
  return p.id;
}

describe('Attachment routes — integration (issue #108)', () => {
  let ownerToken: string;
  let workerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
    projectId = await seededProjectIdForWorker1(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // AC-245 — Init validates inputs and returns a signed presigned PUT
  // bound to the *ciphertext* triplet (sentinel content-type, ciphertext
  // size, ciphertext MD5) per ADR-0024.
  // -------------------------------------------------------------------
  describe('AC-245: init validation + presigned-PUT signature', () => {
    it('returns 201 with a pending row and two presigned PUT descriptors for a photo', async () => {
      const init = photoInit(projectId);
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, init);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.attachment).toBeDefined();
      expect(body.attachment.id).toBeDefined();
      expect(body.attachment.status).toBe('pending');
      expect(body.attachment.projectId).toBe(projectId);
      expect(body.attachment.kind).toBe('photo');
      expect(body.attachment.label).toBe('foto');
      // Plaintext mimeType lives on the row (drives the download
      // Content-Disposition + the kind classification). Storage never
      // sees this value on the wire.
      expect(body.attachment.mimeType).toBe('image/jpeg');
      // The server fixes the key — clients never supply one.
      expect(typeof body.attachment.originalKey).toBe('string');
      expect(body.attachment.originalKey.length).toBeGreaterThan(0);
      expect(typeof body.attachment.thumbKey).toBe('string');
      // Wrapped envelopes are NEVER returned in any response surface
      // (data-model.md §5.13 "Wrapped envelope is server-handed-back",
      // api.md §14.2.11 design notes). The wrapping happened server-
      // side; the column is on the row but is stripped from every
      // response.
      expect(body.attachment.wrappedDek).toBeUndefined();
      expect(body.attachment.wrappedThumbDek).toBeUndefined();
      // Uploader expansion: createdBy is `{ id, displayName }` so the
      // frontend doesn't need a privileged user-directory fetch (#125).
      expect(body.attachment.createdBy).toMatchObject({
        id: expect.any(String),
        displayName: expect.any(String),
      });

      expect(body.originalUpload).toBeDefined();
      expect(typeof body.originalUpload.url).toBe('string');
      expect(typeof body.originalUpload.headers).toBe('object');
      expect(body.originalUpload.headers).not.toBeNull();
      expect(typeof body.originalUpload.expiresAt).toBe('string');
      // Three signed headers — Content-Type, Content-Length, Content-MD5
      // — every PUT must echo verbatim. Under e2e:
      //   Content-Type   == application/octet-stream (sentinel; the
      //                     row's plaintext mimeType is NOT signed)
      //   Content-Length == ciphertextSizeBytes (NOT plaintext sizeBytes)
      //   Content-MD5    == ciphertextContentMd5 (NOT a plaintext MD5)
      expect(body.originalUpload.headers['Content-Type']).toBe('application/octet-stream');
      expect(body.originalUpload.headers['Content-Length']).toBe(String(init.ciphertextSizeBytes));
      expect(body.originalUpload.headers['Content-MD5']).toBe(init.ciphertextContentMd5);
      expect(body.thumbnailUpload).toBeDefined();
      expect(body.thumbnailUpload.headers['Content-Type']).toBe('application/octet-stream');
      expect(body.thumbnailUpload.headers['Content-Length']).toBe(
        String(init.ciphertextThumbSizeBytes),
      );
      expect(body.thumbnailUpload.headers['Content-MD5']).toBe(init.ciphertextThumbContentMd5);
    });

    it('returns exactly one descriptor (no thumbnail) for a non-photo MIME', async () => {
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: 'vertrag.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 50_000,
        label: 'rechnung',
        hasThumbnail: false,
        dekMaterial: freshDekMaterial(),
        ciphertextSizeBytes: 50_064,
        ciphertextContentMd5: STUB_MD5_BASE64,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.attachment.kind).toBe('binary');
      expect(body.attachment.thumbKey).toBeNull();
      expect(body.thumbnailUpload).toBeUndefined();
      // Sentinel content-type still — even on a non-photo init.
      expect(body.originalUpload.headers['Content-Type']).toBe('application/octet-stream');
      expect(body.originalUpload.headers['Content-Length']).toBe('50064');
    });

    it('pins the presigned PUT URL to the exact originalKey issued on the row', async () => {
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(res.statusCode).toBe(201);
      const body = res.json();
      // The PUT URL's path encodes the storage key (S3 path-style:
      // `<endpoint>/<bucket>/<key>?X-Amz-…`). A client that swaps the
      // key would hit a different signed URL — keep the assertion at
      // the URL level rather than the fields level (which presigned PUT
      // doesn't have).
      expect(body.originalUpload.url).toContain(
        encodeURI(body.attachment.originalKey).replace(/%2F/gi, '/'),
      );
      if (body.thumbnailUpload) {
        expect(body.thumbnailUpload.url).toContain(
          encodeURI(body.attachment.thumbKey).replace(/%2F/gi, '/'),
        );
      }
    });

    it('persists wrappedDek (and wrappedThumbDek) on the row but NEVER returns it', async () => {
      // Bridges AC-245 and AC-240: init wraps the supplied DEK
      // material against the operator's binary recipient and
      // persists the envelope on the row, but the response strips
      // it. A regression that surfaced the wrapped envelope on the
      // init response would let any caller bypass the SW-mediated
      // download flow and could in some configurations leak the
      // wrapped material into client logs.
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(res.statusCode).toBe(201);
      const attId = res.json().attachment.id as string;

      // Response strip
      expect(res.json().attachment.wrappedDek).toBeUndefined();
      expect(res.json().attachment.wrappedThumbDek).toBeUndefined();

      // Row persistence — the column is populated on the row.
      const { db, pool } = createDatabase();
      try {
        const rows = await db.execute(
          sql`SELECT wrapped_dek, wrapped_thumb_dek FROM attachments WHERE id = ${attId}`,
        );
        const row = rows.rows[0] as {
          wrapped_dek: string | null;
          wrapped_thumb_dek: string | null;
        };
        expect(row.wrapped_dek).not.toBeNull();
        expect((row.wrapped_dek as string).length).toBeGreaterThan(0);
        expect(row.wrapped_thumb_dek).not.toBeNull();
      } finally {
        await pool.end();
      }
    });

    it('persists wrappedDekVersion = 1 alongside the wrapped envelopes (ADR-0024 envelope-format discriminator)', async () => {
      // AC-245 — current iteration writes envelope-format version 1 on
      // every init. The column is NOT NULL with no DB default; the
      // service layer is the single writer. A regression that omitted
      // the version, defaulted it at the DB level, or wrote a
      // different value would either fail the insert outright (NOT NULL
      // breach) or land a row that later trips the unwrap-time
      // validation (AC-244 envelope-format unknown branch).
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(res.statusCode).toBe(201);
      const attId = res.json().attachment.id as string;

      const { db, pool } = createDatabase();
      try {
        const rows = await db.execute(
          sql`SELECT wrapped_dek_version FROM attachments WHERE id = ${attId}`,
        );
        const row = rows.rows[0] as { wrapped_dek_version: number };
        expect(row.wrapped_dek_version).toBe(1);
      } finally {
        await pool.end();
      }
    });

    it('rejects a missing/malformed ciphertextContentMd5 with 422 VALIDATION_ERROR (no row)', async () => {
      const before = await countAttachmentRows();
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        ciphertextContentMd5: 'not-a-base64-md5',
      });
      // JSON-schema pattern fires before service-level checks; the gate
      // produces 422 either way.
      expect(res.statusCode).toBe(422);
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects hasThumbnail=true with no ciphertextThumbContentMd5 with 422 (no row)', async () => {
      const before = await countAttachmentRows();
      const { ciphertextThumbContentMd5: _omit, ...payload } = photoInit(projectId);
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        payload,
      );
      expect(res.statusCode).toBe(422);
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects ciphertextSizeBytes that is non-positive with 422 (no row)', async () => {
      const before = await countAttachmentRows();
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        ciphertextSizeBytes: 0,
      });
      expect(res.statusCode).toBe(422);
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects ciphertextThumbSizeBytes that is non-positive with 422 (no row)', async () => {
      const before = await countAttachmentRows();
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        ciphertextThumbSizeBytes: 0,
      });
      expect(res.statusCode).toBe(422);
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects ciphertextThumbSizeBytes exceeding the per-thumb cap with 422 VALIDATION_ERROR (no row)', async () => {
      // AC-245: per-thumb cap. Default cap is 200 KiB
      // (architecture.md §12.2 / ATTACHMENT_CONFIG.perThumbCapBytes).
      // 1 MiB is comfortably above any deployment-tuned value.
      // Mirrors the per-file cap arm above — the rejection source is
      // the cap validator, surfaced as the same German message
      // (uploadFileTooLarge) so the UI banner can render the
      // size-cap copy without parsing the message.
      const before = await countAttachmentRows();
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        ciphertextThumbSizeBytes: 1 * 1024 * 1024,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(res.json().message).toBe(STRINGS.attachments.uploadFileTooLarge);
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects malformed dekMaterial (not 32 bytes after base64-decode) with 422 (no row)', async () => {
      // The spec pins the validation post-decode: 31 bytes or 33
      // bytes of base64-decoded material both fail. Use a 16-byte
      // payload so the decoded length is unambiguously wrong even
      // if the base64 padding character count varies.
      const before = await countAttachmentRows();
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        dekMaterial: Buffer.alloc(16, 0x42).toString('base64'),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects dekMaterial that is not valid base64 with 422 (no row)', async () => {
      const before = await countAttachmentRows();
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        dekMaterial: '@@@-not-base64-@@@',
      });
      expect(res.statusCode).toBe(422);
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects hasThumbnail=true with malformed thumbDekMaterial with 422 (no row)', async () => {
      const before = await countAttachmentRows();
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        thumbDekMaterial: Buffer.alloc(16, 0x42).toString('base64'),
      });
      expect(res.statusCode).toBe(422);
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects hasThumbnail=true with no thumbDekMaterial with 422 (no row)', async () => {
      const before = await countAttachmentRows();
      const { thumbDekMaterial: _omit, ...payload } = photoInit(projectId);
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        payload,
      );
      expect(res.statusCode).toBe(422);
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects a MIME outside the whitelist with 422 VALIDATION_ERROR (no row)', async () => {
      const before = await countAttachmentRows();
      // Use the shared fixture so `contentMd5` is present and AJV's
      // missing-required-field gate doesn't short-circuit the test before
      // it reaches the MIME validator. The assertion on the rendered
      // German string pins the *MIME* validator as the rejection source —
      // a future regression that lets a non-whitelisted MIME pass would
      // either flip the status code or change the message.
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        binaryInitBody({
          fileName: 'evil.exe',
          mimeType: 'application/x-msdownload',
          sizeBytes: 100,
          label: 'sonstiges',
        }),
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(res.json().message).toBe(STRINGS.attachments.uploadMimeNotAllowed);
      const after = await countAttachmentRows();
      expect(after).toBe(before);
    });

    it('rejects a label outside the enum with 422 VALIDATION_ERROR (no row)', async () => {
      const before = await countAttachmentRows();
      // Use the shared fixture so `contentMd5` is present and AJV's
      // missing-required-field gate doesn't short-circuit the test before
      // it reaches the label validator. The label-rejection message is
      // the generic `invalidInput` (the service has no label-specific
      // copy), so we pin the generic message — sufficient to detect a
      // future regression where the validator stops firing and AJV
      // catches an upstream-shape break instead.
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        binaryInitBody({
          fileName: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 100,
          label: 'not-in-enum',
        }),
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(res.json().message).toBe(STRINGS.errors.invalidInput);
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects sizeBytes > configured cap with 422 VALIDATION_ERROR', async () => {
      // Default per-file cap is 1 MB (architecture.md §12.2). 10 MB is
      // safely above regardless of a deployment-specific tune. The test
      // pins the spec behavior, not a specific deployment constant —
      // when the cap is raised, increase this too.
      //
      // Use the shared fixture so `contentMd5` is present and AJV's
      // missing-required-field gate doesn't short-circuit the test before
      // it reaches the size validator. The assertion on the rendered
      // German string pins the *size-cap* validator as the rejection
      // source — a future regression that drops the cap check would
      // either flip the status code or change the message.
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        binaryInitBody({
          fileName: 'huge.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10 * 1024 * 1024,
          label: 'sonstiges',
        }),
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(res.json().message).toBe(STRINGS.attachments.uploadFileTooLarge);
    });

    it('rejects empty fileName with 422 VALIDATION_ERROR', async () => {
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: '',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'sonstiges',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects fileName longer than 255 characters with 422 VALIDATION_ERROR', async () => {
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: `${'a'.repeat(256)}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'sonstiges',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects a client-supplied originalKey — the server owns the key', async () => {
      // A well-formed request carrying an extra `originalKey` field must
      // not be honored. Either the server ignores the field (and issues
      // its own key — asserted here by shape mismatch) or it rejects as
      // 422. Either is acceptable; what must NOT happen is the client's
      // key appearing on the row.
      const injectedKey = 'attacker/controlled/path.jpg';
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        originalKey: injectedKey,
      } as Record<string, unknown>);
      if (res.statusCode === 201) {
        expect(res.json().attachment.originalKey).not.toBe(injectedKey);
      } else {
        expect(res.statusCode).toBe(422);
      }
    });
  });

  // -------------------------------------------------------------------
  // AC-212 — complete() state machine — pending → ready with HEAD
  //          verify against ciphertext metadata (ADR-0024 / api.md
  //          §14.2.11). The pre-e2e `startsWith('image/')` thumbnail
  //          carve-out is gone: every blob is opaque ciphertext under
  //          the sentinel `application/octet-stream` content-type.
  // -------------------------------------------------------------------
  describe('AC-212: complete state machine — pending → ready with HEAD verify against ciphertext metadata', () => {
    /**
     * Seed a pending row and put matching ciphertext bytes under its
     * storage keys so a complete() call's HEAD verification succeeds.
     * Returns the attachment id.
     *
     * Uploads carry `application/octet-stream` (the sentinel) so HEAD
     * reports it back. A regression that uploaded with a real MIME
     * (image/jpeg, image/webp, etc.) would still trip the size match
     * but fail the content-type assertion at complete-time.
     */
    async function seedPendingWithBackingBytes(): Promise<string> {
      const init = photoInit(projectId);
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, init);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      const s = storage();
      // Bytes match the row's persisted `ciphertextSizeBytes` /
      // `ciphertextThumbSizeBytes` so HEAD passes the size check.
      // Both blobs carry the sentinel content-type so HEAD passes
      // the content-type check (no `startsWith('image/')` carve-out
      // under e2e).
      await s.upload(
        body.attachment.originalKey,
        ciphertextBuffer(init.ciphertextSizeBytes),
        'application/octet-stream',
      );
      await s.upload(
        body.attachment.thumbKey,
        ciphertextBuffer(init.ciphertextThumbSizeBytes),
        'application/octet-stream',
      );
      return body.attachment.id;
    }

    it('flips pending → ready when both objects exist and sizes match', async () => {
      const attId = await seedPendingWithBackingBytes();
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(attId);
      expect(body.status).toBe('ready');
    });

    it('persists original + thumb version-ids on complete (ADR-0022)', async () => {
      // The bucket is versioned; every PUT (browser or test setup) yields
      // a fresh VersionId in the HEAD response. complete() captures both
      // ids and writes them to attachments.version_id / thumb_version_id
      // — the row is the sole source of truth for the future restore
      // copyFromVersion call. Pending → null; ready (with thumb) → both
      // non-null, well-formed (non-empty strings).
      const attId = await seedPendingWithBackingBytes();
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(res.statusCode).toBe(200);

      const versions = await fetchAttachmentVersions(attId);
      expect(versions).not.toBeNull();
      expect(versions?.versionId).toMatch(/.+/);
      expect(versions?.thumbVersionId).toMatch(/.+/);
    });

    it('returns 409 CONFLICT and leaves the row pending when the original object is missing', async () => {
      // Seed an init WITHOUT uploading bytes — the HEAD must miss.
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const attId = initRes.json().attachment.id;

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');

      // Row stays pending; the reaper is the only remover of a stuck row.
      const status = await fetchAttachmentStatus(attId);
      expect(status).toBe('pending');
    });

    it('returns 409 CONFLICT when the stored size differs from the declared ciphertextSizeBytes', async () => {
      // AC-212 / spec §14.2.11 error paths: complete verifies the
      // HEAD-reported size against the row's DECLARED `ciphertextSizeBytes`,
      // NOT plaintext sizeBytes. A ciphertext-size-substitution upload
      // — bytes under a key whose row claims 1KB but the actual stored
      // ciphertext is 2 MB — must land as 409.
      const initRes = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        ciphertextSizeBytes: 1024,
      });
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();
      // Upload 2 MB under the issued key (note: the presigned PUT
      // would reject this via the signed `Content-Length` header; we
      // bypass that by direct-storage upload to exercise the
      // complete-side guard). HEAD reports 2 MB, row says 1024 →
      // declared-ciphertext-size mismatch → 409.
      await s.upload(
        body.attachment.originalKey,
        ciphertextBuffer(2 * 1024 * 1024),
        'application/octet-stream',
      );
      await s.upload(body.attachment.thumbKey, ciphertextBuffer(8064), 'application/octet-stream');

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');
    });

    it('returns 409 CONFLICT when the stored ciphertext size matches the row but the plaintext exceeds the global cap (defence in depth)', async () => {
      // Normal init rejects plaintext sizeBytes > cap up-front, so
      // this branch is only reachable if the cap dropped between init
      // and complete. Seed a pending row directly with an over-cap
      // plaintext `size_bytes` (and a matching `ciphertext_size_bytes`
      // that the bytes will satisfy), then call complete() — the
      // global-cap guard on plaintext (in addition to the declared-
      // ciphertext-size guard) must fire.
      const attId = crypto.randomUUID();
      const originalKey = `attachments/${projectId}/${attId}.orig`;
      const thumbKey = `attachments/${projectId}/${attId}.thumb`;
      const plaintextOversize = 2 * 1024 * 1024;
      const ciphertextOversize = 2 * 1024 * 1024 + 64;
      // Synthetic envelopes — `complete` rejects on the per-file plaintext
      // cap before the unwrap pipeline ever runs on this row.
      const wrappedDek = Buffer.alloc(192, 0).toString('base64');
      const wrappedThumb = Buffer.alloc(192, 1).toString('base64');
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             ciphertext_size_bytes, ciphertext_thumb_size_bytes,
             original_key, thumb_key, has_thumbnail,
             wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
          VALUES (${attId}, ${projectId}, 'pending', 'photo', 'foto',
                  'oversize.jpg', 'image/jpeg', ${plaintextOversize},
                  ${ciphertextOversize}, 1024,
                  ${originalKey}, ${thumbKey}, TRUE,
                  ${wrappedDek}, ${wrappedThumb}, 1)
        `);
      } finally {
        await pool.end();
      }
      const s = storage();
      await s.upload(originalKey, ciphertextBuffer(ciphertextOversize), 'application/octet-stream');
      await s.upload(thumbKey, ciphertextBuffer(1024), 'application/octet-stream');

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');
    });

    it('returns 409 CONFLICT when stored content-type is not the sentinel application/octet-stream (e.g. uploader sent image/jpeg)', async () => {
      // The sentinel is the entire content-type contract under e2e —
      // ANY non-sentinel value fails at HEAD. The pre-e2e
      // `startsWith('image/')` carve-out for thumbnails is GONE; both
      // blobs must be `application/octet-stream`.
      const init = photoInit(projectId);
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        init,
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();
      // Upload with the *plaintext* MIME (image/jpeg) — HEAD reports
      // it back, complete must reject because the sentinel is what
      // the row's contract expects under e2e.
      await s.upload(
        body.attachment.originalKey,
        ciphertextBuffer(init.ciphertextSizeBytes),
        'image/jpeg',
      );
      await s.upload(
        body.attachment.thumbKey,
        ciphertextBuffer(init.ciphertextThumbSizeBytes),
        'application/octet-stream',
      );

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');
    });

    it('returns 409 CONFLICT when stored thumbnail content-type is not the sentinel (no startsWith image/ carve-out under e2e)', async () => {
      // The pre-e2e contract allowed thumbnails to be any
      // `image/<x>` (the gallery rendered them via a real Content-Type).
      // Under e2e thumbnails are ciphertext too — sentinel only.
      // Pin the absence of the carve-out: thumbnail with image/webp
      // must fail at complete-time, just like the original-side arm
      // above.
      const init = photoInit(projectId);
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        init,
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();
      await s.upload(
        body.attachment.originalKey,
        ciphertextBuffer(init.ciphertextSizeBytes),
        'application/octet-stream',
      );
      // Pre-e2e legitimate; under e2e a regression smell.
      await s.upload(
        body.attachment.thumbKey,
        ciphertextBuffer(init.ciphertextThumbSizeBytes),
        'image/webp',
      );

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');
    });

    it('returns 409 CONFLICT on double-ack (complete called twice on same id)', async () => {
      const attId = await seedPendingWithBackingBytes();
      const first = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(first.statusCode).toBe(200);
      const second = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('CONFLICT');
    });

    it('returns 404 NOT_FOUND when complete is called on an id the reaper already removed', async () => {
      // Simulate a reaped row: the attachments row is removed outright.
      // Any subsequent complete call from a racing client must 404, not
      // 409 — the spec pins that distinction so clients discard the
      // pending upload state.
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const attId = initRes.json().attachment.id;

      // Direct-DB removal of the row (reaper path does this + storage delete).
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`DELETE FROM attachments WHERE id = ${attId}`);
      } finally {
        await pool.end();
      }

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('returns 404 NOT_FOUND when the project is archived between init and complete', async () => {
      // Race window: init lands on an active project, the project is
      // archived while the bytes upload, then complete tries to flip
      // pending → ready. AC-95 says mutations on archived rows must
      // not stick — without the archive guard in completeUpload, a
      // racing client could land a `ready` attachment on a frozen
      // project. The pending row remains for the reaper.
      //
      // The fixture archives the project, so it must be a fresh one —
      // archiving the shared `projectId` would poison every other arm.
      const customersRes = await authGet(ownerToken, '/api/customers');
      const customers = customersRes.json().customers ?? customersRes.json().data;
      const customerId = customers[0].id;
      const createRes = await authPost(ownerToken, '/api/projects', {
        number: `${year}-CMP-ARCH`,
        title: 'Archive-during-upload race',
        customerId,
      });
      expect(createRes.statusCode).toBe(201);
      const raceProjectId = createRes.json().id;

      const initRes = await authPost(
        ownerToken,
        `/api/projects/${raceProjectId}/attachments/init`,
        photoInit(raceProjectId),
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const attId = body.attachment.id;

      // Ciphertext lands in storage with the sentinel content-type
      // (HEAD would otherwise miss and surface 409 before the archive
      // gate fires). The actual bytes are irrelevant — the archive
      // gate kills the request before HEAD verification anyway.
      const s = storage();
      const init = photoInit(raceProjectId); // re-derive the ciphertext sizes
      await s.upload(
        body.attachment.originalKey,
        ciphertextBuffer(init.ciphertextSizeBytes),
        'application/octet-stream',
      );
      await s.upload(
        body.attachment.thumbKey,
        ciphertextBuffer(init.ciphertextThumbSizeBytes),
        'application/octet-stream',
      );

      // Archive lands between init and complete.
      const archiveRes = await authDelete(ownerToken, `/api/projects/${raceProjectId}`);
      expect(archiveRes.statusCode).toBe(200);

      const completeRes = await authPost(
        ownerToken,
        `/api/projects/${raceProjectId}/attachments/${attId}/complete`,
      );
      expect(completeRes.statusCode).toBe(404);
      expect(completeRes.json().code).toBe('NOT_FOUND');

      // The pending row must survive — the reaper is the sole remover.
      const status = await fetchAttachmentStatus(attId);
      expect(status).toBe('pending');
    });
  });

  // -------------------------------------------------------------------
  // AC-216 — bulk-fetch — per-file payload + caps. Replaces the retired
  // bulk-download zip path (ADR-0024). The browser receives per-file
  // presigned-GETs + DEK material and assembles the streaming zip
  // locally; the server never archives ciphertext.
  // -------------------------------------------------------------------
  describe('AC-216: bulk-fetch per-file payload + caps', () => {
    it('rejects a batch of 21 ids with 422 BULK_LIMIT_EXCEEDED (limits field present)', async () => {
      // The server must validate the COUNT before resolving ids, so
      // 21 arbitrary uuids is sufficient — the count check fires
      // first per the spec ("exceeding either cap is rejected").
      const fakeIds = Array.from({ length: 21 }, () => crypto.randomUUID());
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/bulk-fetch`, {
        attachmentIds: fakeIds,
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.code).toBe('BULK_LIMIT_EXCEEDED');
      expect(body.details?.limits ?? body.limits).toBeDefined();
      const limits = body.details?.limits ?? body.limits;
      expect(typeof limits.maxFiles).toBe('number');
      expect(typeof limits.maxBytes).toBe('number');
    });

    it('rejects a batch whose summed plaintext sizeBytes exceeds 20 MB with BULK_LIMIT_EXCEEDED', async () => {
      // Seed three ready rows each 8 MB plaintext = 24 MB total,
      // under the 20-file cap but over the 20-MB plaintext bytes cap.
      // The cap is on PLAINTEXT bytes (not ciphertext) because the
      // user-visible quantity is plaintext — that's what they
      // ultimately decrypt and download.
      const ids = await seedReadyAttachments(projectId, [
        { sizeBytes: 8 * 1024 * 1024 },
        { sizeBytes: 8 * 1024 * 1024 },
        { sizeBytes: 8 * 1024 * 1024 },
      ]);
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/bulk-fetch`, {
        attachmentIds: ids,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('BULK_LIMIT_EXCEEDED');
    });

    it('rejects with 422 VALIDATION_ERROR when any id belongs to a different project', async () => {
      // One id from the primary project, one from an unrelated one.
      const otherProjectId = await (async () => {
        const r = await authGet(ownerToken, '/api/projects?limit=200');
        const p = (r.json().data as { id: string; number: string }[]).find(
          (row) => row.number === `${year}-008`,
        );
        return p!.id;
      })();
      const [primaryId] = await seedReadyAttachments(projectId, [{ sizeBytes: 100 }]);
      const [otherId] = await seedReadyAttachments(otherProjectId, [{ sizeBytes: 100 }]);
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/bulk-fetch`, {
        attachmentIds: [primaryId, otherId],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects with 422 VALIDATION_ERROR when any id references a pending row (whole batch rejected)', async () => {
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const pendingId = initRes.json().attachment.id;
      const [readyId] = await seedReadyAttachments(projectId, [{ sizeBytes: 100 }]);

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/bulk-fetch`,
        // Mix in one ready row to pin the "no partial-serve" contract:
        // the whole batch must be rejected when any id is non-ready.
        { attachmentIds: [readyId, pendingId] },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects with 422 VALIDATION_ERROR when any id references a hidden row', async () => {
      // Symmetric to the pending-in-batch arm — hidden rows carry
      // a delete marker on the current version, so a fetched
      // ciphertext would be a 404 from storage. Reject before the
      // SW sees the broken row.
      const attId = await seedHiddenAttachment(projectId, {
        versionId: 'fake-version-id',
        thumbVersionId: null,
        hasThumbnail: false,
      });
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/bulk-fetch`, {
        attachmentIds: [attId],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('returns 200 with a per-file payload list — order preserved, DEK material is 32 bytes', async () => {
      // Three rows: one binary (no thumb), two photos (with thumbs).
      // The response must carry one entry per id, in the order of
      // the request (api.md §14.2.11 "in the order requested").
      const [binId] = await seedReadyAttachments(projectId, [
        { sizeBytes: 1000, kind: 'binary', mimeType: 'application/pdf', label: 'rechnung' },
      ]);
      const photoIds = await seedReadyAttachments(projectId, [
        { sizeBytes: 2000, kind: 'photo', mimeType: 'image/jpeg', label: 'foto' },
        { sizeBytes: 3000, kind: 'photo', mimeType: 'image/png', label: 'foto' },
      ]);

      const requested = [photoIds[1], binId, photoIds[0]]; // arbitrary mix
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/bulk-fetch`, {
        attachmentIds: requested,
      });
      expect(res.statusCode).toBe(200);
      // api.md §14.2.11 pins the response as `{ data: BulkFetchEntry[] }` —
      // assert the wrapper shape directly, no fallback paths.
      const body = res.json() as { data: Array<Record<string, unknown>> };
      const entries = body.data;
      expect(Array.isArray(entries)).toBe(true);
      expect(entries).toHaveLength(3);

      // Order preserved: the entries must align with `requested`
      // index-for-index. A regression that re-sorted by createdAt
      // (or any other stable order) would trip here even though the
      // SET equality would pass.
      expect((entries as Array<{ attachmentId: string }>).map((e) => e.attachmentId)).toEqual(
        requested,
      );

      for (const entry of entries as Array<{
        attachmentId: string;
        originalUrl: string;
        originalDekMaterial: string;
        ciphertextSizeBytes: number;
        thumbUrl?: string;
        thumbDekMaterial?: string;
        ciphertextThumbSizeBytes?: number;
      }>) {
        expect(typeof entry.originalUrl).toBe('string');
        expect(typeof entry.originalDekMaterial).toBe('string');
        // 32 bytes after base64-decode — the AES-256-GCM key shape.
        expect(Buffer.from(entry.originalDekMaterial, 'base64').length).toBe(32);
        expect(typeof entry.ciphertextSizeBytes).toBe('number');
        expect(entry.ciphertextSizeBytes).toBeGreaterThan(0);
      }

      // Photos additionally carry the thumbnail triple; binary entries
      // do not. Find them by id and pin per-shape.
      const photoEntry0 = (
        entries as Array<{
          attachmentId: string;
          thumbUrl?: string;
          thumbDekMaterial?: string;
          ciphertextThumbSizeBytes?: number;
        }>
      ).find((e) => e.attachmentId === photoIds[0])!;
      expect(typeof photoEntry0.thumbUrl).toBe('string');
      expect(typeof photoEntry0.thumbDekMaterial).toBe('string');
      expect(Buffer.from(photoEntry0.thumbDekMaterial!, 'base64').length).toBe(32);
      expect(typeof photoEntry0.ciphertextThumbSizeBytes).toBe('number');

      const binEntry = (
        entries as Array<{
          attachmentId: string;
          thumbUrl?: string;
          thumbDekMaterial?: string;
          ciphertextThumbSizeBytes?: number;
        }>
      ).find((e) => e.attachmentId === binId)!;
      // For non-photo rows the thumbnail fields are omitted (undefined)
      // or null — both shapes are admissible per the spec design note
      // "null for non-photo".
      expect(binEntry.thumbUrl == null).toBe(true);
      expect(binEntry.thumbDekMaterial == null).toBe(true);
      expect(binEntry.ciphertextThumbSizeBytes == null).toBe(true);
    });

    it('does NOT return wrappedDek / wrappedThumbDek in the bulk-fetch response (wrapped envelope confidentiality boundary)', async () => {
      // api.md §14.2.11 design note "Wrapped-envelope confidentiality
      // boundary" — only the *unwrapped* DEK leaves the server, never
      // the wrapped envelope. A regression that surfaced the wrapped
      // bytes alongside the URL would let any caller bypass the
      // server-side unwrap path.
      const ids = await seedReadyAttachments(projectId, [
        { sizeBytes: 100, kind: 'photo', mimeType: 'image/jpeg', label: 'foto' },
      ]);
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/bulk-fetch`, {
        attachmentIds: ids,
      });
      expect(res.statusCode).toBe(200);
      const text = res.body; // raw text body — covers both top-level
      // and nested-under-data shapes
      expect(text).not.toContain('wrappedDek');
      expect(text).not.toContain('wrappedThumbDek');
      expect(text).not.toContain('wrapped_dek');
      expect(text).not.toContain('wrapped_thumb_dek');
    });

    it('rejects duplicate ids in the request body with 422 VALIDATION_ERROR (no partial-serve)', async () => {
      // Server-side dedup would silently collapse the response to
      // fewer entries than requested, breaking the SW's index-aligned
      // progress accounting. Surface duplicates as a distinct
      // validation error so the UI can show a clear message.
      const [readyId] = await seedReadyAttachments(projectId, [{ sizeBytes: 100 }]);
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/bulk-fetch`, {
        attachmentIds: [readyId, readyId, readyId],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('returns 500 SERVER_ERROR when an envelope in the batch cannot be unwrapped (defense-in-depth)', async () => {
      // api.md §14.2.11 error paths: any unwrap failure in a bulk-fetch
      // batch surfaces as 500 SERVER_ERROR (defense-in-depth — the
      // boot probe blocks startup without the binary identity, so this
      // should never be reachable). The single documented per-row 422
      // surface is `download-url`, not bulk. Driving this requires a
      // ready row with a corrupt envelope.
      const attId = crypto.randomUUID();
      const corrupted = Buffer.from(
        'this-is-not-a-valid-age-envelope-' + crypto.randomUUID(),
      ).toString('base64');
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             ciphertext_size_bytes,
             original_key, thumb_key, has_thumbnail,
             wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
          VALUES (${attId}, ${projectId}, 'ready', 'binary', 'sonstiges',
                  'corrupt-bulk.pdf', 'application/pdf', 1000,
                  1064,
                  ${`attachments/${projectId}/${attId}.orig`}, NULL, FALSE,
                  ${corrupted}, NULL, 1)
        `);
      } finally {
        await pool.end();
      }
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/bulk-fetch`, {
        attachmentIds: [attId],
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('SERVER_ERROR');
    });

    it('returns 500 SERVER_ERROR on a row whose wrappedDekVersion is unknown (envelope-format guard)', async () => {
      // Bulk-fetch counterpart to the download-url v=2 test below.
      // The unwrap-time format-discriminator gate (ADR-0024 / AC-244)
      // must fire BEFORE `age` is invoked so a future format never
      // silently decodes under the v1 parser. api.md §14.2.11 surfaces
      // any bulk-fetch unwrap failure as 500 SERVER_ERROR; the per-row
      // 422 surface is `download-url` only. Direct DB seed so the
      // synthetic version travels exactly as a corrupted import row would.
      const recipient = process.env.BINARY_AGE_RECIPIENT;
      const identityPath = process.env.BINARY_AGE_IDENTITY_PATH;
      if (!recipient || !identityPath) {
        throw new Error('binary identity env vars not configured for test fork');
      }
      const identity = readFileSync(identityPath, 'utf-8').trim();
      const service = new KeyEnvelopeService({ recipient, identity });
      const dek = crypto.randomBytes(32);
      const wrappedBytes = await service.wrap(dek);
      const wrappedBase64 = Buffer.from(wrappedBytes).toString('base64');

      const attId = crypto.randomUUID();
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             ciphertext_size_bytes,
             original_key, thumb_key, has_thumbnail,
             wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
          VALUES (${attId}, ${projectId}, 'ready', 'binary', 'sonstiges',
                  'future-format-bulk.pdf', 'application/pdf', 1000,
                  1064,
                  ${`attachments/${projectId}/${attId}.orig`}, NULL, FALSE,
                  ${wrappedBase64}, NULL, 2)
        `);
      } finally {
        await pool.end();
      }
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/bulk-fetch`, {
        attachmentIds: [attId],
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('SERVER_ERROR');
    });
  });

  // -------------------------------------------------------------------
  // AC-225 — Error envelopes for upload-failure categories.
  //
  // Client behavior pivots on these codes (ui/behavior.md §9.5 +
  // ui/index.md §8.1.2 banner). Pinning them here ensures the banner
  // contract stays stable as the server evolves.
  // -------------------------------------------------------------------
  describe('AC-225: upload-failure error envelope categories', () => {
    it('unauthenticated init returns 401 UNAUTHENTICATED', async () => {
      // authPost with empty token omits the cookie; Fastify rejects at
      // the auth middleware before the route-level permission check.
      const res = await authPost(
        '',
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHENTICATED');
    });

    it('worker init on an unassigned project returns 403 NOT_PERMITTED', async () => {
      const unassignedId = await seededProjectIdUnassigned(ownerToken);
      const res = await authPost(
        workerToken,
        `/api/projects/${unassignedId}/attachments/init`,
        photoInit(unassignedId),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('init against a non-existent project id returns 404 NOT_FOUND', async () => {
      const missingId = '00000000-0000-0000-0000-00000000abcd';
      const res = await authPost(
        ownerToken,
        `/api/projects/${missingId}/attachments/init`,
        photoInit(missingId),
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('delete on a non-existent attachment id returns 404 NOT_FOUND', async () => {
      const missingId = '00000000-0000-0000-0000-00000000bbbb';
      const res = await authDelete(
        ownerToken,
        `/api/projects/${projectId}/attachments/${missingId}`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------
  // Papierkorb — soft-hide round-trip (ADR-0022).
  //
  // Covers AC-232 (delete is a soft-hide: status flips ready→hidden with
  // hiddenAt stamped), AC-233 (restore flips hidden→ready and re-issues
  // version-ids via copyFromVersion, and is allowed on archived projects
  // where hide is not), and AC-235 (the trash listing surfaces hidden
  // rows, gated on `attachment:trash`).
  //
  // Verifies the full hide→trash→restore cycle exercises the new wire:
  // delete writes status='hidden' + hiddenAt; the trash listing surfaces
  // it; restore returns it to ready with freshly-issued version-ids.
  // Permission gate (`attachment:trash`) keeps workers off the trash
  // surface entirely.
  // -------------------------------------------------------------------
  describe('Papierkorb — soft-hide round-trip', () => {
    async function seedReadyAttachment(): Promise<string> {
      const init = photoInit(projectId);
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        init,
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();
      // Ciphertext-shaped uploads under the sentinel content-type
      // so HEAD verification at complete-time passes (AC-212).
      await s.upload(
        body.attachment.originalKey,
        ciphertextBuffer(init.ciphertextSizeBytes),
        'application/octet-stream',
      );
      await s.upload(
        body.attachment.thumbKey,
        ciphertextBuffer(init.ciphertextThumbSizeBytes),
        'application/octet-stream',
      );
      const completeRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(completeRes.statusCode).toBe(200);
      return body.attachment.id;
    }

    it('hide → trash → restore round-trip: status flips, version-ids re-issued', async () => {
      const attId = await seedReadyAttachment();
      const beforeVersions = await fetchAttachmentVersions(attId);
      expect(beforeVersions?.versionId).toMatch(/.+/);

      // Hide.
      const hideRes = await authDelete(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}`,
      );
      expect(hideRes.statusCode).toBe(204);

      const hiddenStatus = await fetchAttachmentStatus(attId);
      expect(hiddenStatus).toBe('hidden');

      // Trash listing contains the row, with hiddenAt populated.
      const trashRes = await authGet(ownerToken, `/api/projects/${projectId}/attachments/trash`);
      expect(trashRes.statusCode).toBe(200);
      const trashBody = trashRes.json() as { data: Attachment[] };
      const found = trashBody.data.find((it) => it.id === attId);
      expect(found).toBeDefined();
      expect(found!.status).toBe('hidden');
      expect(found!.hiddenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Live list excludes it.
      const listRes = await authGet(ownerToken, `/api/projects/${projectId}/attachments`);
      expect(listRes.statusCode).toBe(200);
      const listBody = listRes.json() as { data: Attachment[] };
      expect(listBody.data.some((it) => it.id === attId)).toBe(false);

      // Restore.
      const restoreRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/restore`,
      );
      expect({ statusCode: restoreRes.statusCode, body: restoreRes.json() }).toEqual({
        statusCode: 200,
        body: expect.objectContaining({ status: 'ready' }),
      });
      const restored = restoreRes.json() as Attachment;
      expect(restored.status).toBe('ready');
      expect(restored.hiddenAt).toBeNull();

      // Fresh version-ids — copyFromVersion produced new current versions.
      const afterVersions = await fetchAttachmentVersions(attId);
      expect(afterVersions?.versionId).toMatch(/.+/);
      // The new ones may equal the old ones only if the bucket is
      // unversioned (test mis-config); on a versioned bucket every PUT
      // produces a fresh id, including the server-side copy.
      expect(afterVersions?.versionId).not.toBe(beforeVersions?.versionId);

      // Trash listing no longer carries it.
      const trashAfter = await authGet(ownerToken, `/api/projects/${projectId}/attachments/trash`);
      expect((trashAfter.json() as { data: Attachment[] }).data.some((it) => it.id === attId)).toBe(
        false,
      );
    });

    it('restore on a ready row returns 409 CONFLICT (idempotent guard)', async () => {
      const attId = await seedReadyAttachment();
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/restore`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');
    });

    // -----------------------------------------------------------------
    // Missing-row restore — pins AC-234's `404 NOT_FOUND` clause for the
    // post-purge case (e.g. the hidden reaper from §6.12 already removed
    // the row by the time the user clicks Restore on a stale Papierkorb
    // listing). 404 over 409: the row is gone forever, retry is futile,
    // and 409 is reserved for transient conflicts the caller can resolve.
    // -----------------------------------------------------------------
    it('restore on a non-existent attachment id returns 404 NOT_FOUND', async () => {
      const ghost = crypto.randomUUID();
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${ghost}/restore`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    // -----------------------------------------------------------------
    // Bytes-gone race — covered as a service-level unit test in
    // `attachments-restore-bytes-gone.test.ts`. The integration shape
    // requires destroying a specific object version, which the app
    // (and test) credentials cannot do by design (AC-237 capability
    // profile). The unit test stubs `copyFromVersion` to throw
    // `StorageObjectNotFoundError` and asserts the resulting `AppError`
    // is `410 GONE` — the same mapping the global setErrorHandler turns
    // into the HTTP response.
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // CAS-loss atomicity. Two concurrent restores on the same hidden
    // row: one must succeed (200, 'ready'), one must lose
    // the CAS (409). After the dust settles, the row's persisted
    // version_id MUST equal storage's actual current version — i.e. the
    // failed restore must NOT have produced an orphan current version.
    //
    // This pins the atomicity invariant: storage advances ONLY when the
    // DB CAS commits. A regression that runs copyFromVersion before the
    // CAS would leave the bucket's current version pointing at the
    // loser's copy while the DB version_id reflects the winner's — a
    // silent storage/DB drift that tests on the happy path can't catch.
    // -----------------------------------------------------------------
    it('two concurrent restores: one wins, one loses CAS, storage and DB stay consistent', async () => {
      const attId = await seedReadyAttachment();

      // Hide the row first so both concurrent calls hit the restore path.
      const hideRes = await authDelete(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}`,
      );
      expect(hideRes.statusCode).toBe(204);

      // Read the keys so we can probe storage afterward.
      const keys = await fetchAttachmentKeys(attId);
      expect(keys).not.toBeNull();

      // Fire both restores in parallel. Postgres will serialize the
      // CAS UPDATEs at the row-level lock acquired by the first to
      // reach `markRestored`; the second blocks, then finds status
      // already flipped to 'ready' and returns null (CAS-loss).
      const [r1, r2] = await Promise.all([
        authPost(ownerToken, `/api/projects/${projectId}/attachments/${attId}/restore`),
        authPost(ownerToken, `/api/projects/${projectId}/attachments/${attId}/restore`),
      ]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes).toEqual([200, 409]);

      // Storage's actual current version of the original key —
      // determined by HEAD, which reports the bucket's current
      // VersionId. With the atomicity fix, exactly one copyFromVersion
      // ran (the winner's), so this version_id is the winner's.
      const s = storage();
      const head = await s.headObject(keys!.originalKey);

      // The DB's persisted version_id must match storage. Mismatch ⇒
      // an orphan current version exists from the failed restore =>
      // C-DATA invariant violated.
      const dbVersions = await fetchAttachmentVersions(attId);
      expect(dbVersions?.versionId).toBe(head.versionId);
    });

    it('worker is rejected from the trash listing with 403 NOT_PERMITTED', async () => {
      const res = await authGet(workerToken, `/api/projects/${projectId}/attachments/trash`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker is rejected from restore with 403 NOT_PERMITTED', async () => {
      const attId = await seedReadyAttachment();
      const res = await authPost(
        workerToken,
        `/api/projects/${projectId}/attachments/${attId}/restore`,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    // -----------------------------------------------------------------
    // Restore — error-semantic distinctions.
    //
    // 422 (data integrity, structurally unrestorable) vs 409 (transient
    // race, retry resolves) carries operator meaning: an operator
    // fielding 422 inspects the row; an operator fielding 409 retries.
    // Reusing 409 for both buries the integrity case under the noise
    // of routine race conflicts.
    // -----------------------------------------------------------------
    it('returns 422 VALIDATION_ERROR when a hidden row has no version_id (data integrity)', async () => {
      // Seed a hidden row directly with version_id=NULL — simulates a
      // legacy hide before version capture, or any future regression
      // that drops the version capture. Restore must surface this as
      // 422, not 409: 409 says "retry" and the row will not become
      // restorable on retry.
      const attId = await seedHiddenAttachment(projectId, {
        versionId: null,
        thumbVersionId: null,
        hasThumbnail: false,
      });

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/restore`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      // The operator-visible message names the row id so the activity
      // feed entry is actionable without spelunking the DB.
      expect(res.json().message).toContain(attId);
    });

    it('returns 422 VALIDATION_ERROR when hasThumbnail=true and thumb_version_id is null', async () => {
      // Seed a hidden photo row with version_id set but
      // thumb_version_id null. Without the integrity check, the service
      // would silently restore only the original and the gallery
      // preview would be permanently lost.
      const attId = await seedHiddenAttachment(projectId, {
        versionId: 'fake-original-version-id',
        thumbVersionId: null,
        hasThumbnail: true,
      });

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/restore`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      // Distinct message from the original-side branch — names the
      // affected row id and identifies the missing field.
      const body = res.json();
      expect(body.message).toContain(attId);
      expect(body.message).toContain('thumb_version_id');
    });

    // -----------------------------------------------------------------
    // Restore on archived projects.
    //
    // Asymmetry by design: hide on archived stays forbidden (read-only
    // preview), restore on archived is permitted. Without the latter,
    // binaries in an archived project's trash would silently reap after
    // L days with no recovery path; archive is a reversible state,
    // destruction by lifecycle is not.
    //
    // Three arms:
    //   1. Restore against an archived project succeeds.
    //   2. Hide against an archived project still rejects (regression
    //      guard for the archive read-only invariant).
    //   3. The Papierkorb listing is callable on an archived project so
    //      the user can SEE what's recoverable.
    // -----------------------------------------------------------------
    it('restore on an archived project succeeds (hide is irreversible by lifecycle)', async () => {
      // Seed: ready attachment → hide → archive the project. Restore
      // must still succeed; without it, lifecycle would silently reap.
      const attId = await seedReadyAttachment();
      const hideRes = await authDelete(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}`,
      );
      expect(hideRes.statusCode).toBe(204);

      // Archive on a fresh project so we don't poison the shared one.
      // Move the (already-hidden) attachment over by re-uploading on a
      // new project, then archiving — simpler to spin a fresh one with
      // its own hidden row.
      const customersRes = await authGet(ownerToken, '/api/customers');
      const customers = customersRes.json().customers ?? customersRes.json().data;
      const customerId = customers[0].id;
      const createRes = await authPost(ownerToken, '/api/projects', {
        number: `${year}-REST-ARCH`,
        title: 'Restore-on-archived',
        customerId,
      });
      expect(createRes.statusCode).toBe(201);
      const archProjectId = createRes.json().id;

      // Seed a hidden row directly on the soon-to-be-archived project
      // so we don't depend on the upload pipeline's archive race.
      // version_id matches a real storage version we put in the bucket.
      // The bytes here are opaque ciphertext under the sentinel
      // content-type so the row's persisted `ciphertextSizeBytes`
      // matches what HEAD would observe (defensive — restore today
      // does not re-HEAD, but a future regression that did would not
      // be caught by a 'application/pdf'-shaped object).
      const archAttId = crypto.randomUUID();
      const originalKey = `attachments/${archProjectId}/${archAttId}.orig`;
      const s = storage();
      const ciphertext = ciphertextBuffer(74);
      const putRes = await s.upload(originalKey, ciphertext, 'application/octet-stream');
      expect(putRes).toBeDefined();
      // Read back the version-id of what we just put — this becomes the
      // source for copyFromVersion.
      const head = await s.headObject(originalKey);
      expect(head.versionId).toBeDefined();
      // Synthetic envelope — restore copyFromVersion does not unwrap; the
      // archive-restore arm verifies the row flips back to ready, not
      // that the bytes can be decrypted afterwards.
      const wrappedDek = Buffer.alloc(192, 0x42).toString('base64');
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             ciphertext_size_bytes,
             original_key, thumb_key, has_thumbnail,
             wrapped_dek, wrapped_thumb_dek, wrapped_dek_version,
             version_id, thumb_version_id, hidden_at)
          VALUES (${archAttId}, ${archProjectId}, 'hidden', 'binary', 'sonstiges',
                  'arch-doc.pdf', 'application/pdf', 10,
                  ${ciphertext.length},
                  ${originalKey}, NULL, FALSE,
                  ${wrappedDek}, NULL, 1,
                  ${head.versionId!}, NULL, NOW())
        `);
      } finally {
        await pool.end();
      }

      // Archive the project.
      const archiveRes = await authDelete(ownerToken, `/api/projects/${archProjectId}`);
      expect(archiveRes.statusCode).toBe(200);

      // Restore must succeed despite archival — that's the whole point.
      const restoreRes = await authPost(
        ownerToken,
        `/api/projects/${archProjectId}/attachments/${archAttId}/restore`,
      );
      expect(restoreRes.statusCode).toBe(200);
      const restored = restoreRes.json() as Attachment;
      expect(restored.status).toBe('ready');
      expect(restored.hiddenAt).toBeNull();

      // Cleanup: avoid leaving the archived project hanging — leave the
      // shared `projectId` arm green. (The archived project itself can
      // stay; subsequent tests don't care.)
      void attId; // marker — unused in this arm
    });

    it('hide on an archived project is rejected (read-only preview invariant)', async () => {
      // Regression guard for the archive read-only contract. The
      // restore-on-archived fix must NOT have lifted the hide-side
      // gate.
      const customersRes = await authGet(ownerToken, '/api/customers');
      const customers = customersRes.json().customers ?? customersRes.json().data;
      const customerId = customers[0].id;
      const createRes = await authPost(ownerToken, '/api/projects', {
        number: `${year}-HIDE-ARCH`,
        title: 'Hide-on-archived rejected',
        customerId,
      });
      expect(createRes.statusCode).toBe(201);
      const archProjectId = createRes.json().id;

      // Seed a ready row on the project, then archive.
      const [hideAttId] = await seedReadyAttachments(archProjectId, [{ sizeBytes: 100 }]);
      const archiveRes = await authDelete(ownerToken, `/api/projects/${archProjectId}`);
      expect(archiveRes.statusCode).toBe(200);

      // Hide must reject — the gate stays.
      const hideRes = await authDelete(
        ownerToken,
        `/api/projects/${archProjectId}/attachments/${hideAttId}`,
      );
      expect(hideRes.statusCode).toBe(404);
      expect(hideRes.json().code).toBe('NOT_FOUND');
    });

    it('Papierkorb listing is callable on an archived project (user must see what is recoverable)', async () => {
      // The user must be able to inspect the archived project's trash
      // before deciding to restore. This pairs with the restore-on-
      // archived behaviour — listing without restore would be a
      // useless cul-de-sac.
      const customersRes = await authGet(ownerToken, '/api/customers');
      const customers = customersRes.json().customers ?? customersRes.json().data;
      const customerId = customers[0].id;
      const createRes = await authPost(ownerToken, '/api/projects', {
        number: `${year}-LIST-ARCH`,
        title: 'List-archived-trash',
        customerId,
      });
      expect(createRes.statusCode).toBe(201);
      const archProjectId = createRes.json().id;

      // Seed one hidden row so the listing has something visible.
      const archAttId = await seedHiddenAttachment(archProjectId, {
        versionId: 'fake-vid',
        thumbVersionId: null,
        hasThumbnail: false,
      });

      const archiveRes = await authDelete(ownerToken, `/api/projects/${archProjectId}`);
      expect(archiveRes.statusCode).toBe(200);

      const trashRes = await authGet(
        ownerToken,
        `/api/projects/${archProjectId}/attachments/trash`,
      );
      expect(trashRes.statusCode).toBe(200);
      const body = trashRes.json() as { data: Attachment[] };
      expect(body.data.some((it) => it.id === archAttId)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Hide — storage-first atomicity.
  //
  // The atomicity contract: storage hide runs BEFORE the DB CAS. A
  // storage failure throws, the DB row stays in `ready`, and no
  // `attachment:hide` audit row is written. The user retries; storage
  // hide is idempotent (S3 DeleteObject without VersionId on a
  // versioned bucket).
  //
  // The earlier (broken) shape ran storage AFTER the CAS commit and
  // swallowed errors — a storage outage left a `hidden` row whose
  // backing object was still the bucket's CURRENT version. The
  // bucket lifecycle reaps NONCURRENT versions only, so the file
  // would persist indefinitely with no UI affordance to retry.
  //
  // This block bypasses the route layer and constructs `AttachmentService`
  // directly so a flaky storage proxy can inject the failure.
  // -------------------------------------------------------------------
  describe('Hide — storage-first atomicity', () => {
    it('storage.hide failure leaves the row in ready, writes no audit row, and surfaces the error', async () => {
      // Seed one ready row directly. The seeded row has no real
      // backing bytes, but the contract under test never reaches
      // storage successfully — the proxy throws on the first call.
      const [attId] = await seedReadyAttachments(projectId, [{ sizeBytes: 100 }]);

      // Resolve the owner user id from the same DB the service will
      // see — the service expects a real user id for the audit
      // actor, even though no audit row should be written here.
      const { db, pool } = createDatabase();
      let ownerId: string;
      try {
        const res = await db.execute(
          sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
        );
        const row = res.rows[0] as { id: string } | undefined;
        if (!row) throw new Error('owner user missing from seed');
        ownerId = row.id;
      } finally {
        await pool.end();
      }

      // Audit-row count snapshot — under the new contract a storage
      // failure must produce no audit row at all.
      const auditBefore = await countAuditRows();

      // Build a storage proxy that throws on `hide` but delegates
      // every other call. Mirrors the proxy pattern used in
      // attachments-bulk-download-reaper.test.ts.
      const realStorage = storage();
      const flakyStorage: AttachmentStorageClient = {
        ...realStorage,
        hide: async () => {
          throw new Error('simulated-storage-flake');
        },
      };

      // Construct the service with the flaky storage; reuse the
      // app's DB. We bypass the route layer because the live route
      // wiring uses the real storage client.
      const { db: serviceDb, pool: servicePool } = createDatabase();
      try {
        const service = new AttachmentService({
          db: serviceDb,
          storage: flakyStorage,
          binaryAgeRecipient: process.env.BINARY_AGE_RECIPIENT ?? '',
          binaryAgeIdentityPath: process.env.BINARY_AGE_IDENTITY_PATH ?? '',
        });
        const owner: AuthUser = {
          id: ownerId,
          username: SEED_USERS.owner.username,
          displayName: SEED_USERS.owner.displayName,
          roles: [...SEED_USERS.owner.roles],
          email: null,
          themePreference: 'system',
          pushMuted: false,
        };
        const noopLog = { info: () => {}, error: () => {} };

        await expect(
          service.hideAttachment(owner, projectId, attId, noopLog, null),
        ).rejects.toThrow('simulated-storage-flake');
      } finally {
        await servicePool.end();
      }

      // Row stays in `ready` — no DB CAS happened.
      const status = await fetchAttachmentStatus(attId);
      expect(status).toBe('ready');

      // No audit row was written.
      const auditAfter = await countAuditRows();
      expect(auditAfter).toBe(auditBefore);
    });
  });

  // -------------------------------------------------------------------
  // AC-241 — Download-URL endpoint shape: `{ url, expiresAt, dekMaterial }`.
  // The server unwraps `wrappedDek` (or `wrappedThumbDek` for
  // `variant=thumbnail`) per request using the operator's binary `age`
  // identity; the unwrapped DEK is never persisted server-side. Auth
  // happens at the scope layer (attachments-scope.test.ts).
  // -------------------------------------------------------------------
  describe('AC-241: download-url returns presigned URL + unwrapped DEK', () => {
    it('returns { url, expiresAt, dekMaterial, mimeType } for variant=original', async () => {
      const [id] = await seedReadyAttachments(projectId, [
        { sizeBytes: 100, kind: 'photo', mimeType: 'image/jpeg', label: 'foto' },
      ]);
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${id}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.url).toBe('string');
      expect(typeof body.expiresAt).toBe('string');
      expect(typeof body.dekMaterial).toBe('string');
      // 32 bytes after base64-decode — the AES-256-GCM key shape.
      const decoded = Buffer.from(body.dekMaterial, 'base64');
      expect(decoded.length).toBe(32);
      // Plaintext mimeType drives the SW's Content-Type so PDF
      // previews render inline in `<iframe>` instead of triggering
      // downloads. For an `original` variant it must match the row's
      // stored mimeType (image/jpeg here).
      expect(body.mimeType).toBe('image/jpeg');
      // Wrapped envelope is NEVER on the response — confidentiality
      // boundary per api.md §14.2.11. A regression that surfaced the
      // wrapped form alongside the unwrapped one would be a valid
      // 200 by status but wrong by shape.
    });

    it('returns mimeType=image/webp for variant=thumbnail regardless of original mime', async () => {
      // Thumbnails are produced by the photo-thumbnail pipeline and
      // are always WebP, even when the original is image/png or
      // image/jpeg. The SW relies on a stable thumbnail mime to render
      // the gallery placeholder.
      const [id] = await seedReadyAttachments(projectId, [
        { sizeBytes: 100, kind: 'photo', mimeType: 'image/png', label: 'foto' },
      ]);
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${id}/download-url?variant=thumbnail`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().mimeType).toBe('image/webp');
    });

    it('returns { url, expiresAt, dekMaterial } for variant=thumbnail (using wrappedThumbDek) — end-to-end DEK fidelity', async () => {
      // End-to-end fidelity arm — drives init→complete→download-url
      // with two CLIENT-SUPPLIED DEKs. The route must return exactly
      // those bytes back via download-url for the matching variant
      // (original → originalDek, thumbnail → thumbDek). A regression
      // that swapped the two columns, or returned a constant DEK for
      // both variants, would surface here as a byte-equality failure.
      //
      // Seed-driven shape-only tests can't catch the column-swap
      // regression because the seed itself doesn't pin which 32-byte
      // value belongs to which variant.
      const originalDek = crypto.randomBytes(32);
      const thumbDek = crypto.randomBytes(32);

      const initBody = {
        ...photoInit(projectId),
        dekMaterial: originalDek.toString('base64'),
        thumbDekMaterial: thumbDek.toString('base64'),
      };
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        initBody,
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const attId = body.attachment.id as string;

      // PUT ciphertext bytes under the issued keys so complete()'s HEAD
      // verify passes. Sentinel content-type per the e2e contract.
      const s = storage();
      await s.upload(
        body.attachment.originalKey,
        ciphertextBuffer(initBody.ciphertextSizeBytes),
        'application/octet-stream',
      );
      await s.upload(
        body.attachment.thumbKey,
        ciphertextBuffer(initBody.ciphertextThumbSizeBytes),
        'application/octet-stream',
      );

      const completeRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(completeRes.statusCode).toBe(200);

      const original = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/download-url?variant=original`,
      );
      const thumb = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/download-url?variant=thumbnail`,
      );
      expect(original.statusCode).toBe(200);
      expect(thumb.statusCode).toBe(200);

      const originalReturned = Buffer.from(original.json().dekMaterial, 'base64');
      const thumbReturned = Buffer.from(thumb.json().dekMaterial, 'base64');

      // Both have the AES-256-GCM shape.
      expect(originalReturned.length).toBe(32);
      expect(thumbReturned.length).toBe(32);

      // Variant fidelity — the route returns the column matching the
      // requested variant. A regression that swapped columns or
      // returned a constant DEK for both would fail at byte equality.
      expect(originalReturned.equals(originalDek)).toBe(true);
      expect(thumbReturned.equals(thumbDek)).toBe(true);

      // And consequently the two variants surface different DEKs —
      // api.md §14.2.11 "thumbnails are independent ciphertext objects
      // with their own DEKs". This is now provable from the explicit
      // input DEKs, not just the seed shape.
      expect(originalReturned.equals(thumbReturned)).toBe(false);
    });

    it('does NOT persist the unwrapped DEK server-side (no caller-visible state change after the call)', async () => {
      // The unwrapped DEK is computed per-request from the row's
      // wrappedDek and the in-memory binary identity; the row's
      // post-call shape is byte-identical to its pre-call shape.
      // A regression that cached the unwrapped DEK on the row (e.g.
      // for performance) would leak the entire crypto perimeter on
      // a DB-only adversary.
      const [id] = await seedReadyAttachments(projectId, [
        { sizeBytes: 100, kind: 'photo', mimeType: 'image/jpeg', label: 'foto' },
      ]);
      const before = await fetchAttachmentRowSnapshot(id);
      await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${id}/download-url?variant=original`,
      );
      const after = await fetchAttachmentRowSnapshot(id);
      // Wrapped envelopes unchanged.
      expect(after.wrappedDek).toBe(before.wrappedDek);
      expect(after.wrappedThumbDek).toBe(before.wrappedThumbDek);
      // No new unwrapped-DEK column appeared.
      expect(after.unwrappedDek).toBeUndefined();
    });

    it('returns 404 NOT_FOUND for a hidden row (status not addressable through download-url)', async () => {
      // Hidden rows have a delete marker on the bucket's current
      // version — issuing a presigned GET would resolve to 404 from
      // storage. Mirror that at the route level so the SW sees a
      // consistent 404 from the app.
      const id = await seedHiddenAttachment(projectId, {
        versionId: 'fake-version-id',
        thumbVersionId: null,
        hasThumbnail: false,
      });
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${id}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('returns 422 VALIDATION_ERROR for an unknown variant', async () => {
      const [id] = await seedReadyAttachments(projectId, [{ sizeBytes: 100 }]);
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${id}/download-url?variant=unknown`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('returns 422 VALIDATION_ERROR for variant=thumbnail on a non-photo row', async () => {
      const [id] = await seedReadyAttachments(projectId, [
        { sizeBytes: 100, kind: 'binary', mimeType: 'application/pdf', label: 'rechnung' },
      ]);
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${id}/download-url?variant=thumbnail`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    // -----------------------------------------------------------------
    // Pending-row invisibility. `listByProject` only surfaces ready
    // rows; `issueDownloadUrl` must mirror that, or a caller could
    // fetch a presigned GET for partially-uploaded bytes before the
    // HEAD-verify gate ran. 404 matches the reaper-removed branch
    // from the caller's point of view.
    // -----------------------------------------------------------------
    it('returns 404 NOT_FOUND when variant=original and the row is pending', async () => {
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const pendingId = initRes.json().attachment.id;
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${pendingId}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('returns 404 NOT_FOUND when variant=thumbnail and the row is pending', async () => {
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const pendingId = initRes.json().attachment.id;
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${pendingId}/download-url?variant=thumbnail`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------
  // AC-244 (server side) — per-row DEK_UNWRAP_FAILED on download-url.
  //
  // Per api.md §14.2.11 download-url error paths: a per-row envelope
  // unwrap failure (corrupt envelope, recipient-mismatch from a
  // partial key rotation, or any other unwrap-side failure) returns
  // `422 VALIDATION_ERROR` with `code = DEK_UNWRAP_FAILED`. The SW
  // translates the code into the "Schlüssel nicht verfügbar"
  // placeholder render path (AC-244 component-tier coverage in
  // `BinaryList.test.tsx` / `PhotoGallery.test.tsx`).
  //
  // Driving this server-side requires a row whose `wrappedDek` cannot
  // be unwrapped by the loaded binary identity. We seed a row with a
  // wrapped envelope of garbage bytes — the unwrap call against ANY
  // identity must fail, regardless of which keypair the test environment
  // loaded. (Recipient-mismatch via a different keypair is the other
  // test path; this byte-corruption arm is provider-agnostic.)
  // -------------------------------------------------------------------
  describe('AC-244 server side: DEK_UNWRAP_FAILED on download-url for an unwrappable row', () => {
    it('returns 422 with code DEK_UNWRAP_FAILED when wrappedDek is byte-corrupt', async () => {
      // Seed a ready row directly with a `wrappedDek` that is NOT a
      // valid `age` envelope. The unwrap pipeline rejects, the route
      // surfaces the row-scoped failure as 422 with the documented
      // code.
      const attId = crypto.randomUUID();
      const corrupted = Buffer.from(
        'this-is-not-a-valid-age-envelope-' + crypto.randomUUID(),
      ).toString('base64');
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             ciphertext_size_bytes,
             original_key, thumb_key, has_thumbnail,
             wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
          VALUES (${attId}, ${projectId}, 'ready', 'binary', 'sonstiges',
                  'corrupt-envelope.pdf', 'application/pdf', 1000,
                  1064,
                  ${`attachments/${projectId}/${attId}.orig`}, NULL, FALSE,
                  ${corrupted}, NULL, 1)
        `);
      } finally {
        await pool.end();
      }

      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/download-url?variant=original`,
      );
      // Spec pins 422 with code DEK_UNWRAP_FAILED — the SW's branch
      // discriminator. A 500 here would mean the route swallowed the
      // unwrap failure into a generic surface, depriving the SW of
      // the placeholder branch and degrading every other row in the
      // list (the SW would treat it as a wholesale identity-not-loaded
      // case and refuse to render anything).
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('DEK_UNWRAP_FAILED');
    });

    it('returns 422 with code DEK_UNWRAP_FAILED for variant=thumbnail when wrappedThumbDek is byte-corrupt', async () => {
      // Symmetric arm — thumbnail-side envelope corruption surfaces
      // the same code so the SW handles original / thumbnail with
      // one branch.
      const attId = crypto.randomUUID();
      // Synthetic envelopes — this arm intentionally exercises the
      // unwrap-failure branch on the THUMBNAIL path. The original
      // envelope's wrap quality is irrelevant: variant=thumbnail
      // unwraps `wrapped_thumb_dek`, which is the corrupt one here.
      const validOrig = Buffer.alloc(192, 0).toString('base64');
      const corruptThumb = Buffer.from('not-an-age-envelope').toString('base64');
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             ciphertext_size_bytes, ciphertext_thumb_size_bytes,
             original_key, thumb_key, has_thumbnail,
             wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
          VALUES (${attId}, ${projectId}, 'ready', 'photo', 'foto',
                  'corrupt-thumb.jpg', 'image/jpeg', 5000,
                  5064, 1064,
                  ${`attachments/${projectId}/${attId}.orig`},
                  ${`attachments/${projectId}/${attId}.thumb`}, TRUE,
                  ${validOrig}, ${corruptThumb}, 1)
        `);
      } finally {
        await pool.end();
      }

      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/download-url?variant=thumbnail`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('DEK_UNWRAP_FAILED');
    });

    it('returns 422 with code DEK_UNWRAP_FAILED on a row whose wrappedDekVersion is unknown (envelope-format guard)', async () => {
      // Pin the unwrap-time format-discriminator gate (ADR-0024 / AC-244).
      // A row with a real-shaped envelope but a wrapped_dek_version other
      // than 1 must NOT silently unwrap with the current parser — the
      // service must refuse before invoking `age` so the operator can
      // identify rows on a legacy or future format. Direct DB seed so the
      // synthetic version travels exactly as a corrupted bulk-import row
      // would.
      const recipient = process.env.BINARY_AGE_RECIPIENT;
      const identityPath = process.env.BINARY_AGE_IDENTITY_PATH;
      if (!recipient || !identityPath) {
        throw new Error('binary identity env vars not configured for test fork');
      }
      const identity = readFileSync(identityPath, 'utf-8').trim();
      const service = new KeyEnvelopeService({ recipient, identity });
      const dek = crypto.randomBytes(32);
      const wrappedBytes = await service.wrap(dek);
      const wrappedBase64 = Buffer.from(wrappedBytes).toString('base64');

      const attId = crypto.randomUUID();
      const { db, pool } = createDatabase();
      try {
        // Seed a v=2 row — the envelope itself is a valid `age` envelope
        // for the loaded recipient, but the column says "format 2" and
        // the unwrap path must refuse to interpret its bytes under the
        // v1 parser. A regression that ignored the version column would
        // happily decrypt and surface the DEK.
        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             ciphertext_size_bytes,
             original_key, thumb_key, has_thumbnail,
             wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
          VALUES (${attId}, ${projectId}, 'ready', 'binary', 'sonstiges',
                  'future-format.pdf', 'application/pdf', 1000,
                  1064,
                  ${`attachments/${projectId}/${attId}.orig`}, NULL, FALSE,
                  ${wrappedBase64}, NULL, 2)
        `);
      } finally {
        await pool.end();
      }

      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/download-url?variant=original`,
      );
      // Same surface as a corrupt envelope — the SW renders the
      // "Schlüssel nicht verfügbar" placeholder for both classes
      // (operator condition vs. row data integrity); 422 with the
      // DEK_UNWRAP_FAILED code keeps the SW branch single.
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('DEK_UNWRAP_FAILED');
    });

    it('successfully unwraps a row whose wrappedDekVersion = 1 (happy-path control)', async () => {
      // Companion to the unknown-version arm above — pins that the
      // version=1 path remains the working one. Without this control,
      // the unknown-version test could pass for the wrong reason (the
      // unwrap failing for any seed-related cause). Here we wrap a real
      // DEK and assert the route returns it.
      const recipient = process.env.BINARY_AGE_RECIPIENT;
      const identityPath = process.env.BINARY_AGE_IDENTITY_PATH;
      if (!recipient || !identityPath) {
        throw new Error('binary identity env vars not configured for test fork');
      }
      const identity = readFileSync(identityPath, 'utf-8').trim();
      const service = new KeyEnvelopeService({ recipient, identity });
      const dek = crypto.randomBytes(32);
      const wrappedBytes = await service.wrap(dek);
      const wrappedBase64 = Buffer.from(wrappedBytes).toString('base64');

      const attId = crypto.randomUUID();
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             ciphertext_size_bytes,
             original_key, thumb_key, has_thumbnail,
             wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
          VALUES (${attId}, ${projectId}, 'ready', 'binary', 'sonstiges',
                  'v1-row.pdf', 'application/pdf', 1000,
                  1064,
                  ${`attachments/${projectId}/${attId}.orig`}, NULL, FALSE,
                  ${wrappedBase64}, NULL, 1)
        `);
      } finally {
        await pool.end();
      }

      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(200);
      const returned = Buffer.from(res.json().dekMaterial as string, 'base64');
      // Byte-equality — the route returned exactly the DEK we wrapped.
      expect(returned.equals(dek)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Filename validation + Content-Disposition — review of Fix 4.
  //
  // The service-boundary validator rejects control chars + path
  // separators so malicious bytes never land in the DB. The
  // Content-Disposition header is the second line of defence: even if
  // something bypassed the validator, header injection is prevented by
  // the ASCII-fallback sanitize and the UTF-8 extended form keeps
  // non-ASCII filenames (German umlauts, the common case) legible.
  // -------------------------------------------------------------------
  describe('Filename validation + Content-Disposition encoding', () => {
    it.each([
      ['CR', 'evil\r.pdf'],
      ['LF', 'evil\n.pdf'],
      ['null', 'evil\x00.pdf'],
      ['forward slash', 'evil/path.pdf'],
      ['backslash', 'evil\\path.pdf'],
    ])('rejects fileName containing %s with 422 VALIDATION_ERROR', async (_label, fileName) => {
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'sonstiges',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('accepts non-ASCII filenames and emits an RFC 5987 Content-Disposition on download', async () => {
      // German umlauts are the common case — any sanitizer that strips
      // them here would break half the customer's filenames. Init
      // must accept the name, complete must preserve it, and the
      // download-url's presigned GET must carry a `filename*=UTF-8''`
      // parameter (or at minimum the percent-encoded bytes) so the
      // browser's Save-As dialog shows the original characters.
      //
      // S3 presigned URLs deliver the disposition via the
      // `response-content-disposition` query param, which the signer
      // percent-encodes once on its own. A single `decodeURIComponent`
      // therefore yields the disposition we built — further characters
      // in the disposition's UTF-8 form (e.g. `%C3%BC`) stay encoded
      // because they belong to the header body, not the URL envelope.
      const umlautName = 'Angebot Müller.pdf';
      const bytes = Buffer.from('test-bytes', 'utf-8');
      const ids = await seedReadyAttachmentsWithBytes(projectId, [
        { bytes, filename: umlautName, mimeType: 'application/pdf' },
      ]);
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${ids[0]}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(200);
      const url = res.json().url as string;
      // The disposition value itself — after one round of URL decoding —
      // must carry the RFC 5987 extended parameter so browsers pick up
      // the non-ASCII characters.
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain("filename*=UTF-8''");
      // The UTF-8 bytes of `ü` (U+00FC) are `0xC3 0xBC`. Because
      // `encodeURIComponent('ü')` produces `%C3%BC`, and the URL
      // envelope then encodes each `%` as `%25`, the raw URL contains
      // `%25C3%25BC` (percent-of-percent). The once-decoded string
      // reveals the original `%C3%BC` form.
      expect(decoded).toContain('%C3%BC');
    });

    it('accepts a non-ASCII filename at init and round-trips it to the row', async () => {
      // Only control chars + path separators are rejected; German
      // umlauts are legitimate input and must survive init unchanged.
      // Complete() would need backing bytes to flip to ready, which is
      // out of scope for this arm — the download-side Content-Disposition
      // assertion is covered by the previous test via
      // `seedReadyAttachmentsWithBytes`.
      const initRes = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: 'Angebot Müller.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'angebot',
        hasThumbnail: false,
        dekMaterial: freshDekMaterial(),
        ciphertextSizeBytes: 164,
        ciphertextContentMd5: STUB_MD5_BASE64,
      });
      expect(initRes.statusCode).toBe(201);
      expect(initRes.json().attachment.fileName).toBe('Angebot Müller.pdf');
    });
  });
});

// ---------------------------------------------------------------------
// Local helpers — direct DB access so we don't couple fixture setup to
// not-yet-implemented endpoints. The attachment table ships in the
// baseline migration (src/server/db/schema.ts), so raw inserts run
// even before the service layer exists.
// ---------------------------------------------------------------------

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

async function countAuditRows(): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
    return (res.rows[0] as { c: number }).c;
  } finally {
    await pool.end();
  }
}

async function fetchAttachmentKeys(
  id: string,
): Promise<{ originalKey: string; thumbKey: string | null } | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT original_key, thumb_key FROM attachments WHERE id = ${id} LIMIT 1`,
    );
    const row = res.rows[0] as { original_key: string; thumb_key: string | null } | undefined;
    if (!row) return null;
    return { originalKey: row.original_key, thumbKey: row.thumb_key };
  } finally {
    await pool.end();
  }
}

async function fetchAttachmentVersions(
  id: string,
): Promise<{ versionId: string | null; thumbVersionId: string | null } | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT version_id, thumb_version_id FROM attachments WHERE id = ${id} LIMIT 1`,
    );
    const row = res.rows[0] as
      { version_id: string | null; thumb_version_id: string | null } | undefined;
    if (!row) return null;
    return { versionId: row.version_id, thumbVersionId: row.thumb_version_id };
  } finally {
    await pool.end();
  }
}

/**
 * Read the wrapped envelopes (and any unwrapped-DEK column the
 * implementation might have introduced) for a single attachment row.
 * Used by the AC-241 "no server-side persistence of the unwrapped
 * DEK" arm to compare the row before-and-after a download-url call.
 *
 * The `unwrappedDek` field is keyed off a hypothetical column that
 * MUST NOT exist (a regression that introduced one would surface it
 * here as a defined value instead of `undefined`).
 */
async function fetchAttachmentRowSnapshot(id: string): Promise<{
  wrappedDek: string | null;
  wrappedThumbDek: string | null;
  unwrappedDek: string | undefined;
}> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'attachments'
    `);
    const columns = (res.rows as { column_name: string }[]).map((r) => r.column_name);
    const hasUnwrapped = columns.includes('unwrapped_dek');

    const row = await db.execute(
      sql`SELECT wrapped_dek, wrapped_thumb_dek FROM attachments WHERE id = ${id}`,
    );
    const data = row.rows[0] as
      { wrapped_dek: string | null; wrapped_thumb_dek: string | null } | undefined;
    return {
      wrappedDek: data?.wrapped_dek ?? null,
      wrappedThumbDek: data?.wrapped_thumb_dek ?? null,
      // `undefined` if no such column exists. A regression that added
      // a server-side cache of the unwrapped DEK on the row would
      // surface as a non-undefined value here.
      unwrappedDek: hasUnwrapped ? '<column-present>' : undefined,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Insert one row directly in `hidden` state with explicit version_id
 * shape so the integrity-error arms can exercise the unrestorable-row
 * branches. The route-driven path always commits non-null version_ids,
 * so DB-level seeding is the only way to land the regression shape
 * these tests pin.
 *
 * The wrapped envelope is intentionally synthetic (Buffer.alloc) — every
 * caller of this helper hits a pre-unwrap rejection branch:
 *   - `download-url` on hidden returns 404 before touching the envelope,
 *   - `bulk-fetch` rejects hidden ids at the status check before unwrap,
 *   - `restore` integrity errors fire on `version_id` shape before unwrap,
 *   - Papierkorb listing on archived projects doesn't unwrap.
 * A real wrap would burn an `age-keygen` round trip per hidden seed for
 * no behaviour coverage.
 */
async function seedHiddenAttachment(
  projectId: string,
  spec: { versionId: string | null; thumbVersionId: string | null; hasThumbnail: boolean },
): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const kind = spec.hasThumbnail ? 'photo' : 'binary';
    const label = spec.hasThumbnail ? 'foto' : 'sonstiges';
    const mimeType = spec.hasThumbnail ? 'image/jpeg' : 'application/pdf';
    const filename = `hidden-${id.slice(0, 6)}.${spec.hasThumbnail ? 'jpg' : 'pdf'}`;
    const originalKey = `attachments/${projectId}/${id}.orig`;
    const thumbKey = spec.hasThumbnail ? `attachments/${projectId}/${id}.thumb` : null;
    // Synthetic envelope — no caller of this helper reaches the unwrap.
    const wrappedDek = Buffer.alloc(192, 0x33).toString('base64');
    const wrappedThumbDek = spec.hasThumbnail ? Buffer.alloc(192, 0x44).toString('base64') : null;
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes, ciphertext_thumb_size_bytes,
         original_key, thumb_key, has_thumbnail,
         wrapped_dek, wrapped_thumb_dek, wrapped_dek_version,
         version_id, thumb_version_id, hidden_at)
      VALUES (${id}, ${projectId}, 'hidden', ${kind}, ${label},
              ${filename}, ${mimeType}, 100,
              164, ${spec.hasThumbnail ? 164 : null},
              ${originalKey}, ${thumbKey}, ${spec.hasThumbnail},
              ${wrappedDek}, ${wrappedThumbDek}, 1,
              ${spec.versionId}, ${spec.thumbVersionId}, NOW())
    `);
    return id;
  } finally {
    await pool.end();
  }
}

interface SeedReadySpec {
  sizeBytes: number;
  kind?: 'photo' | 'binary';
  mimeType?: string;
  label?: string;
}

/**
 * Insert N `ready` attachment rows directly against the DB so the
 * bulk-fetch / download-url arms have predictable fixtures without
 * going through the init→complete flow. Returns the new ids in order.
 * `__tests__/` is allowlisted for AC-179's architecture check.
 *
 * Each row carries a REAL `wrapped_dek` (and `wrapped_thumb_dek` for
 * photos) — the routes that unwrap on read (`download-url`,
 * `bulk-fetch`) need an envelope the route's KeyEnvelopeService can
 * actually unwrap. Synthetic Buffer.alloc envelopes fail at AEAD
 * verification under any real implementation, which would surface as
 * `DEK_UNWRAP_FAILED` on every happy-path test (and tautologically
 * pass the AC-241 "different DEKs" arm regardless of route logic).
 *
 * The byte-corruption AC-244 arms keep their own explicit synthetic
 * envelopes — those tests intentionally exercise the unwrap-failure
 * branch.
 */
async function seedReadyAttachments(projectId: string, specs: SeedReadySpec[]): Promise<string[]> {
  const { db, pool } = createDatabase();
  try {
    const ids: string[] = [];
    for (const spec of specs) {
      const id = crypto.randomUUID();
      const kind = spec.kind ?? 'photo';
      const mimeType = spec.mimeType ?? 'image/jpeg';
      const label = spec.label ?? 'foto';
      const originalKey = `attachments/${projectId}/${id}.orig`;
      const thumbKey = kind === 'photo' ? `attachments/${projectId}/${id}.thumb` : null;
      // 16 bytes of nonce + ciphertext + 16 bytes of GCM tag is the
      // canonical AES-GCM-on-the-wire shape; +64 bytes is a generous
      // approximation good enough for the per-file cap arms (the
      // numerical relationship is implementation-defined per the
      // spec).
      const ciphertextSize = spec.sizeBytes + 64;
      const ciphertextThumbSize =
        kind === 'photo' ? Math.max(64, Math.floor(ciphertextSize / 10)) : null;
      // Wrap a fresh DEK per row (and a separate one for the thumb on
      // photos — the original-vs-thumbnail "different DEKs" contract
      // is real, not synthetic). The KeyEnvelopeService is the same
      // module the route layer will use to unwrap on read.
      const orig = await wrapFreshDek();
      const thumb = kind === 'photo' ? await wrapFreshDek() : null;
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes, ciphertext_thumb_size_bytes,
           original_key, thumb_key, has_thumbnail,
           wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
        VALUES (${id}, ${projectId}, 'ready', ${kind}, ${label},
                ${'file-' + id.slice(0, 6)}, ${mimeType}, ${spec.sizeBytes},
                ${ciphertextSize}, ${ciphertextThumbSize},
                ${originalKey}, ${thumbKey}, ${kind === 'photo'},
                ${orig.wrappedBase64}, ${thumb?.wrappedBase64 ?? null}, 1)
      `);
      ids.push(id);
    }
    return ids;
  } finally {
    await pool.end();
  }
}

interface SeedReadyWithBytesSpec {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  kind?: 'photo' | 'binary';
  label?: string;
}

/**
 * Seed `ready` rows AND upload the backing bytes to storage. Used by
 * arms that follow the presigned-GET URL end-to-end (e.g. the umlaut
 * Content-Disposition arm). Stored objects carry `application/octet-
 * stream` (the e2e sentinel) regardless of the row's plaintext MIME
 * type — that's the on-the-wire shape under ADR-0024.
 */
async function seedReadyAttachmentsWithBytes(
  projectId: string,
  specs: SeedReadyWithBytesSpec[],
): Promise<string[]> {
  const { db, pool } = createDatabase();
  const s = storage();
  try {
    const ids: string[] = [];
    for (const spec of specs) {
      const id = crypto.randomUUID();
      const kind = spec.kind ?? 'binary';
      const label = spec.label ?? 'sonstiges';
      const originalKey = `attachments/${projectId}/${id}.orig`;
      const thumbKey = kind === 'photo' ? `attachments/${projectId}/${id}.thumb` : null;
      // Storage object carries the sentinel content-type per ADR-0024
      // — the row's plaintext MIME stays in the row metadata only.
      await s.upload(originalKey, spec.bytes, 'application/octet-stream');
      // Real wraps — `download-url` (the umlaut Content-Disposition
      // arm) goes through the unwrap pipeline. Synthetic envelopes
      // would surface as DEK_UNWRAP_FAILED instead of the URL the
      // arm asserts on.
      const orig = await wrapFreshDek();
      const thumb = kind === 'photo' ? await wrapFreshDek() : null;
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes, ciphertext_thumb_size_bytes,
           original_key, thumb_key, has_thumbnail,
           wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
        VALUES (${id}, ${projectId}, 'ready', ${kind}, ${label},
                ${spec.filename}, ${spec.mimeType}, ${spec.bytes.length},
                ${spec.bytes.length}, ${kind === 'photo' ? spec.bytes.length : null},
                ${originalKey}, ${thumbKey}, ${kind === 'photo'},
                ${orig.wrappedBase64}, ${thumb?.wrappedBase64 ?? null}, 1)
      `);
      ids.push(id);
    }
    return ids;
  } finally {
    await pool.end();
  }
}
// (The `fetchBytesFromUrl` + `listZipEntries` helpers from the pre-e2e
// bulk-download arms are gone — bulk-fetch returns per-file URLs +
// DEK material and the streaming-zip assembly happens client-side
// per ADR-0024. The file's only `.zip` interaction is at the SW /
// browser layer.)
