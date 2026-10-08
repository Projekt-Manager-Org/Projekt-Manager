/**
 * End-to-end coverage of the actual presigned PUT flow against MinIO.
 *
 * Every other integration test in this repo seeds bytes via direct
 * `storage.upload()` (the non-presigned SDK path), so the SigV4 /
 * signed-headers / Content-MD5 binding path that backs the production
 * upload protocol was never exercised. A bug in `signableHeaders` /
 * `requestChecksumCalculation` / `unhoistableHeaders` propagation
 * would have shipped silently.
 *
 * Under ADR-0024 (e2e binary attachments) the bytes the browser PUTs
 * are *ciphertext*, not plaintext — so the signed PUT pins the
 * ciphertext-shaped triplet:
 *   - Content-Type:   `application/octet-stream` (sentinel — the row's
 *                     plaintext `mimeType` stays in the row metadata
 *                     and never goes on the wire to storage)
 *   - Content-Length: `ciphertextSizeBytes` from the init payload
 *   - Content-MD5:    RFC 1864 base64 of the ciphertext body's MD5
 *
 * This file fires real `fetch()` PUTs against MinIO using exactly the
 * URL + headers the server returns from `init`. It pins:
 *
 *   1. The happy path — presigned PUT for the original ciphertext
 *      blob succeeds with 2xx, ditto for the thumbnail ciphertext,
 *      and `complete()` flips the row to `ready` after HEAD verifies
 *      the sentinel content-type + ciphertext sizes.
 *   2. The negative path — a body whose MD5 differs from the signed
 *      `Content-MD5` is rejected with `BadDigest`. MinIO enforces
 *      Content-MD5 verification empirically; same shape as AWS S3 /
 *      B2.
 *
 * Storage env: `startApp()` calls `validateEnvRuntime()` which loads the
 * STORAGE_* vars (see api-helpers.ts). MinIO must be running locally
 * (docker-compose up storage). The `STORAGE_PUBLIC_ENDPOINT` is unset
 * in dev, so signed URLs collapse to `STORAGE_ENDPOINT` (the same host
 * the test process can reach via fetch).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { photoInitBody } from '../../test/fixtures/attachmentInit.js';
import { freshDekMaterial, md5Base64, presignedPut } from '../../test/fixtures/presignedPut.js';

const year = new Date().getFullYear();

/**
 * Synthesize an opaque ciphertext-shaped Buffer of `length` bytes.
 * Under ADR-0024 the bytes the browser PUTs are AES-256-GCM ciphertext
 * with a leading nonce — there is no JPEG / WebP / PDF magic on the
 * wire. The buffer is filled with random bytes so the MD5 differs
 * across runs (a regression that hardcoded a digest somewhere would
 * trip on a stable-fill test surfacing the same MD5). The leading 12
 * bytes mimic the AES-GCM nonce convention; the remainder is the
 * synthetic ciphertext + 16-byte tag region.
 */
function ciphertextBuffer(length: number): Buffer {
  return crypto.randomBytes(length);
}

async function seededProjectId(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (row) => row.number === `${year}-007`,
  );
  if (!p) throw new Error(`seed missing ${year}-007`);
  return p.id;
}

describe('Attachment presigned PUT — real upload against MinIO', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    projectId = await seededProjectId(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // Happy path — exercise the full presigned PUT flow end-to-end.
  // The whole point of the file: no `storage.upload()` shortcut, the
  // signed URL + headers are what the browser would actually send.
  //
  // Under e2e (ADR-0024) the bytes are ciphertext and the signed
  // headers pin the *ciphertext* triplet:
  //   Content-Type   == application/octet-stream (sentinel)
  //   Content-Length == ciphertextSizeBytes from init
  //   Content-MD5    == ciphertextContentMd5 from init
  // ---------------------------------------------------------------
  it('PUTs original + thumbnail ciphertext through the signed URL and completes the row', async () => {
    const originalCiphertext = ciphertextBuffer(180);
    const thumbCiphertext = ciphertextBuffer(120);
    const originalCiphertextMd5 = md5Base64(originalCiphertext);
    const thumbCiphertextMd5 = md5Base64(thumbCiphertext);

    const initRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      photoInitBody({
        // Plaintext sizes on the row — the per-file cap and the export
        // envelope read these. Storage never sees them.
        sizeBytes: 120,
        thumbSizeBytes: 80,
        // Ciphertext sizes drive the signed Content-Length.
        ciphertextSizeBytes: originalCiphertext.length,
        ciphertextContentMd5: originalCiphertextMd5,
        ciphertextThumbSizeBytes: thumbCiphertext.length,
        ciphertextThumbContentMd5: thumbCiphertextMd5,
        dekMaterial: freshDekMaterial(),
        thumbDekMaterial: freshDekMaterial(),
      }),
    );
    expect(initRes.statusCode).toBe(201);
    const body = initRes.json();
    expect(body.attachment.status).toBe('pending');

    // Sentinel content-type — the row's plaintext mimeType never
    // reaches storage on the wire. Pin both PUT descriptors to the
    // sentinel so a regression that signs the plaintext MIME would
    // trip here (and the storage provider would also accept the
    // mismatching content-type at PUT time, which is exactly the
    // smell this assertion catches before `complete` does).
    expect(body.originalUpload.headers['Content-Type']).toBe('application/octet-stream');
    expect(body.thumbnailUpload.headers['Content-Type']).toBe('application/octet-stream');
    // Ciphertext sizes — Content-Length matches the ciphertext, not
    // the row's plaintext sizeBytes.
    expect(body.originalUpload.headers['Content-Length']).toBe(String(originalCiphertext.length));
    expect(body.thumbnailUpload.headers['Content-Length']).toBe(String(thumbCiphertext.length));
    // Ciphertext MD5 — RFC 1864 base64 of the ciphertext body.
    expect(body.originalUpload.headers['Content-MD5']).toBe(originalCiphertextMd5);
    expect(body.thumbnailUpload.headers['Content-MD5']).toBe(thumbCiphertextMd5);

    // PUT the original ciphertext.
    const originalPut = await presignedPut(body.originalUpload, originalCiphertext);
    expect(originalPut.status).toBeGreaterThanOrEqual(200);
    expect(originalPut.status).toBeLessThan(300);
    // Drain to keep the keep-alive socket clean (some Node fetch
    // configurations leak a half-read body into the agent pool).
    await originalPut.arrayBuffer();

    // PUT the thumbnail ciphertext.
    const thumbPut = await presignedPut(body.thumbnailUpload, thumbCiphertext);
    expect(thumbPut.status).toBeGreaterThanOrEqual(200);
    expect(thumbPut.status).toBeLessThan(300);
    await thumbPut.arrayBuffer();

    // Flip pending → ready. complete() HEADs the ciphertext and
    // verifies size + sentinel content-type per AC-212.
    const completeRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
    );
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.json().status).toBe('ready');
  });

  // ---------------------------------------------------------------
  // Negative — the signed Content-MD5 binds the URL to specific bytes.
  // PUT a body whose MD5 differs and the storage provider rejects with
  // `BadDigest`. This is the load-bearing guarantee that backs the
  // entire "URL is reusable only for those bytes" claim in api.md
  // §14.2.11.
  //
  // Verified against MinIO RELEASE.2025-09-07: returns
  //   <Code>BadDigest</Code><Message>The Content-Md5 you specified
  //   did not match what we received.</Message>
  // with HTTP status 400. AWS S3 / B2 share the same shape.
  // ---------------------------------------------------------------
  it('rejects a ciphertext body whose MD5 does not match the signed Content-MD5', async () => {
    const advertisedCiphertext = ciphertextBuffer(160);
    const advertisedCiphertextMd5 = md5Base64(advertisedCiphertext);
    const tamperedCiphertext = Buffer.from(advertisedCiphertext);
    tamperedCiphertext[100] ^= 0xff; // flip a single byte to invalidate the digest
    expect(md5Base64(tamperedCiphertext)).not.toBe(advertisedCiphertextMd5);

    const initRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      photoInitBody({
        sizeBytes: 120,
        ciphertextSizeBytes: advertisedCiphertext.length,
        ciphertextContentMd5: advertisedCiphertextMd5,
        dekMaterial: freshDekMaterial(),
        // No thumbnail — keeps the test focused on a single PUT.
        hasThumbnail: false,
      }),
    );
    expect(initRes.statusCode).toBe(201);
    const body = initRes.json();

    // PUT the *tampered* bytes against the URL signed for the original
    // MD5. Storage MUST reject — the Content-MD5 header (echoed from the
    // signed descriptor) advertises one digest, the body computes
    // another.
    const putRes = await presignedPut(body.originalUpload, tamperedCiphertext);
    expect(putRes.status).toBeGreaterThanOrEqual(400);
    const text = await putRes.text();
    expect(text.toLowerCase()).toContain('baddigest');
  });
});
