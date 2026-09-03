/**
 * Bucket orphan reconciliation — objects with no `attachments` row.
 *
 * Lists every current-version object in the configured bucket, subtracts
 * the keys still referenced by the `attachments` table (across every
 * status — `hidden` rows still hold a PUT version below their delete
 * marker that the un-hide flow promotes back), and writes a delete marker
 * (DeleteObject without VersionId) for the difference via the storage
 * client's `hide()` primitive.
 *
 * Two callers:
 *   - `bucket-orphan-prune-scheduler.ts` — the periodic sweep in the app
 *     process. This is the whole mechanism: it shares the app's env, so
 *     the bucket it lists and the DB it diffs against are the ones the
 *     app itself serves, in dev and in production alike. There is no
 *     command to run and no flag to set.
 *   - `start.ts` under `SEED=force`, so a forced re-seed truly resets
 *     storage state along with the DB. Without this, a re-seed truncates
 *     `attachments` but leaves the bucket dirty — the orphan blobs are
 *     unreadable in practice (per-row wrapped DEKs went away with the
 *     truncate), but they still consume bucket space and would mirror
 *     real bytes onto B2's Compliance-locked bucket via
 *     `scripts/sync-dev-to-vps.sh` if its pollution guard didn't refuse.
 *
 * ## Why the set difference is sound
 *
 * The bucket holds three key namespaces: `attachments/…`
 * (AttachmentService), `invoices/…` (InvoiceBinaryService) — both rows
 * in the `attachments` table — and `__probe/…`, the deploy-preflight
 * sentinels (`deploy-preflight-cli.ts`), which have no row and never
 * will. Backups live in a separate R2 bucket; takeout staging is local
 * VPS disk. So `attachments` indexes everything under the two app
 * namespaces, and `RESERVED_KEY_PREFIXES` carves out the third.
 *
 * ## Why a min-age is required, not optional
 *
 * `AttachmentService.initUpload` INSERTs the `pending` row BEFORE
 * presigning the PUT, so a browser upload is never an orphan mid-flight.
 * The other two writers invert that order:
 *   - `InvoiceBinaryService.persistRendered` PUTs the ciphertext, HEADs
 *     it, then INSERTs the row — inside the issuance transaction, so the
 *     row is invisible until that transaction commits.
 *   - `takeout-import-runner` Pass 2 PUTs original + thumbnail, then
 *     INSERTs.
 * Between the PUT and the commit the object is listable with no row
 * behind it — indistinguishable from an orphan by set difference alone.
 * `minAgeMinutes` is what makes it distinguishable: an object younger
 * than the cutoff is left alone. Objects whose `LastModified` the
 * provider omits are treated as unknown-age and skipped for the same
 * reason. #169 item B reorders both writers, after which the min-age
 * becomes belt-and-braces rather than load-bearing.
 *
 * ## Why the empty-preserve refusal exists
 *
 * The diff is only meaningful if the DB owns the bucket. Running inside
 * the app process makes that true by construction — but not
 * permanently: restore an older dump, or point the app at a fresh
 * database while keeping the bucket, and every object reads as
 * unreferenced. `requireReferencedRows` refuses to hide when the sweep
 * would preserve nothing out of a non-empty candidate set, which is
 * that mismatch's fingerprint. `SEED=force` legitimately reaches that
 * state (it just truncated `attachments`) and opts out.
 *
 * ## Versioning + Object Lock semantics
 *
 * `storage.hide(key)` is DeleteObject without a VersionId on a versioned
 * bucket — only a delete marker is written, the current version becomes
 * noncurrent, and the underlying bytes remain locked under the bucket's
 * default Compliance retention until R + L days pass and the lifecycle
 * rule reaps them. The goal here is a clean current view, not freed
 * bytes. Note the marker is liftable via `copyFromVersion` but NOT
 * through the Papierkorb for `invoices/…` keys — those rows are excluded
 * from both the live and trash listings (`repositories/attachment.ts`)
 * and carry `hiddenAt = null`. Recovering a wrongly-hidden invoice PDF
 * is a manual operation, which is why the two guards above are
 * structural rather than advisory.
 *
 * ## Cost
 *
 * `ListObjectsV2` is a Backblaze Class C call, and Class A/B/C are all
 * free on B2 pay-as-you-go (only Class D, event notifications, is
 * billed). A full sweep costs nothing at any cadence.
 *
 * ## Bucket-listing dependency injection
 *
 * The caller supplies the `listBucketObjects` closure. Production wires
 * it through `createBucketObjectLister()` (paginated ListObjectsV2
 * against the configured bucket); tests pass a stub returning a
 * controlled set so a test run cannot wipe the developer's working
 * bucket — the prune is unbounded by design (it operates on the WHOLE
 * bucket), and the integration suite shares `STORAGE_BUCKET` with
 * `npm run dev`.
 */
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';

import type { Database } from '../db/connection.js';
import type { AttachmentStorageClient } from './client.js';

const MS_PER_MINUTE = 60 * 1000;

/**
 * Key namespaces the bucket carries that are NOT indexed by
 * `attachments` and must never be treated as orphans.
 *
 * `__probe/` holds the deploy-preflight sentinels `__probe/upload` and
 * `__probe/copyobj` (`deploy-preflight-cli.ts`), rewritten on every
 * deploy. Hiding them is harmless — the next preflight PUTs a fresh
 * version before the copy reads it — but it would make every sweep on a
 * real deployment report orphans, and an operator who learns to ignore
 * this report loses the only signal that says the bucket is clean.
 */
export const RESERVED_KEY_PREFIXES = ['__probe/'] as const;

function isReserved(key: string): boolean {
  return RESERVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export interface BucketKeyListerConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  /**
   * Optional per-process key namespace, matching `StorageConfig.keyPrefix`.
   * When set, the lister scopes its ListObjectsV2 to keys under this
   * prefix AND strips the prefix from returned keys — so the prune
   * compares logical-key sets (bucket scope vs DB attachments rows,
   * which also store logical keys). Without this, a prune launched
   * from a prefixed context (vitest fork) would treat every other
   * fork's prefix as orphan.
   */
  keyPrefix?: string;
}

/** One current-version object as the diff sees it. */
export interface BucketObject {
  /** Logical key — the shape `attachments` rows store. */
  key: string;
  /**
   * Provider-reported write time. Optional because S3-compatible
   * providers may omit it; an object with no timestamp is unknown-age
   * and is never pruned while a min-age is configured.
   */
  lastModified?: Date;
}

export interface PruneBucketOrphansLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface PruneBucketOrphansResult {
  /** App-owned objects listed — `RESERVED_KEY_PREFIXES` excluded. */
  bucketObjectCount: number;
  /** Listed objects still referenced by an `attachments` row. */
  preservedCount: number;
  /**
   * Unreferenced objects left alone because they are younger than
   * `minAgeMinutes` (or carry no `lastModified`). A standing non-zero
   * value across sweeps means a writer is leaking, not that the sweep
   * is behind.
   */
  skippedRecentCount: number;
  orphanCount: number;
}

export interface PruneBucketOrphansOptions {
  db: Database;
  storage: AttachmentStorageClient;
  listBucketObjects: () => Promise<BucketObject[]>;
  logger: PruneBucketOrphansLogger;
  bucketLabel: string;
  /**
   * Grace window protecting the PUT-before-INSERT writers (see header).
   * `0` disables it — only `SEED=force`, which owns the whole bucket
   * and wants a full reset, passes that.
   */
  minAgeMinutes: number;
  /**
   * Refuse to hide when the sweep would preserve nothing out of a
   * non-empty candidate set — the bucket/DB mismatch fingerprint (see
   * header). `SEED=force` passes `false`.
   */
  requireReferencedRows: boolean;
  /** Injectable wall clock, matching the reaper schedulers. */
  now?: Date;
}

/**
 * Build the production lister: paginated ListObjectsV2 over the whole
 * bucket. Tests don't use this — they pass a stub that returns a
 * controlled set.
 */
export function createBucketObjectLister(
  config: BucketKeyListerConfig,
): () => Promise<BucketObject[]> {
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    forcePathStyle: true,
  });

  const keyPrefix = config.keyPrefix ?? '';
  return async () => {
    const objects: BucketObject[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          // Empty prefix lists the entire bucket (the prod-shape behaviour).
          // With a per-process keyPrefix, restrict to that namespace so a
          // prune from one vitest fork cannot see siblings.
          ...(keyPrefix ? { Prefix: keyPrefix } : {}),
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of response.Contents ?? []) {
        if (typeof obj.Key !== 'string') continue;
        // Return logical keys (the same shape the attachments rows store)
        // so the diff against the DB-referenced set is apples-to-apples.
        objects.push({
          key:
            keyPrefix && obj.Key.startsWith(keyPrefix) ? obj.Key.slice(keyPrefix.length) : obj.Key,
          ...(obj.LastModified ? { lastModified: obj.LastModified } : {}),
        });
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  };
}

export async function pruneBucketOrphans(
  opts: PruneBucketOrphansOptions,
): Promise<PruneBucketOrphansResult> {
  const { db, storage, logger, bucketLabel, minAgeMinutes, requireReferencedRows } = opts;
  if (!Number.isInteger(minAgeMinutes) || minAgeMinutes < 0) {
    throw new Error(
      `pruneBucketOrphans: minAgeMinutes must be a non-negative integer, got ${minAgeMinutes}`,
    );
  }
  const runAt = opts.now ?? new Date();
  const cutoff = new Date(runAt.getTime() - minAgeMinutes * MS_PER_MINUTE);

  // 1. Bucket listing — current-version view only. Reserved namespaces
  // are dropped here so they cannot reach any count or the diff.
  const listed = await opts.listBucketObjects();
  const candidates = listed.filter((obj) => !isReserved(obj.key));

  // 2. DB-referenced keys — every status (`pending`, `ready`, `hidden`).
  // `hidden` rows hold a legitimate PUT version below the delete marker
  // that the un-hide flow needs; preserving those keys here matches the
  // bash script's UNION.
  //
  // Ordering matters: the listing is taken BEFORE this read, so a row
  // that commits between the two is still seen as referenced. The
  // reverse order would manufacture orphans.
  const referencedRows = await db.execute<{ key: string }>(sql`
    SELECT original_key AS key FROM attachments
    UNION
    SELECT thumb_key AS key FROM attachments WHERE thumb_key IS NOT NULL
  `);
  const referencedKeys = new Set<string>();
  for (const row of referencedRows.rows) {
    if (typeof row.key === 'string') referencedKeys.add(row.key);
  }

  // 3. Orphans = listed − referenced − too-recent.
  const orphans: string[] = [];
  let preservedCount = 0;
  let skippedRecentCount = 0;
  for (const obj of candidates) {
    if (referencedKeys.has(obj.key)) {
      preservedCount += 1;
      continue;
    }
    // Unknown age is treated as "too recent": a provider that omits
    // LastModified gives us no basis to claim the write has settled.
    if (minAgeMinutes > 0 && !(obj.lastModified && obj.lastModified < cutoff)) {
      skippedRecentCount += 1;
      continue;
    }
    orphans.push(obj.key);
  }

  // 4. Coherence gate — BEFORE the first hide, so a mismatched pairing
  // costs nothing. See the header: this is the shape a wrong DB takes.
  if (requireReferencedRows && preservedCount === 0 && candidates.length > 0) {
    throw new Error(
      `pruneBucketOrphans: refusing to hide ${orphans.length} object(s) in bucket ` +
        `'${bucketLabel}' — not one of the ${candidates.length} listed object(s) is referenced ` +
        `by an attachments row. That is what a bucket/database mismatch looks like, not a dirty ` +
        `bucket. Verify DATABASE_URL and STORAGE_BUCKET name the same deployment before retrying.`,
    );
  }

  // 5. Hide each orphan via the storage wrapper's hide() primitive — same
  // call shape as the orphan reaper, idempotent on a versioned bucket.
  // Each key is logged as it goes, so a fault mid-loop still leaves a
  // record of what was already hidden.
  for (const key of orphans) {
    await storage.hide(key);
    logger.info(`pruneBucketOrphans: hid ${key}`);
  }

  const tally =
    `preserved ${preservedCount} referenced, ` +
    (skippedRecentCount > 0 ? `${skippedRecentCount} too recent to judge, ` : '') +
    `total ${candidates.length}`;

  if (orphans.length > 0) {
    logger.warn(
      `pruneBucketOrphans: hid ${orphans.length} orphan object(s) in bucket '${bucketLabel}' ` +
        `(${tally}).`,
    );
  } else {
    logger.info(`pruneBucketOrphans: no orphans in bucket '${bucketLabel}' (${tally}).`);
  }

  return {
    bucketObjectCount: candidates.length,
    preservedCount,
    skippedRecentCount,
    orphanCount: orphans.length,
  };
}
