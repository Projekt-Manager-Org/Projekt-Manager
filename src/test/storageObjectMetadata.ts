/**
 * Read an object's user metadata straight from object storage — the
 * observable surface of AC-372 ("self-describing objects"). Goes through
 * a raw `HeadObjectCommand` rather than the app's storage client so the
 * assertion does not depend on the code under test. Config comes from the
 * one env mapping, so the HEAD lands on the same `STORAGE_KEY_PREFIX`
 * namespace the app writes to (#481).
 */

import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getEnv } from '../server/config/env.js';
import { storageConfigFromEnv } from '../server/storage/fromEnv.js';

/** Wire names of the metadata keys (`x-amz-meta-<name>`). */
export const META_WRAPPED_DEK = 'wrapped-dek';
export const META_WRAPPED_DEK_VERSION = 'wrapped-dek-version';
export const META_INVOICE_NUMBER = 'invoice-number';

export async function headObjectMetadata(
  logicalKey: string,
  versionId?: string,
): Promise<Record<string, string>> {
  const config = storageConfigFromEnv(getEnv());
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    forcePathStyle: true,
  });
  try {
    const res = await s3.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: (config.keyPrefix ?? '') + logicalKey,
        ...(versionId ? { VersionId: versionId } : {}),
      }),
    );
    return res.Metadata ?? {};
  } finally {
    s3.destroy();
  }
}
