/**
 * The one env → `StorageConfig` mapping. Every storage client built from
 * env goes through here, so no call site can drop a field — notably
 * `STORAGE_KEY_PREFIX`, the per-fork test namespace (#481). Pinned by
 * `test-harness-isolation.test.ts`.
 */

import type { Env } from '../config/env.js';
import { createStorageClient, type AttachmentStorageClient, type StorageConfig } from './client.js';

/**
 * Fails closed when the STORAGE_* credentials are missing: a client built
 * without them would only fail later, at the first request.
 */
export function storageConfigFromEnv(env: Env): StorageConfig {
  if (!env.STORAGE_ENDPOINT || !env.STORAGE_ACCESS_KEY || !env.STORAGE_SECRET_KEY) {
    throw new Error(
      'STORAGE_ENDPOINT, STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY must be set to build a storage client.',
    );
  }
  return {
    endpoint: env.STORAGE_ENDPOINT,
    publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
    region: env.STORAGE_REGION,
    keyPrefix: env.STORAGE_KEY_PREFIX,
  };
}

export function createStorageClientFromEnv(env: Env): AttachmentStorageClient {
  return createStorageClient(storageConfigFromEnv(env));
}
