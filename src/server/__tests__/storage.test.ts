/**
 * API integration test: Object storage module.
 *
 * Test AT-16 from the test specification (verification.md §16.3).
 *
 * This tests the object storage module boundary directly (not through
 * HTTP routes). The module encapsulates upload/download/hide operations
 * against an S3-compatible object storage backend.
 *
 * Per architecture.md §11.4, the module must support:
 *   - Upload (key, data, content type) -> stored reference
 *   - Download (key) -> data stream
 *   - Hide (key) -> success/failure (DeleteObject without VersionId on a
 *     versioned bucket — writes a delete marker, not a destruction;
 *     ADR-0022)
 *   - Get signed/temporary access URL (key, expiry) -> URL
 *
 * This test runs against real object storage infrastructure.
 * It requires valid storage credentials in the test environment.
 *
 * Run with:
 *   STORAGE_ENDPOINT=http://localhost:9000 \
 *   STORAGE_BUCKET=projekt-manager-test \
 *   STORAGE_ACCESS_KEY=minioadmin \
 *   STORAGE_SECRET_KEY=minioadmin \
 *   npx vitest run src/server/__tests__/storage.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createStorageClient, StorageObjectNotFoundError } from '../../server/storage/client.js';
import type { AttachmentStorageClient } from '../../server/storage/client.js';
import { storageConfigFromEnv } from '../../server/storage/fromEnv.js';
import { getEnv } from '../../server/config/env.js';

/**
 * STORAGE_* env vars are required. If they are not set, `storageConfigFromEnv`
 * throws at `beforeAll` instead of silently reporting green. The storage module is
 * a core boundary of the architecture (architecture.md §11.4) and whether it
 * is wired up correctly is not optional state — it must be observable from
 * CI. Running tests that skip themselves on missing config teaches you
 * nothing about whether the module works.
 *
 * Whether the endpoint points at real S3 or a local MinIO is a deployment
 * choice, not a test concern — either way the env must be set.
 */

describe('Object Storage Module', () => {
  let storage: AttachmentStorageClient;

  beforeAll(() => {
    storage = createStorageClient(storageConfigFromEnv(getEnv()));
  });

  // ---------------------------------------------------------------
  // AT-16: Object storage module can upload a file, retrieve it,
  //        and verify the retrieved contents match the original
  // ---------------------------------------------------------------
  //
  // Test isolation rationale:
  // Each test owns its own testKey and performs its own setup (upload,
  // and in the case of the post-delete miss test, upload + delete).
  // A previous version of this block shared a single describe-scoped
  // testKey across all five tests, which created implicit ordering
  // dependencies: if the upload test failed, the remaining tests all
  // failed with misleading "not found" errors, hiding the real cause.
  // Sharing state also broke `--grep` / `--testNamePattern` filtering
  // for any single test and collapsed what should be independent
  // assertions into one compound test split across `it` blocks.
  //
  // The cost is a few extra uploads per run. Storage tests are
  // integration-level and not performance-critical — isolation wins.
  // Do not "optimize" this back into a shared key.
  // AC-40 [crit]
  describe('AT-16: Upload, retrieve, and verify', () => {
    const testContent = Buffer.from(
      'AT-16 Testdatei: Projekt-Manager Objekt-Speicher Integrationstest.',
      'utf-8',
    );
    const testContentType = 'text/plain';

    let testKey: string;

    beforeEach(() => {
      // Math.random() guards against Date.now() collisions when tests
      // run in the same millisecond (parallel workers, fast machines).
      testKey = `test/at-16-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
    });

    afterEach(async () => {
      // Best-effort cleanup so leftover objects don't accumulate in the
      // test bucket. Errors are swallowed: the object may already have
      // been deleted by the test itself (e.g. tests 4 and 5), or the
      // upload may have never happened (e.g. a failed upload in test 1).
      try {
        await storage.hide(testKey);
      } catch {
        // ignore — cleanup is best-effort
      }
    });

    it('uploads a file without error', async () => {
      const result = await storage.upload(testKey, testContent, testContentType);
      expect(result).toBeDefined();
      expect(result.key).toBe(testKey);
    });

    it('retrieves the uploaded file with matching contents', async () => {
      // Own upload: this test verifies retrieval fidelity, not ordering.
      await storage.upload(testKey, testContent, testContentType);

      const downloaded = await storage.download(testKey);
      expect(Buffer.isBuffer(downloaded.data) || downloaded.data instanceof Uint8Array).toBe(true);
      expect(Buffer.from(downloaded.data).toString('utf-8')).toBe(testContent.toString('utf-8'));
      expect(downloaded.contentType).toBe(testContentType);
    });

    it('generates a signed URL for the uploaded file', async () => {
      // Own upload: this test verifies signed URL generation, independent
      // of whether any earlier test uploaded something.
      await storage.upload(testKey, testContent, testContentType);

      const url = await storage.getSignedUrl(testKey, 60);
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^https?:\/\//);
    });

    it('hides the uploaded file', async () => {
      // Own upload: hide needs something to hide. Setup, not ordering.
      await storage.upload(testKey, testContent, testContentType);

      await expect(storage.hide(testKey)).resolves.not.toThrow();
    });

    it('download after hide returns not-found or throws', async () => {
      // Full setup: upload then hide, so the assertion under test is
      // purely "download of a hidden key fails". No reliance on any
      // other test having run first.
      await storage.upload(testKey, testContent, testContentType);
      await storage.hide(testKey);

      await expect(storage.download(testKey)).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------
  // #48 — health probe support: ping() verifies bucket reachability
  // ---------------------------------------------------------------
  describe('ping()', () => {
    it('resolves when the configured bucket is reachable', async () => {
      await expect(storage.ping()).resolves.not.toThrow();
    });

    it('rejects when the bucket does not exist', async () => {
      const bogusStorage = createStorageClient({
        ...storageConfigFromEnv(getEnv()),
        bucket: 'definitely-not-a-real-bucket-xyz-' + Date.now(),
      });
      await expect(bogusStorage.ping()).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------
  // copyFromVersion() — restore primitive (ADR-0022, AC-234).
  //
  // Provider-divergent behaviour on an unaddressable source version is
  // the reason for the HEAD-with-versionId probe in `copyFromVersion`:
  // AWS / MinIO surface 404 NoSuchVersion, but B2 surfaces 500
  // InternalError on CopyObject (still 4xx on HEAD). The probe is what
  // lets the restore caller distinguish "bytes are gone" (4xx → 410
  // GONE) from a genuine outage (5xx bubble) — without it, B2's 500
  // InternalError fell through the global handler as 500 SERVER_ERROR.
  //
  // These integration tests exercise the contract on MinIO. Every 4xx
  // shape MinIO can return for an unaddressable version is the same
  // shape the probe must catch on B2; the cross-provider asymmetry is
  // narrowed to the same `StorageObjectNotFoundError` outcome here.
  // ---------------------------------------------------------------
  describe('copyFromVersion()', () => {
    let testKey: string;

    beforeEach(() => {
      testKey = `test/copy-from-version-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bin`;
    });

    afterEach(async () => {
      try {
        await storage.hide(testKey);
      } catch {
        // best-effort
      }
    });

    it('throws StorageObjectNotFoundError when the source versionId is unknown', async () => {
      // Upload so the KEY exists — narrows the failure surface to "the
      // versionId is wrong" rather than "the key is missing entirely",
      // which is the exact shape the dev→VPS sync produces (key is
      // present on B2 with a fresh PUT version; DB carries the dev-side
      // MinIO UUID that B2 doesn't recognize).
      await storage.upload(testKey, Buffer.from('hello'), 'application/octet-stream');

      // A versionId that is structurally invalid for any provider. On
      // MinIO this is `NoSuchVersion` (404); on B2 this would be 400
      // InvalidArgument. Either way the HEAD probe catches the 4xx and
      // surfaces our typed not-found.
      await expect(
        storage.copyFromVersion(testKey, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('throws StorageObjectNotFoundError when the key does not exist at all', async () => {
      // Different from the previous test: this exercises the
      // key-itself-missing path (HEAD returns 404 because no version of
      // the key exists). Same 4xx classification → same outcome.
      await expect(
        storage.copyFromVersion(
          `test/never-uploaded-${Date.now()}.bin`,
          '00000000-0000-0000-0000-000000000000',
        ),
      ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('promotes a noncurrent version back to current when the source versionId is valid', async () => {
      // Round-trip: upload, capture the versionId via HEAD, hide
      // (creates a delete marker — current version is now the marker;
      // the original PUT becomes noncurrent), then copyFromVersion to
      // promote the original back to current. Mirrors the Papierkorb
      // restore flow on a versioned bucket.
      const original = Buffer.from('restore-me');
      await storage.upload(testKey, original, 'application/octet-stream');
      const head = await storage.headObject(testKey);
      expect(head.versionId).toBeDefined();
      const sourceVersionId = head.versionId!;

      await storage.hide(testKey);
      // Sanity: download must now fail because the current version is a
      // delete marker.
      await expect(storage.download(testKey)).rejects.toThrow();

      const newVersionId = await storage.copyFromVersion(testKey, sourceVersionId);
      expect(newVersionId).toBeDefined();

      // The promoted version is the new current; download succeeds and
      // returns the original bytes.
      const restored = await storage.download(testKey);
      expect(Buffer.from(restored.data).toString('utf-8')).toBe('restore-me');
    });
  });

  // ---------------------------------------------------------------
  // keyPrefix transparency — proves the per-process namespace lands
  // at the S3 boundary (the prefix is applied to writes) while callers
  // continue to read/write bare logical keys.
  //
  // Two clients against the same bucket: `prefixedStorage` is the unit
  // under test, built from env with this fork's STORAGE_KEY_PREFIX;
  // `rawStorage` is the same config without a prefix — the control used
  // to observe the raw bucket-side key shape.
  // ---------------------------------------------------------------
  describe('keyPrefix transparency', () => {
    const namespace = getEnv().STORAGE_KEY_PREFIX!;
    let prefixedStorage: AttachmentStorageClient;
    let rawStorage: AttachmentStorageClient;

    beforeAll(() => {
      expect(namespace).toBeTruthy();
      prefixedStorage = createStorageClient(storageConfigFromEnv(getEnv()));
      rawStorage = createStorageClient({ ...storageConfigFromEnv(getEnv()), keyPrefix: undefined });
    });

    afterEach(async () => {
      // Per-test cleanup — hide whatever the test wrote. Compliance
      // Object Lock stacks a delete marker; the bytes survive until
      // the lifecycle rule (default 2 days) reaps them. That's enough
      // for the bucket-pollution guard's current-version check.
      const keys = await prefixedStorage.listObjects('kp/');
      for (const key of keys) {
        try {
          await prefixedStorage.hide(key);
        } catch {
          // Best-effort; another test may have raced.
        }
      }
    });

    it('round-trips a logical key — caller never sees the prefix', async () => {
      const logicalKey = 'kp/round-trip';
      const body = Buffer.from('hello-from-prefixed-client', 'utf-8');
      const { key: returnedKey } = await prefixedStorage.upload(logicalKey, body, 'text/plain');
      // Returned key is the LOGICAL key the caller passed — not the
      // wire-key. Stripping happens at the boundary.
      expect(returnedKey).toBe(logicalKey);

      const dl = await prefixedStorage.download(logicalKey);
      expect(Buffer.from(dl.data).toString('utf-8')).toBe('hello-from-prefixed-client');
    });

    it('places the object at the prefixed path in the bucket', async () => {
      const logicalKey = 'kp/wire-key-check';
      await prefixedStorage.upload(logicalKey, Buffer.from('x'), 'application/octet-stream');

      // The control client (no keyPrefix) reads the bucket raw — it sees
      // the wire key `namespace + logicalKey`. If the prefix were not
      // applied, this list would be empty.
      const rawKeys = await rawStorage.listObjects(namespace);
      expect(rawKeys).toContain(`${namespace}${logicalKey}`);
      // And the same path is NOT visible at the bare logical key.
      const bareKeys = await rawStorage.listObjects('kp/');
      expect(bareKeys).not.toContain(logicalKey);
    });

    it('strips the prefix from listObjects results', async () => {
      // Two writes through the prefixed client.
      await prefixedStorage.upload('kp/listing/a', Buffer.from('1'), 'text/plain');
      await prefixedStorage.upload('kp/listing/b', Buffer.from('2'), 'text/plain');

      // Caller asks for `kp/listing/` and gets BARE keys back — the
      // wire prefix is invisible.
      const keys = await prefixedStorage.listObjects('kp/listing/');
      expect(keys.sort()).toEqual(['kp/listing/a', 'kp/listing/b']);
    });

    it('hide() targets the prefixed key', async () => {
      const logicalKey = 'kp/hide-target';
      await prefixedStorage.upload(logicalKey, Buffer.from('x'), 'text/plain');

      // Hide via prefixed client — DeleteObject without VersionId
      // hits `namespace + logicalKey`. Caller-side view: gone.
      await prefixedStorage.hide(logicalKey);
      await expect(prefixedStorage.headObject(logicalKey)).rejects.toBeInstanceOf(
        StorageObjectNotFoundError,
      );

      // Control client confirms the delete-marker landed at the
      // wire key — the bare logical key was never written and so
      // wouldn't appear in either view; the wire key was, but its
      // current version is now a delete marker, so a current-version
      // list excludes it.
      const rawKeys = await rawStorage.listObjects(namespace);
      expect(rawKeys).not.toContain(`${namespace}${logicalKey}`);
    });
  });

  // ---------------------------------------------------------------
  // keyPrefix shape validation — misconfiguration fails at boot,
  // not at the first PUT.
  // ---------------------------------------------------------------
  describe('keyPrefix validation', () => {
    const baseConfig = () => storageConfigFromEnv(getEnv());

    it.each([
      ['no trailing slash', 'test-123'],
      ['leading slash', '/test-123/'],
      ['uppercase', 'Test-123/'],
      ['invalid char', 'test 123/'],
      ['starts with dash', '-test/'],
      ['double slash', 'test//'],
    ])('rejects keyPrefix "%s" (%s)', (_label, invalid) => {
      expect(() => createStorageClient({ ...baseConfig(), keyPrefix: invalid })).toThrow(
        /keyPrefix/,
      );
    });

    it('accepts empty / undefined as "no prefix"', () => {
      expect(() => createStorageClient({ ...baseConfig(), keyPrefix: undefined })).not.toThrow();
      expect(() => createStorageClient({ ...baseConfig(), keyPrefix: '' })).not.toThrow();
    });

    it('accepts the canonical shape', () => {
      expect(() =>
        createStorageClient({ ...baseConfig(), keyPrefix: 'test-12345/' }),
      ).not.toThrow();
    });
  });
});
