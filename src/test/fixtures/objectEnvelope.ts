/**
 * Placeholder object metadata for tests that seed storage through
 * `StorageClient.upload` and do not assert on the envelope itself.
 * `upload` requires metadata so no production writer can drop it (AC-372);
 * tests that do assert on it build their own.
 */

import { WRAPPED_DEK_CURRENT_VERSION } from '../../domain/attachments.js';
import type { ObjectEnvelopeMetadata } from '../../server/storage/objectMetadata.js';

export const TEST_OBJECT_METADATA: ObjectEnvelopeMetadata = {
  wrappedDek: Buffer.from('test-wrapped-dek').toString('base64'),
  wrappedDekVersion: WRAPPED_DEK_CURRENT_VERSION,
};
