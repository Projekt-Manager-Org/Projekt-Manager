/**
 * Browser-side MD5-of-ciphertext helper for attachment uploads.
 *
 * Used by the standard upload path (`state/attachmentStore.ts`), which
 * needs RFC 1864 base64 of the 16-byte digest — that is what the server
 * signs into the presigned PUT's `Content-MD5` header (ADR-0024 /
 * api.md §14.2.11), and what the storage provider verifies the body
 * against.
 *
 * MD5 is required by the S3 wire protocol (`Content-MD5`); imported
 * from `@noble/hashes/legacy` because Paul Miller's noble suite
 * deliberately walls MD5 / SHA-1 off into `/legacy` to signal that
 * they should never be used for new crypto — we are only here because
 * the storage provider's API contract forces it.
 *
 * Streams the digest in 2 MiB chunks so the full bytes never
 * materialize twice in memory; cheap on phones, fast enough that no
 * Web Worker is warranted at the per-file cap.
 */

import { md5 } from '@noble/hashes/legacy.js';

const CHUNK_BYTES = 2 * 1024 * 1024;

/**
 * Compute the RFC 1864 base64 MD5 of `blob`. Returns the canonical
 * 24-character `==`-padded form the server expects.
 */
export async function computeMd5Base64(blob: Blob): Promise<string> {
  const hasher = md5.create();
  for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
    const slice = blob.slice(offset, Math.min(offset + CHUNK_BYTES, blob.size));
    const buf = await slice.arrayBuffer();
    hasher.update(new Uint8Array(buf));
  }
  // noble-hashes returns the 16-byte digest as Uint8Array; convert
  // straight to a binary string for `btoa`.
  const digest = hasher.digest();
  let bin = '';
  for (const byte of digest) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin);
}
