/**
 * Production R2 uploader + downloader for Layer 2 backups.
 *
 * R2 is S3-compatible when addressed at the account-scoped endpoint
 * with a `region` of `auto`. We reuse `@aws-sdk/client-s3` — the same
 * SDK `storage/client.ts` uses — because pulling a second S3 client
 * into the tree would duplicate credential-handling code paths with
 * no upside.
 *
 * Architecture layering (architecture.md §11.2):
 *   - This module is the wire-level R2 adapter. It exposes ONLY the
 *     methods the backup service consumes (upload, putStatusMirror,
 *     downloadLatestDumpAndManifest). Higher-level orchestration
 *     (encrypt, manifest comparison) lives in `services/backup.ts`
 *     and `services/backup-drill.ts`.
 *   - No log statements carry the secret access key. The access key
 *     ID is fine to surface in error diagnostics; the secret never is.
 *
 * Key conventions (ADR-0020 §Decision):
 *   daily/<iso>.dump.age
 *   daily/<iso>.manifest.json.age
 *   status/latest.json
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import type { BackupUploader } from './backup.js';

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 uses `auto`; accepting via config so other S3-compatible
   * endpoints (MinIO in dev) remain swappable without a code change. */
  region?: string;
}

/**
 * Download surface the drill service consumes. Separated from the
 * upload surface so the CLI can wire only what each subcommand needs
 * (run → uploader; drill → downloader).
 */
export interface BackupDownloader {
  /**
   * Returns the most recent `daily/*.dump.age` + its sidecar manifest
   * alongside the `key` stem (ISO timestamp stripped of suffix), or
   * throws with a typed cue if there is no prior artifact.
   */
  downloadLatestDumpAndManifest(): Promise<{
    dump: Uint8Array;
    manifest: Uint8Array;
    key: string;
  }>;
}

const STATUS_MIRROR_KEY = 'status/latest.json';
const DAILY_PREFIX = 'daily/';
const DUMP_SUFFIX = '.dump.age';
const MANIFEST_SUFFIX = '.manifest.json.age';

/**
 * Authenticated reachability probe (`HeadBucket`). Runs at schedule
 * startup so a stale credential, bucket-scope typo, or dead endpoint
 * surfaces as a container restart loop at deploy time — not silently
 * an hour later at the first cron tick. Mirrors the app's MinIO
 * HeadBucket gate in `storage/safety.ts`.
 *
 * Throws with `name + message + httpStatus` so 403 (bad secret, wrong
 * bucket scope) vs 404 (bucket missing) vs 5xx (R2 outage) is obvious
 * from the log without cross-referencing the SDK internals. Secrets
 * never hit the message.
 */
export async function probeR2HeadBucket(config: R2Config): Promise<void> {
  const client = buildClient(config);
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch (err) {
    const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    const name = e.name ?? 'Error';
    const message = typeof e.message === 'string' ? e.message : String(err);
    const status = e.$metadata?.httpStatusCode ?? 'unknown';
    throw new Error(`R2 HeadBucket failed: ${name}: ${message} (http=${String(status)})`, {
      cause: err,
    });
  } finally {
    client.destroy();
  }
}

/**
 * Build a backup uploader. Construct once at startup and reuse across
 * calls — the underlying S3 client pools HTTP connections.
 */
export function createR2Uploader(config: R2Config): BackupUploader {
  const client = buildClient(config);
  const bucket = config.bucket;

  return {
    async upload(key: string, data: Uint8Array, contentType: string): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
        }),
      );
    },

    async putStatusMirror(status: unknown): Promise<void> {
      // Serialize here so the caller can remain agnostic to the wire
      // format. The status mirror is unencrypted by design (ADR-0020):
      // it exists so operators can read freshness even without age
      // identity material. The object carries no PII — only the
      // data-model.md §5.9 badge fields — so plaintext is correct.
      const body = Buffer.from(JSON.stringify(status), 'utf-8');
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: STATUS_MIRROR_KEY,
          Body: body,
          ContentType: 'application/json',
        }),
      );
    },
  };
}

/**
 * Build a downloader for the drill path. Lists objects under `daily/`,
 * picks the lexically-latest matching key (ISO 8601 sorts chronological-
 * ly), and fetches both the dump and the sidecar manifest.
 */
export function createR2Downloader(config: R2Config): BackupDownloader {
  const client = buildClient(config);
  const bucket = config.bucket;

  return {
    async downloadLatestDumpAndManifest(): Promise<{
      dump: Uint8Array;
      manifest: Uint8Array;
      key: string;
    }> {
      const dumpKey = await latestKeyWithSuffix(client, bucket, DUMP_SUFFIX);
      if (dumpKey === null) {
        throw new Error('no backup artifacts found under daily/ prefix');
      }
      const stem = dumpKey.slice(DAILY_PREFIX.length, dumpKey.length - DUMP_SUFFIX.length);
      const manifestKey = `${DAILY_PREFIX}${stem}${MANIFEST_SUFFIX}`;

      const [dump, manifest] = await Promise.all([
        downloadToBuffer(client, bucket, dumpKey),
        downloadToBuffer(client, bucket, manifestKey),
      ]);

      return { dump, manifest, key: stem };
    },
  };
}

// ---------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------

/**
 * Wall-clock bound for a single R2 request (AC-345).
 *
 * The SDK's default is no bound at all: `@smithy/node-http-handler`
 * ships `requestTimeout`, `connectionTimeout` and `socketTimeout` all
 * at `0`. A black-holed connection to R2 therefore parks the tick
 * exactly as a hung `pg_dump` would — and croner's `protect: true` then
 * suppresses every later run, with the freshness badge still green on
 * its last success. R2 is the run's only off-host dependency, so it is
 * the likeliest thing here to hang.
 *
 * `throwOnRequestTimeout` is not optional garnish: without it the
 * handler only logs a warning at the bound and keeps waiting.
 *
 * Sized like `PG_DUMP_TIMEOUT_MS` — unreachable in normal operation
 * (attachment binaries live in R2 under Layer 3, so the dump itself
 * stays small) while keeping a wedged run's collateral to minutes. The
 * SDK's default 3 attempts put the worst case per object at 15 minutes;
 * a run touches three objects and the tick interval is three hours.
 */
const R2_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Bound on establishing the TCP+TLS connection, before any request. */
const R2_CONNECTION_TIMEOUT_MS = 10_000;

const R2_REQUEST_HANDLER = {
  requestTimeout: R2_REQUEST_TIMEOUT_MS,
  connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
  throwOnRequestTimeout: true,
} as const;

/**
 * Exported so the bound is asserted without a network round trip — same
 * reason `pgDumpArgs` is extracted in `backup.ts`. Drop the
 * `requestHandler` here, or `throwOnRequestTimeout` from it, and every
 * other test stays green while the client silently stops bounding.
 */
export function buildClient(config: R2Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'auto',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // R2's S3 compatibility recommends path-style addressing; some hosts
    // accept virtual-host style too. Path-style is the safe default and
    // matches what `storage/client.ts` already uses for MinIO.
    forcePathStyle: true,
    requestHandler: R2_REQUEST_HANDLER,
  });
}

/**
 * List `daily/` and return the lexically-greatest key that ends with
 * `suffix`, or `null` if none exists. ISO 8601 timestamps sort
 * chronologically under lexical order, so the max key is the newest.
 *
 * Handles pagination — a deployment that keeps hundreds of dailies can
 * exceed the 1000-object default page size.
 */
async function latestKeyWithSuffix(
  client: S3Client,
  bucket: string,
  suffix: string,
): Promise<string | null> {
  let continuationToken: string | undefined;
  let best: string | null = null;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: DAILY_PREFIX,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of response.Contents ?? []) {
      const key = obj.Key;
      if (typeof key !== 'string') continue;
      if (!key.endsWith(suffix)) continue;
      if (best === null || key > best) best = key;
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return best;
}

async function downloadToBuffer(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = response.Body;
  if (!body) {
    throw new Error(`empty body for ${key}`);
  }
  // Body in Node carries `transformToByteArray()`. The storage client
  // module relies on the same shape, so this is a known-safe path.
  const bytes = await body.transformToByteArray();
  return bytes;
}
