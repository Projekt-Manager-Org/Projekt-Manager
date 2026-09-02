/**
 * Bucket orphan prune — TS counterpart of `scripts/clean-bucket-orphans.sh`.
 *
 * Lists every current-version object in the configured bucket, intersects
 * with the keys still referenced by the `attachments` table (across every
 * status — `hidden` rows still hold a PUT version below their delete
 * marker that the un-hide flow promotes back), and writes a delete marker
 * (DeleteObject without VersionId) for the difference via the storage
 * client's `hide()` primitive.
 *
 * Two callers:
 *   - `start.ts` under `SEED=force`, so a forced re-seed truly resets
 *     storage state along with the DB. Without this, a re-seed truncates
 *     `attachments` but leaves the bucket dirty — the orphan blobs are
 *     unreadable in practice (per-row wrapped DEKs went away with the
 *     truncate), but they still consume bucket space and would mirror
 *     real bytes onto B2's Compliance-locked bucket via
 *     `scripts/sync-dev-to-vps.sh` if its pollution guard didn't refuse.
 *   - `scripts/prune-bucket-orphans.ts`, the operator-run reconciliation
 *     (issue #169). Dry-run by default; `--apply` opts into hiding.
 *
 * Why the set difference is exact: the bucket holds exactly two key
 * namespaces, `attachments/…` (AttachmentService) and `invoices/…`
 * (InvoiceBinaryService), and BOTH are rows in the `attachments` table.
 * Backups live in a separate R2 bucket; takeout staging is local VPS
 * disk. So `attachments` is a complete index of this bucket and
 * "in the bucket, not in the table" means orphan with no prefix caveats.
 *
 * Why no age filter: `AttachmentService.initUpload` INSERTs the
 * `pending` row BEFORE presigning the PUT, so an object can never exist
 * in the bucket without its key already being referenced. An in-flight
 * upload is therefore never an orphan and needs no grace window.
 *
 * Cost: `ListObjectsV2` is a Backblaze Class C call, and Class A/B/C are
 * all free on B2 pay-as-you-go (only Class D, event notifications, is
 * billed). A full sweep costs nothing at any cadence.
 *
 * Versioning + Object Lock semantics: `storage.hide(key)` is DeleteObject
 * without a VersionId on a versioned bucket — only a delete marker is
 * written, the current version becomes noncurrent, and the underlying
 * bytes remain locked under the bucket's default Compliance retention
 * until R + L days pass and the lifecycle rule reaps them. The goal here
 * is a clean current view, not freed bytes.
 *
 * Bucket-listing dependency injection: the caller supplies the
 * `listAllBucketKeys` closure. Production wires it through
 * `createBucketKeyLister()` (paginated ListObjectsV2 against the
 * configured bucket); tests pass a stub returning a controlled set so a
 * test run cannot wipe the developer's working bucket — pruneBucketOrphans
 * is unbounded by design (it operates on the WHOLE bucket), and the
 * integration suite shares `STORAGE_BUCKET` with `npm run dev`.
 *
 * Safety: the destructive step is gated on the explicit `apply` flag,
 * which every caller must pass. `apply: false` computes and reports the
 * identical diff without touching storage — a pure read. The seed path
 * passes `true` and is itself unreachable in production (`start.ts`
 * skips seeding entirely when `NODE_ENV=production`); the ops script
 * defaults to `false` and requires `--apply` on the command line.
 *
 * This replaced a blanket `NODE_ENV === 'production'` refusal. That
 * refusal made the only working reconciliation unreachable exactly
 * where orphans actually accumulate, which is the wrong trade: `hide()`
 * is non-destructive by construction (the app key cannot destroy
 * versions — ADR-0022), so the worst case of an unwanted apply is a
 * delete marker that the un-hide flow can lift for R days.
 */
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';

import type { Database } from '../db/connection.js';
import type { AttachmentStorageClient } from './client.js';

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

export interface PruneBucketOrphansLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface PruneBucketOrphansResult {
  bucketObjectCount: number;
  preservedCount: number;
  orphanCount: number;
  /**
   * The orphan keys themselves, in bucket-listing order. The dry run is
   * only useful if the operator can see WHICH keys an `--apply` pass
   * would hide — a bare count is not reviewable.
   */
  orphanKeys: string[];
}

/**
 * Build the production lister: paginated ListObjectsV2 over the whole
 * bucket. Tests don't use this — they pass a stub that returns a
 * controlled set.
 */
export function createBucketKeyLister(config: BucketKeyListerConfig): () => Promise<string[]> {
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    forcePathStyle: true,
  });

  const keyPrefix = config.keyPrefix ?? '';
  return async () => {
    const keys: string[] = [];
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
        keys.push(
          keyPrefix && obj.Key.startsWith(keyPrefix) ? obj.Key.slice(keyPrefix.length) : obj.Key,
        );
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  };
}

export async function pruneBucketOrphans(
  db: Database,
  storage: AttachmentStorageClient,
  listAllBucketKeys: () => Promise<string[]>,
  logger: PruneBucketOrphansLogger,
  bucketLabel: string,
  apply: boolean,
): Promise<PruneBucketOrphansResult> {
  // 1. Bucket listing — current-version view only.
  const bucketKeys = new Set<string>(await listAllBucketKeys());

  // 2. DB-referenced keys — every status (`pending`, `ready`, `hidden`).
  // `hidden` rows hold a legitimate PUT version below the delete marker
  // that the un-hide flow needs; preserving those keys here matches the
  // bash script's UNION.
  const referencedRows = await db.execute<{ key: string }>(sql`
    SELECT original_key AS key FROM attachments
    UNION
    SELECT thumb_key AS key FROM attachments WHERE thumb_key IS NOT NULL
  `);
  const referencedKeys = new Set<string>();
  for (const row of referencedRows.rows) {
    if (typeof row.key === 'string') referencedKeys.add(row.key);
  }

  // 3. Orphans = bucket - referenced.
  const orphans: string[] = [];
  for (const key of bucketKeys) {
    if (!referencedKeys.has(key)) orphans.push(key);
  }

  // 4. Hide each orphan via the storage wrapper's hide() primitive — same
  // call shape as the orphan reaper, idempotent on a versioned bucket.
  // Skipped entirely under `apply: false`: a dry run must issue no
  // mutating call at all, so an operator reviewing the report cannot
  // have already changed the bucket by reading it.
  if (apply) {
    for (const key of orphans) {
      await storage.hide(key);
    }
  }

  const result: PruneBucketOrphansResult = {
    bucketObjectCount: bucketKeys.size,
    preservedCount: bucketKeys.size - orphans.length,
    orphanCount: orphans.length,
    orphanKeys: orphans,
  };

  if (orphans.length > 0) {
    // Past tense only when something actually happened. A dry-run line
    // that reads like a completed cleanup is how an operator ends up
    // believing the bucket is clean when it is not.
    logger.warn(
      apply
        ? `pruneBucketOrphans: hid ${orphans.length} orphan object(s) in bucket '${bucketLabel}' ` +
            `(preserved ${result.preservedCount} referenced, total ${result.bucketObjectCount}).`
        : `pruneBucketOrphans: DRY RUN — ${orphans.length} orphan object(s) in bucket ` +
            `'${bucketLabel}' would be hidden (preserved ${result.preservedCount} referenced, ` +
            `total ${result.bucketObjectCount}). Nothing was changed; re-run with --apply to act.`,
    );
  } else {
    logger.info(
      `pruneBucketOrphans: no orphans in bucket '${bucketLabel}' ` +
        `(${result.bucketObjectCount} object(s), all referenced).`,
    );
  }

  return result;
}
