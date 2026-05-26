/**
 * MD5 helper for the S3-presigned PUT path — the storage provider
 * verifies the body against `Content-MD5` (ADR-0024 / api.md §14.2.11).
 * The upload path (`state/attachmentStore.ts`) calls into this single
 * implementation; a regression here breaks every upload.
 *
 * Golden values pinned against `md5sum` (coreutils) so the test is
 * authoritative across hash-library swaps. The 3 MiB case exercises
 * the streaming path (CHUNK_BYTES is 2 MiB internally).
 */

import { describe, it, expect } from 'vitest';

import { computeMd5Base64 } from '@/domain/attachmentChecksum';

describe('computeMd5Base64 — RFC 1864 base64 MD5', () => {
  it('empty blob produces the canonical empty-MD5', async () => {
    expect(await computeMd5Base64(new Blob([]))).toBe('1B2M2Y8AsgTpgAmY7PhCfg==');
  });

  it("'abc' matches md5sum reference", async () => {
    expect(await computeMd5Base64(new Blob(['abc']))).toBe('kAFQmDzST7DWlj99KOF/cg==');
  });

  it("'Hello, World!' matches md5sum reference", async () => {
    expect(await computeMd5Base64(new Blob(['Hello, World!']))).toBe('ZajifYh5KDgxtmS9i38K1A==');
  });

  it('3 MiB of zeros — exercises the 2 MiB chunked streaming path', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    expect(await computeMd5Base64(new Blob([bytes]))).toBe('0d0hDWsTEss0K1bQK9XmUQ==');
  });

  it('3 MiB of cycling bytes — chunk boundary with translation-sensitive data', async () => {
    // All-zero data would hide an off-by-one in `slice(offset, ...)` because
    // every byte hashes the same; cycling `i & 0xff` makes byte position
    // matter — a one-byte drift on either side of the 2 MiB boundary changes
    // the digest. md5sum reference computed against the same byte pattern.
    const bytes = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    expect(await computeMd5Base64(new Blob([bytes]))).toBe('4gFanFCQbHYEauYm+58WuQ==');
  });
});
