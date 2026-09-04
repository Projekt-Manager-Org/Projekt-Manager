/**
 * Wipe the current view of the configured object-storage bucket.
 *
 * Mirror of `seed({ force: true })` for object storage: gives every
 * Playwright run a known-empty bucket so test attachments from a prior
 * run cannot leak into a later run's assertions, and the bucket-pollution
 * guard in scripts/sync-dev-to-vps.sh is never triggered by E2E debris.
 *
 * Versioning + Compliance Object Lock ramifications:
 *   The app user's IAM policy denies s3:DeleteObjectVersion (ADR-0022),
 *   so this cannot destroy versions — DeleteObject WITHOUT VersionId on
 *   a versioned bucket only writes a delete marker, demoting the current
 *   version to noncurrent. The actual bytes remain locked under the
 *   bucket's default Compliance retention until R + L days pass and the
 *   lifecycle rule reaps them. That's fine: the goal is a clean current
 *   view at run start, not freed bytes. The accumulated noncurrent
 *   versions on the e2e bucket reap automatically per the same
 *   lifecycle settings as the dev bucket.
 *
 * Safety: refuses to run unless STORAGE_BUCKET differs from the dev
 * bucket name, so a misconfiguration that points the e2e suite at the
 * dev bucket cannot wipe the operator's working data.
 */

import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

const DEV_BUCKET_NAME = 'projekt-manager';

export async function resetE2eBucket(): Promise<void> {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const bucket = process.env.STORAGE_BUCKET;
  const accessKey = process.env.STORAGE_ACCESS_KEY;
  const secretKey = process.env.STORAGE_SECRET_KEY;
  const region = process.env.STORAGE_REGION ?? 'us-east-1';

  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error(
      'resetE2eBucket: STORAGE_ENDPOINT / STORAGE_BUCKET / STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY must all be set',
    );
  }

  if (bucket === DEV_BUCKET_NAME) {
    throw new Error(
      `resetE2eBucket: refusing to wipe the dev bucket '${bucket}' — playwright.config.ts must override STORAGE_BUCKET to the isolated e2e bucket. Did you skip the override or set STORAGE_BUCKET_E2E to the dev bucket?`,
    );
  }

  const s3 = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });

  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );

    for (const object of list.Contents ?? []) {
      if (!object.Key) continue;
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}
