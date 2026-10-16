/**
 * Synthetic-origin URL builder for the Service-Worker decrypt path
 * (ADR-0024 / spec ui/project-detail.md §8.15.4 + §8.15.5 + §8.15.7).
 *
 * The SW intercepts `/encrypted-storage/<projectId>/<attachmentId>.<variant>`
 * requests, calls `download-url`, fetches the ciphertext from object
 * storage, AES-GCM-decrypts, and returns plaintext bytes through the
 * Fetch response. SPA consumers (`<img src>`, `<iframe src>`,
 * `<a href download>`) point at the URL this helper builds and treat
 * it as opaque — the bytes the browser sees are plaintext.
 *
 * Centralised so the path scheme has one definition. A schema change
 * (SW route, variant naming) lands here and propagates through every
 * caller.
 */

import { SYNTHETIC_ORIGIN_PREFIX } from '@/config/syntheticOrigin';

export type AttachmentVariant = 'original' | 'thumbnail';

/** Per-row outcome of a failed synthetic-origin load (ui/project-detail.md §8.15.7). */
export type AttachmentLoadError = 'object-absent' | 'key-unavailable' | 'load-failed';

const LOAD_ERROR_BY_SW_CODE = new Map<string, AttachmentLoadError>([
  ['OBJECT_ABSENT', 'object-absent'],
  ['DEK_UNWRAP_FAILED', 'key-unavailable'],
]);

/**
 * Only the two pinned SW codes carry a verdict on the row. Anything
 * else — no code at all when the page is not SW-controlled — asserts
 * nothing about the row's bytes or key.
 */
export function loadErrorForSwCode(code: string | null | undefined): AttachmentLoadError {
  return LOAD_ERROR_BY_SW_CODE.get(code ?? '') ?? 'load-failed';
}

export function synthAttachmentUrl(
  projectId: string,
  attachmentId: string,
  variant: AttachmentVariant,
): string {
  return `${SYNTHETIC_ORIGIN_PREFIX}${projectId}/${attachmentId}.${variant}`;
}
