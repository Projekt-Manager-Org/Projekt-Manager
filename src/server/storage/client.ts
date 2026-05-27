/**
 * S3-compatible object storage client.
 *
 * Wraps @aws-sdk/client-s3 with a minimal interface for upload, hide,
 * restore, presign, and signed URL generation. Configured with
 * forcePathStyle for MinIO compatibility.
 *
 * Per ADR-0022, the app key cannot destroy versions. The mutating
 * surface is `hide()` (DeleteObject without VersionId, creates a marker)
 * and `copyFromVersion()` (CopyObject from a specific noncurrent version
 * — the restore primitive). There is no `delete()` / `deleteObject()`
 * by design: a method named "delete" that cannot actually destroy is
 * misleading, and the architecture test at
 * `src/server/__tests__/storage-architecture.test.ts` enforces that no
 * `DeleteObjectCommand` / `DeleteObjectsCommand` carries a `VersionId`
 * anywhere in the codebase.
 *
 * See architecture.md §11.4 for the module boundary definition.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
  CopyObjectCommand,
  type LifecycleRule,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { STORAGE_CONFIG } from '../config/index.js';
import {
  CAPABILITY_PROBE_KEY,
  CAPABILITY_PROBE_VERSION_ID,
  type BucketSafetyConfig,
  type CapabilityProbeResult,
  type LifecycleRuleSnapshot,
} from './safety.js';

export interface StorageConfig {
  endpoint: string;
  /**
   * Optional public endpoint used only when signing URLs returned to the
   * browser (presigned PUT for init uploads, presigned GET for downloads
   * and bulk-zip pickup). When present, the signing client substitutes
   * this URL so the browser receives a host it can actually resolve —
   * typically a reverse-proxied subdomain (`https://storage.<domain>`)
   * that forwards to the internal MinIO endpoint. When absent, signing
   * reuses `endpoint` — correct for local dev where MinIO is exposed
   * on the host, wrong for any deployment where `endpoint` is a
   * container-only hostname.
   *
   * The signature's canonical request binds the host at signing time, so
   * the browser's request to the public URL verifies correctly against
   * MinIO behind the reverse proxy only when Caddy preserves the `Host`
   * header (Caddy's default).
   */
  publicEndpoint?: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  /**
   * Optional per-process key namespace. When set, every storage
   * operation transparently prepends this string at the S3 boundary
   * (PUT/GET/HEAD/DELETE/LIST/COPY/PRESIGN); callers continue to pass
   * and receive bare logical keys. Used by the vitest integration suite
   * (`src/test/integration-setup.ts`) to scope each fork's writes to
   * `test-<pid>/` inside the shared test bucket, mirroring the per-PID
   * DB isolation. Production passes `undefined` — logical keys land in
   * the bucket as-is.
   *
   * Shape: `^[a-z0-9][a-z0-9_-]*\/$` (trailing slash required). Validated
   * at `createStorageClient()` so a misconfiguration fails at boot, not
   * at first PUT.
   */
  keyPrefix?: string;
}

export interface UploadResult {
  key: string;
  /**
   * S3 VersionId minted by this PUT, when the bucket has versioning
   * enabled (ADR-0022). Server-side write paths that persist an
   * attachment row capture it as `version_id` / `thumb_version_id` so the
   * Papierkorb restore flow can later `copyFromVersion(key, versionId)`.
   * Undefined on unversioned buckets or when the provider omits the
   * field. Mirrors `HeadObjectResult.versionId` (the complete()-time
   * source for browser-uploaded blobs).
   */
  versionId?: string;
}

export interface DownloadResult {
  data: Buffer | Uint8Array;
  contentType: string;
}

export interface HeadObjectResult {
  size: number;
  contentType: string;
  /**
   * S3 VersionId of the current version of the key, when the bucket has
   * versioning enabled (ADR-0022). Captured at complete-time so the
   * Papierkorb restore flow can `copyFromVersion(key, versionId)`.
   * Undefined when the bucket is unversioned (legacy / non-prod) or the
   * provider response omits the field.
   */
  versionId: string | undefined;
}

export interface PresignedPutDescriptor {
  /** PUT target URL. The signature is in the query string. */
  url: string;
  /**
   * Headers the client MUST send on the PUT, exact-match. SigV4 binds
   * each value into the signature, so any divergence is rejected with a
   * signature error before the bytes are persisted.
   *
   * - `Content-Type` — pinned MIME type. The complete() flip re-asserts
   *   this against the row HEAD as defense-in-depth.
   * - `Content-Length` — exact body byte count. HTTP semantics also
   *   reject a body-length mismatch independently of SigV4.
   * - `Content-MD5` — RFC 1864 base64 of the body's MD5. Required by
   *   B2 when the bucket carries Compliance Object Lock with default
   *   retention (ADR-0022): bucket-default retention attaches Object
   *   Lock parameters to every PutObject, and B2 demands an integrity
   *   header on any such PUT — bare PUTs are rejected with
   *   `"Content-MD5 OR x-amz-checksum-* HTTP header is required for
   *   Put Object requests with Object Lock parameters"`. Doubles as the
   *   byte-binding guarantee that the POST policy flow could not
   *   express: storage providers verify Content-MD5 against received
   *   bytes and reject with `BadDigest` on mismatch, so a presigned URL
   *   is usable only for an upload of bytes that hash to this exact
   *   MD5.
   */
  headers: Record<string, string>;
  /** ISO 8601 — after this the descriptor is useless. */
  expiresAt: string;
}

export interface PresignedGetDescriptor {
  url: string;
  /** ISO 8601 — after this the URL is expired. */
  expiresAt: string;
}

/**
 * Thrown by `headObject` when the key is absent. Separate class so
 * callers can catch the "object missing" case cleanly without stringly
 * matching on the AWS SDK error shape.
 */
export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = 'StorageObjectNotFoundError';
  }
}

export interface StorageClient {
  upload(key: string, data: Buffer | Uint8Array, contentType: string): Promise<UploadResult>;
  download(key: string): Promise<DownloadResult>;
  getSignedUrl(key: string, expirySeconds: number): Promise<string>;
  /**
   * Liveness probe — verifies the configured bucket is reachable and
   * accessible with the current credentials. Used by the /api/health
   * endpoint (#48) so MinIO/S3 outages surface as "degraded" instead of
   * the old unconditional "ok" that masked real infrastructure problems.
   * Throws if the bucket is missing, credentials are wrong, or the
   * endpoint is unreachable.
   */
  ping(): Promise<void>;

  // ---------------------------------------------------------------
  // Attachment extensions (#108).
  //
  // Declared as optional so existing test mocks that only construct
  // the Tier-1 surface (upload / download / delete / getSignedUrl /
  // ping) still satisfy `as StorageClient`. The real factory
  // `createStorageClient()` always populates these — callers that
  // need them narrow via the `AttachmentStorageClient` alias below.
  // ---------------------------------------------------------------

  /**
   * Issue a presigned PUT descriptor pinning the exact key, content type,
   * size, and body MD5. See api.md §14.2.11 "Presigned-PUT signed
   * headers".
   *
   * Why PUT and not POST policy: B2's S3-compatible API does not implement
   * browser-based POST uploads — `POST /<bucket>` returns `501
   * NotImplemented` with no CORS headers, surfacing as a misleading "no
   * Access-Control-Allow-Origin" in the browser. PUT is the cross-provider
   * lowest common denominator (AWS, B2, R2, MinIO, Wasabi all implement
   * it). See ADR-0022 § "Upload protocol".
   *
   * Why these three signed headers: `Content-Type` and `Content-Length`
   * pin what the POST policy used to pin (`starts-with` on type,
   * `content-length-range` collapsed to a single value); `Content-MD5`
   * is mandated by B2 because bucket-default Compliance retention
   * attaches Object Lock parameters to every PutObject. Pinning MD5 in
   * the signature also bounds the URL to a specific body — providers
   * verify Content-MD5 against received bytes (`BadDigest` on
   * mismatch), so the URL cannot be reused for different bytes.
   */
  createPresignedPut?: (
    key: string,
    contentType: string,
    sizeBytes: number,
    contentMd5Base64: string,
    expirySeconds?: number,
  ) => Promise<PresignedPutDescriptor>;

  /** Presigned GET URL + ISO-formatted expiry. */
  createPresignedGet?: (
    key: string,
    expirySeconds?: number,
    attachmentFileName?: string,
  ) => Promise<PresignedGetDescriptor>;

  /**
   * HEAD-check an object. Returns `{ size, contentType }` or throws
   * `StorageObjectNotFoundError` on a 404.
   */
  headObject?: (key: string) => Promise<HeadObjectResult>;

  /**
   * Hide the object — DeleteObject on a versioned bucket without a
   * VersionId, which writes a delete marker instead of destroying the
   * underlying version (ADR-0022). The app key has only `writeFiles`
   * (no `deleteFiles`), so a destructive call would be refused at the
   * capability layer regardless; the method name reflects what actually
   * happens on the wire.
   */
  hide?: (key: string) => Promise<void>;

  /**
   * Restore primitive — CopyObject with a versionId in `CopySource`,
   * promoting an older noncurrent version back to current. Returns the
   * new version id of the resulting current version (the bucket is
   * versioned, so each PUT — including this server-side copy — produces
   * a fresh version). Used by the Papierkorb restore flow (ADR-0022).
   *
   * Throws `StorageObjectNotFoundError` when the source version is not
   * addressable: lifecycle reaped (data-model.md §6.12 race), or the
   * versionId predates a topology change (e.g. dev→VPS sync produced
   * fresh B2 versionIds the DB doesn't know — see scripts/ops/
   * sync-restore-vps.sh post-mirror repair). Implementation runs a
   * versioned HEAD probe before the copy because providers report an
   * unaddressable version inconsistently — AWS / MinIO surface 404
   * NoSuchVersion, B2 surfaces 500 InternalError on CopyObject (but
   * still 4xx on HEAD), so HEAD is the deterministic check. The restore
   * caller maps this to `410 GONE`.
   *
   * App-key capability dependency (B2): on a bucket with default
   * Compliance Object Lock retention, the running credential MUST hold
   * `writeFileRetentions` (= `s3:PutObjectRetention`). Without it,
   * B2's S3-compat layer silently HANGS the CopyObject request for ~5
   * minutes per attempt before returning 503 ServiceUnavailable — the
   * inherited retention timestamp the copy must write tips into a
   * capability denial that B2 surfaces as a stall, not an immediate
   * 403. The deploy-preflight `probe-copyobj` step in
   * `deploy-preflight-cli.ts` is the catch-point; the App key table
   * in `docs/ops/object-storage-provisioning.md` is the source of
   * truth for the canonical seven-cap set.
   */
  copyFromVersion?: (key: string, sourceVersionId: string) => Promise<string | undefined>;

  /**
   * Stream the raw bytes of an object. The returned Readable carries the
   * SDK's SdkStream mixin in practice, but the mixin is not part of the
   * contract — callers pipe or collect. Throws
   * `StorageObjectNotFoundError` on a 404 so the consumer can distinguish
   * "missing object" from a transport fault (same contract as
   * `headObject`).
   *
   * Used by the bulk-download zip assembly in `AttachmentService` (#108)
   * to source each entry's bytes for the archiver pipe.
   */
  getObject?: (key: string) => Promise<Readable>;

  /**
   * Upload bytes under a server-issued key. Streaming body is accepted
   * so the caller can pipe an archiver output straight into the upload
   * without buffering the full zip in memory when it grows to the
   * 20 MB bulk-download cap. Content length is passed explicitly because
   * the streaming-upload path needs it to set `Content-Length` up-front.
   */
  putObject?: (key: string, body: Buffer | Uint8Array, contentType: string) => Promise<void>;

  /**
   * List keys under the given prefix. `olderThan`, when supplied, filters
   * to objects whose LastModified is strictly older than the cutoff —
   * letting the bulk-download sweep reaper skip still-live temp zips
   * without needing a second round-trip per object.
   */
  listObjects?: (prefix: string, olderThan?: Date) => Promise<string[]>;

  /**
   * Boot-time bucket-safety probe (ADR-0022 / docs/ops/object-storage-provisioning.md).
   * Returns a structured snapshot of versioning + Object Lock + lifecycle
   * for `assertStorageBucketSafe()` in `./safety.ts` to evaluate.
   */
  getBucketSafetyConfig?: () => Promise<BucketSafetyConfig>;

  /**
   * Boot-time capability self-test (see `safety.ts` header for the
   * full rationale). Issues a destructive call against a sentinel
   * non-existent version and classifies the response — AccessDenied
   * means the capability split is intact, anything else is structured
   * back to the validator for fail-closed handling.
   *
   * Implementations MUST return a structured `CapabilityProbeResult`
   * even on AccessDenied — the probe is a measurement, not an
   * exception flow.
   */
  probeDeleteVersionCapability?: () => Promise<CapabilityProbeResult>;
}

/**
 * Narrowed surface used by the attachment subsystem — guarantees the
 * Tier-2 methods exist. `createStorageClient()` returns a fully-populated
 * client that satisfies this alias; attachment services accept this
 * narrower type so a `StorageClient` lacking the methods fails at tsc.
 */
export interface AttachmentStorageClient extends StorageClient {
  createPresignedPut: (
    key: string,
    contentType: string,
    sizeBytes: number,
    contentMd5Base64: string,
    expirySeconds?: number,
  ) => Promise<PresignedPutDescriptor>;
  createPresignedGet: (
    key: string,
    expirySeconds?: number,
    attachmentFileName?: string,
  ) => Promise<PresignedGetDescriptor>;
  headObject: (key: string) => Promise<HeadObjectResult>;
  hide: (key: string) => Promise<void>;
  copyFromVersion: (key: string, sourceVersionId: string) => Promise<string | undefined>;
  getObject: (key: string) => Promise<Readable>;
  putObject: (key: string, body: Buffer | Uint8Array, contentType: string) => Promise<void>;
  listObjects: (prefix: string, olderThan?: Date) => Promise<string[]>;
  getBucketSafetyConfig: () => Promise<BucketSafetyConfig>;
  probeDeleteVersionCapability: () => Promise<CapabilityProbeResult>;
}

/**
 * Validates a storage key to prevent path traversal and malformed keys.
 * Charset + length rule lives on `STORAGE_CONFIG.validKeyPattern` (single
 * source of truth). Structural rules (no `..`, no leading `/` or `.`)
 * are enforced here because they're per-key shape, not a reusable regex.
 */
export function validateKey(key: string): void {
  if (!key || !STORAGE_CONFIG.validKeyPattern.test(key)) {
    throw new Error(
      `Invalid storage key: must be 1–1024 characters matching [a-zA-Z0-9/_.-]. Got: "${key}"`,
    );
  }
  if (key.includes('..')) {
    throw new Error(`Invalid storage key: path traversal ("..") is not allowed. Got: "${key}"`);
  }
  if (key.startsWith('/') || key.startsWith('.')) {
    throw new Error(`Invalid storage key: must not start with "/" or ".". Got: "${key}"`);
  }
}

export const MIN_SIGNED_URL_EXPIRY_SECONDS = STORAGE_CONFIG.minSignedUrlExpirySec;
export const MAX_SIGNED_URL_EXPIRY_SECONDS = STORAGE_CONFIG.maxSignedUrlExpirySec;

/**
 * Build a safe `Content-Disposition` value for a presigned GET download.
 *
 * RFC 6266 + RFC 5987: emit both an ASCII `filename="…"` fallback (for
 * ancient clients that ignore `filename*`) and a UTF-8 percent-encoded
 * `filename*=UTF-8''…` parameter (for modern browsers). The ASCII
 * fallback replaces any byte outside the printable-ASCII range — plus
 * control chars, backslash and double-quote — with `_` so header
 * injection is impossible and the quoted-string grammar of the header
 * is never broken.
 *
 * The server-side filename validator at the service boundary already
 * rejects control chars and path separators; this helper is the final
 * defence-in-depth layer that keeps the storage surface safe even if a
 * hostile filename were to slip past earlier validation.
 */
export function buildContentDisposition(fileName: string): string {
  // Stripping these control bytes is precisely the sanitizer's job;
  // without them the ASCII-fallback path would allow header injection
  // via a CR/LF smuggled into the Content-Disposition string.
  // eslint-disable-next-line no-control-regex
  const STRIP_TO_UNDERSCORE = /[\x00-\x1f\x7f"\\]/g;
  const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/g;
  const asciiFallback = fileName
    .replace(STRIP_TO_UNDERSCORE, '_')
    .replace(NON_PRINTABLE_ASCII, '_');
  const utf8Encoded = encodeURIComponent(fileName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

/**
 * Collapse the SDK's LifecycleRule into the structured snapshot the
 * safety validator consumes. Filter shape can be `{Prefix}`, `{Tag}`, or
 * `{And: {Prefix?, Tags?}}` — flatten into `(prefix, hasTagFilter)`.
 * Action fields are surfaced individually so the validator can emit a
 * specific failure per defect (Expiration.Days vs Transitions vs …),
 * matching the itemized runbook deny list.
 */
function toLifecycleRuleSnapshot(rule: LifecycleRule): LifecycleRuleSnapshot {
  let prefix = '';
  let hasTagFilter = false;
  if (rule.Filter) {
    if (rule.Filter.Prefix !== undefined) prefix = rule.Filter.Prefix;
    if (rule.Filter.Tag) hasTagFilter = true;
    if (rule.Filter.And) {
      if (rule.Filter.And.Prefix !== undefined) prefix = rule.Filter.And.Prefix;
      if ((rule.Filter.And.Tags?.length ?? 0) > 0) hasTagFilter = true;
    }
  } else {
    // Legacy non-Filter Prefix shape — pre-2018 S3 API. The SDK marks the
    // top-level `Prefix` field deprecated; we keep the read for defensive
    // parity with older buckets and S3-compatible providers that still
    // surface this shape. Routed through a structural cast so the
    // deprecation marker doesn't propagate to the editor on every read.
    const legacyPrefix = (rule as { Prefix?: string }).Prefix;
    if (legacyPrefix !== undefined) prefix = legacyPrefix;
  }

  const expiration = rule.Expiration;
  const expireDeleteMarker = expiration?.ExpiredObjectDeleteMarker === true;

  // `Expiration.Days = 0` is the encoding S3 uses when only
  // `ExpiredObjectDeleteMarker` is set — treat as absent.
  return {
    id: rule.ID,
    status: rule.Status ?? 'Disabled',
    prefix,
    hasTagFilter,
    noncurrentDays: rule.NoncurrentVersionExpiration?.NoncurrentDays,
    expireDeleteMarker,
    hasExpirationDays: (expiration?.Days ?? 0) > 0,
    hasExpirationDate: expiration?.Date !== undefined,
    hasTransitions: (rule.Transitions?.length ?? 0) > 0,
    hasNoncurrentTransitions: (rule.NoncurrentVersionTransitions?.length ?? 0) > 0,
    hasAbortMpu: rule.AbortIncompleteMultipartUpload !== undefined,
  };
}

export function createStorageClient(config: StorageConfig): AttachmentStorageClient {
  // Two clients on purpose:
  //   - `s3` (internal endpoint) — used for every operation whose HTTP
  //     request actually leaves this process: put/get/head/list/delete.
  //   - `s3Signing` (public endpoint) — used only by the presigning helpers,
  //     which compute the URL locally without making a network call. The
  //     URL is returned to the browser and must carry a host the browser
  //     can reach. In dev both endpoints collapse to the same host (MinIO
  //     exposed on localhost); in prod `publicEndpoint` is the
  //     reverse-proxied subdomain.
  // Collapsing into one client when `publicEndpoint` is absent is
  // intentional — keeps the code path identical for single-endpoint
  // deployments and keeps existing tests passing unchanged.
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });
  // `requestChecksumCalculation: 'WHEN_REQUIRED'` on the SIGNING client
  // suppresses the SDK's automatic CRC32 middleware for presigned URLs.
  // With the default `WHEN_SUPPORTED` (since `@aws-sdk/client-s3` v3.729),
  // the SDK precomputes `x-amz-checksum-crc32` over an empty body at signing
  // time and bakes it into the signed query string. B2 happens to tolerate
  // the discrepancy when `Content-MD5` is also present, but signing a CRC32
  // we never intend to verify is a fragile dependency on provider tolerance;
  // skipping it keeps the URL clean and the integrity guarantee on the path
  // we actually rely on — the signed `Content-MD5` header (see
  // `createPresignedPut`). Same setting on both presigned-PUT and
  // presigned-GET signing — GET has no body to checksum so it is benign.
  //
  // The non-signing `s3` keeps the default — server-side PUTs (test
  // seeding, bulk-zip pickup) need an integrity header to satisfy the S3
  // Object Lock contract under default retention (per ADR-0022), and the
  // SDK's auto-CRC32 supplies one without each call site computing MD5
  // by hand.
  const s3Signing = config.publicEndpoint
    ? new S3Client({
        endpoint: config.publicEndpoint,
        region: config.region ?? 'us-east-1',
        credentials: {
          accessKeyId: config.accessKey,
          secretAccessKey: config.secretKey,
        },
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
      })
    : new S3Client({
        endpoint: config.endpoint,
        region: config.region ?? 'us-east-1',
        credentials: {
          accessKeyId: config.accessKey,
          secretAccessKey: config.secretKey,
        },
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
      });

  const bucket = config.bucket;
  // keyPrefix shape is validated at config boundary so a misconfiguration
  // fails before the first PUT. Same regex as the STORAGE_KEY_PREFIX env
  // schema in `config/env.ts` — single source of truth would require an
  // extra import; the duplication is bounded to these two sites.
  const keyPrefix = config.keyPrefix ?? '';
  if (keyPrefix && !/^[a-z0-9][a-z0-9_-]*\/$/.test(keyPrefix)) {
    throw new Error(
      `StorageConfig.keyPrefix must be empty or match ^[a-z0-9][a-z0-9_-]*\\/$ ` +
        `(trailing slash required), got: "${keyPrefix}"`,
    );
  }
  // Wire-key encoder + decoder. Callers always speak in logical (bare)
  // keys; the S3 boundary speaks in prefixed keys. `wireKey()` is the
  // only call path that knows about the prefix.
  const wireKey = (key: string): string => keyPrefix + key;
  const stripPrefix = (full: string): string =>
    keyPrefix && full.startsWith(keyPrefix) ? full.slice(keyPrefix.length) : full;

  return {
    async upload(
      key: string,
      data: Buffer | Uint8Array,
      contentType: string,
    ): Promise<UploadResult> {
      validateKey(key);
      const res = await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: wireKey(key),
          Body: data,
          ContentType: contentType,
        }),
      );
      // On a versioned bucket the PUT response carries the new VersionId;
      // surface it so server-side writers (the takeout import runner) can
      // persist version_id without a follow-up HEAD round-trip.
      return { key, versionId: res.VersionId };
    },

    async download(key: string): Promise<DownloadResult> {
      validateKey(key);
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: wireKey(key),
        }),
      );

      const stream = response.Body;
      if (!stream) {
        throw new Error(`Empty response body for key: ${key}`);
      }

      // The SDK returns a readable stream (or Blob in browser).
      // In Node.js, Body has a transformToByteArray() helper.
      const bytes = await stream.transformToByteArray();
      const data = Buffer.from(bytes);

      return {
        data,
        contentType: response.ContentType ?? 'application/octet-stream',
      };
    },

    async getSignedUrl(key: string, expirySeconds: number): Promise<string> {
      validateKey(key);
      if (expirySeconds < MIN_SIGNED_URL_EXPIRY_SECONDS) {
        throw new Error(
          `expirySeconds must be at least ${MIN_SIGNED_URL_EXPIRY_SECONDS}. Got: ${expirySeconds}`,
        );
      }
      const clamped = Math.min(expirySeconds, MAX_SIGNED_URL_EXPIRY_SECONDS);
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: wireKey(key),
      });
      return getSignedUrl(s3Signing, command, { expiresIn: clamped });
    },

    async ping(): Promise<void> {
      // Reachability + auth + bucket-access probe. We deliberately do NOT
      // use HeadBucket: B2 maps it to b2_list_buckets, which requires the
      // account-scoped `listAllBucketNames` capability. ADR-0022 prescribes
      // a bucket-restricted app key, and bucket-restricted keys cannot
      // hold `listAllBucketNames` — so HeadBucket returns 403 against B2
      // even though every other call we make against the bucket succeeds.
      // (MinIO/AWS would accept HeadBucket; the cross-provider lowest
      // common denominator is ListObjectsV2.)
      //
      // ListObjectsV2 with MaxKeys=1 against the safety-probe prefix is the
      // canonical replacement: it exercises the same `listFiles` capability
      // the app already requires per ADR-0022, returns in a single
      // round-trip whether or not any objects match, and verifies endpoint,
      // credentials, AND bucket access in one shot — same contract the old
      // HeadBucket comment claimed. The `__probe/` prefix keeps the call
      // bounded so a populated bucket doesn't waste bandwidth listing user
      // keys.
      await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1, Prefix: wireKey('__probe/') }),
      );
    },

    async createPresignedPut(
      key: string,
      contentType: string,
      sizeBytes: number,
      contentMd5Base64: string,
      expirySeconds: number = 60,
    ): Promise<PresignedPutDescriptor> {
      validateKey(key);
      // Three signed headers — the load-bearing pins of AC-245:
      //  * `Content-Type` — exact MIME type. Defense-in-depth: the
      //    complete() flip re-asserts via HEAD against the declared
      //    `mimeType`; the SigV4 binding makes the URL unusable for a
      //    different type to begin with.
      //  * `Content-Length` — exact body size. POST policy used a range;
      //    PUT pins one number per signed URL, which is strictly tighter
      //    given the client always knows the exact size at init time.
      //  * `Content-MD5` — RFC 1864 base64. Required by B2 (Object Lock
      //    + bucket-default retention attaches Object Lock parameters to
      //    every PutObject; bare PUTs are rejected). Doubles as the
      //    body-binding guarantee — providers verify Content-MD5 against
      //    received bytes and reject `BadDigest` on mismatch, so the
      //    signed URL is reusable only for an upload of bytes that hash
      //    to this exact MD5.
      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
        throw new Error(
          `createPresignedPut: sizeBytes must be a positive integer, got ${sizeBytes}`,
        );
      }
      // RFC 1864 MD5 base64: 16-byte digest → 24 chars ending with `==`.
      // The 21st char is `[A-Za-z0-9+/]` and the 22nd char is one of
      // `[AQgw]` — only those four values can hold the trailing zero
      // bits a 16-byte input forces. Tighter than the 22-char-anything
      // shape: catches non-canonical inputs before the storage provider
      // has to BadDigest them.
      if (
        typeof contentMd5Base64 !== 'string' ||
        !/^[A-Za-z0-9+/]{21}[AQgw]==$/.test(contentMd5Base64)
      ) {
        throw new Error('createPresignedPut: contentMd5Base64 must be RFC 1864 base64 of MD5');
      }
      const expiresIn = Math.max(1, expirySeconds);
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: wireKey(key),
        ContentType: contentType,
        ContentLength: sizeBytes,
        ContentMD5: contentMd5Base64,
      });
      // `signableHeaders` overrides the SDK's default unsignable list
      // (which marks `content-type` as unsignable) so `Content-Type`,
      // `Content-Length`, and `Content-MD5` all land in
      // `X-Amz-SignedHeaders` and are bound by the signature.
      // (`unhoistableHeaders` is for `x-amz-*` headers — it has no
      // effect on these three, so it is omitted.)
      const url = await getSignedUrl(s3Signing, command, {
        expiresIn,
        signableHeaders: new Set(['content-type', 'content-length', 'content-md5']),
      });
      return {
        url,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(sizeBytes),
          'Content-MD5': contentMd5Base64,
        },
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
    },

    async createPresignedGet(
      key: string,
      expirySeconds: number = 5 * 60,
      attachmentFileName?: string,
    ): Promise<PresignedGetDescriptor> {
      validateKey(key);
      if (expirySeconds < MIN_SIGNED_URL_EXPIRY_SECONDS) {
        throw new Error(
          `expirySeconds must be at least ${MIN_SIGNED_URL_EXPIRY_SECONDS}. Got: ${expirySeconds}`,
        );
      }
      const clamped = Math.min(expirySeconds, MAX_SIGNED_URL_EXPIRY_SECONDS);
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: wireKey(key),
        ...(attachmentFileName
          ? { ResponseContentDisposition: buildContentDisposition(attachmentFileName) }
          : {}),
      });
      const url = await getSignedUrl(s3Signing, command, { expiresIn: clamped });
      return {
        url,
        expiresAt: new Date(Date.now() + clamped * 1000).toISOString(),
      };
    },

    async headObject(key: string): Promise<HeadObjectResult> {
      validateKey(key);
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: wireKey(key) }));
        return {
          size: Number(res.ContentLength ?? 0),
          contentType: res.ContentType ?? 'application/octet-stream',
          versionId: res.VersionId,
        };
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
          throw new StorageObjectNotFoundError(key);
        }
        throw err;
      }
    },

    async hide(key: string): Promise<void> {
      validateKey(key);
      // DeleteObject WITHOUT VersionId on a versioned bucket creates a
      // delete marker — the version becomes "noncurrent" and reads return
      // 404, but the bytes survive until the lifecycle reap (ADR-0022).
      // Idempotent like S3 DeleteObject — succeeds on missing keys.
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: wireKey(key) }));
    },

    async copyFromVersion(key: string, sourceVersionId: string): Promise<string | undefined> {
      validateKey(key);
      if (!sourceVersionId) {
        throw new Error('copyFromVersion: sourceVersionId is required');
      }
      // Probe the source with a versioned HEAD before issuing the CopyObject.
      // CopyObject's response when the source version is unaddressable is
      // provider-inconsistent: AWS / MinIO return 404 NoSuchVersion, but B2
      // returns the SAME 500 InternalError it uses for genuine outages
      // (observed shape: `S3ServiceException name=InternalError, Code=
      // InternalError, httpStatusCode=500` after three internal retries).
      // The 500-vs-404 collision means we cannot read CopyObject's status
      // alone to distinguish "bytes are gone" from "provider is down" — so
      // we run a deterministic probe first. HeadObject with VersionId is
      // the cheap canonical check across providers; the responses we treat
      // as "version unaddressable" are:
      //   * 404 (NoSuchKey / NoSuchVersion / NotFound — AWS, MinIO).
      //   * 400 — B2 emits this for a malformed VersionId (e.g. a UUID
      //     left over from a dev→VPS sync's mc-mirror that issued fresh
      //     B2 versionIds the DB doesn't reflect).
      //   * 403 — B2 emits this for a structurally valid VersionId that
      //     points at no object (lifecycle reap, foreign-id collision).
      // Other 4xx (408, 429, 451, …) and every 5xx bubble — they are
      // retryable / operator-relevant and must NOT collapse into the
      // "permanently gone" surface; the global handler turns them into
      // a 5xx the operator can see in the logs.
      try {
        await s3.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: wireKey(key),
            VersionId: sourceVersionId,
          }),
        );
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        const status = e.$metadata?.httpStatusCode;
        if (
          e.name === 'NoSuchKey' ||
          e.name === 'NoSuchVersion' ||
          e.name === 'NotFound' ||
          status === 400 ||
          status === 403 ||
          status === 404
        ) {
          throw new StorageObjectNotFoundError(key);
        }
        throw err;
      }

      // CopySource format per AWS S3 docs: "<bucket>/<key>?versionId=<vid>".
      // The bucket and version-id are app-controlled; the key is already
      // validated by validateKey() against STORAGE_CONFIG.validKeyPattern.
      // Slashes inside the key remain raw — encoding them would change the
      // semantic CopySource path. The SDK URL-encodes the rest.
      try {
        const response = await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: wireKey(key),
            CopySource: `${bucket}/${wireKey(key)}?versionId=${encodeURIComponent(sourceVersionId)}`,
          }),
        );
        return response.VersionId;
      } catch (err) {
        // Defensive: a noncurrent version could in principle vanish
        // between HEAD and CopyObject (lifecycle reap landing on the wire
        // mid-call). The HEAD already proved the version was addressable,
        // so the only 4xx fingerprint that's plausible here is a 404 —
        // narrower than the HEAD probe's catch on purpose. Anything else
        // bubbles as a genuine fault.
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (
          e.name === 'NoSuchKey' ||
          e.name === 'NoSuchVersion' ||
          e.name === 'NotFound' ||
          e.$metadata?.httpStatusCode === 404
        ) {
          throw new StorageObjectNotFoundError(key);
        }
        throw err;
      }
    },

    async getObject(key: string): Promise<Readable> {
      validateKey(key);
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: wireKey(key) }));
        const body = response.Body;
        if (!body) {
          throw new Error(`Empty response body for key: ${key}`);
        }
        // In Node.js, the SDK returns a Readable (IncomingMessage). The
        // SdkStream mixin exposes `transformTo*` helpers, but we want the
        // raw stream so archiver can pipe it. Narrow to `Readable` — the
        // browser branch of `StreamingBlobPayloadOutputTypes` never
        // surfaces on the server.
        return body as unknown as Readable;
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (
          e.name === 'NoSuchKey' ||
          e.name === 'NotFound' ||
          e.$metadata?.httpStatusCode === 404
        ) {
          throw new StorageObjectNotFoundError(key);
        }
        throw err;
      }
    },

    async putObject(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
      validateKey(key);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: wireKey(key),
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    async getBucketSafetyConfig(): Promise<BucketSafetyConfig> {
      // Three independent reads — versioning, object-lock, lifecycle.
      // Each can succeed/fail independently; the validator handles the
      // "feature not enabled" cases as semantic absence (versioningEnabled=
      // false, objectLock.enabled=false, lifecycleRules=[]).
      const ver = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      const versioningEnabled = ver.Status === 'Enabled';

      let objectLock: BucketSafetyConfig['objectLock'] = { enabled: false };
      try {
        const ol = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
        if (ol.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled') {
          objectLock = {
            enabled: true,
            defaultMode: ol.ObjectLockConfiguration.Rule?.DefaultRetention?.Mode,
            defaultDays: ol.ObjectLockConfiguration.Rule?.DefaultRetention?.Days,
          };
        }
      } catch (err) {
        const e = err as { name?: string };
        // ObjectLockConfigurationNotFoundError when the bucket was
        // created without --with-lock. Fall through to enabled:false so
        // the validator surfaces a structured failure instead of an
        // opaque SDK error.
        if (e.name !== 'ObjectLockConfigurationNotFoundError') throw err;
      }

      let lifecycleRules: BucketSafetyConfig['lifecycleRules'] = [];
      try {
        const lc = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
        lifecycleRules = (lc.Rules ?? []).map(toLifecycleRuleSnapshot);
      } catch (err) {
        const e = err as { name?: string };
        // NoSuchLifecycleConfiguration when no rules — semantic absence.
        if (e.name !== 'NoSuchLifecycleConfiguration') throw err;
      }

      return { versioningEnabled, objectLock, lifecycleRules };
    },

    async probeDeleteVersionCapability(): Promise<CapabilityProbeResult> {
      // Capability self-test — see safety.ts header for the rationale.
      // The call is constructed to be intentionally destructive in
      // shape (DeleteObjectCommand + VersionId) but pointed at a
      // non-existent key with a non-existent VersionId, so a properly-
      // restricted credential responds with AccessDenied at the
      // capability layer before any object resolution happens.
      //
      // This is the ONE legitimate site in the codebase that constructs
      // a `DeleteObjectCommand` carrying a `VersionId` — the architecture
      // test (`src/server/__tests__/storage-architecture.test.ts`)
      // exempts it via an explicit `SITE_ALLOWLIST` entry keyed on
      // `{ file: 'src/server/storage/client.ts', functionName:
      // 'probeDeleteVersionCapability' }`. The exception is architectural,
      // not an evasion: this is the call the probe MUST make to validate
      // the capability split. If the function is renamed or moved, the
      // allowlist entry must change at the same commit — the test
      // enforces no other file may declare a function with this name.
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: wireKey(CAPABILITY_PROBE_KEY),
            VersionId: CAPABILITY_PROBE_VERSION_ID,
          }),
        );
        // 2xx success — the credential CAN destroy versions. This is
        // the catastrophic case the probe was added to catch.
        return { kind: 'unexpected-success' };
      } catch (err) {
        const e = err as { name?: string; message?: string; Code?: string };
        // The SDK exposes the modelled `AccessDenied` exception class
        // by `name === 'AccessDenied'`. B2's S3-compat surface returns
        // the same name with `not entitled` in the message; MinIO
        // restricted users return the same name from IAM denial. AWS
        // S3 also returns this name. One uniform check across providers.
        if (e.name === 'AccessDenied' || e.Code === 'AccessDenied') {
          return { kind: 'access-denied' };
        }
        return {
          kind: 'unexpected-error',
          errorName: e.name ?? 'UnknownError',
          message: e.message ?? String(err),
        };
      }
    },

    async listObjects(prefix: string, olderThan?: Date): Promise<string[]> {
      // No `validateKey` on `prefix` — a prefix is a substring match,
      // not a key. It still must stay in the allowed charset so a
      // caller cannot probe arbitrary bucket namespaces. Reuses the
      // same pattern as keys (single source of truth in STORAGE_CONFIG).
      if (!prefix || !STORAGE_CONFIG.validKeyPattern.test(prefix)) {
        throw new Error(`Invalid listObjects prefix: "${prefix}"`);
      }
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: wireKey(prefix),
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of response.Contents ?? []) {
          const k = obj.Key;
          if (typeof k !== 'string') continue;
          if (olderThan && obj.LastModified && obj.LastModified >= olderThan) continue;
          // Strip the per-process prefix so callers see logical keys —
          // the same shape they pass to `headObject`, `hide`, etc.
          keys.push(stripPrefix(k));
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
  };
}
