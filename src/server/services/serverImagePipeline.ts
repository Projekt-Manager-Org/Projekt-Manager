/**
 * Server-side image pipeline — the Node counterpart to the browser
 * `src/domain/imagePipeline.ts`.
 *
 * The browser pipeline derives thumbnails with `@uploadcare/image-shrink`
 * + canvas, which only exist in a real browser. The full-account takeout
 * IMPORT runner restores attachments server-side from plaintext-on-disk
 * (the takeout zip's entry bytes) and has no canvas — so it regenerates
 * the gallery thumbnail here, with `sharp` (native libvips, already a
 * dependency; also used by `scripts/generate-pwa-icons.mjs`).
 *
 * Parity with the browser pipeline: same longest-edge + quality from the
 * shared `[C]` catalogue (`ATTACHMENT_PIPELINE`), WebP output, EXIF
 * dropped. `.rotate()` (no args) bakes the source's EXIF orientation into
 * the pixels before the strip, so a restored thumbnail is oriented like
 * the browser-produced one rather than sideways.
 *
 * Layer note: server layer — `sharp` is a native module and must never be
 * imported from `domain`/`state`/`ui`. The only app-internal dependency
 * is the `[C]` catalogue at `src/config/attachmentPipeline.ts`.
 */

import sharp from 'sharp';
import { ATTACHMENT_PIPELINE } from '../../config/attachmentPipeline.js';

/**
 * Derive a WebP thumbnail from decrypted image `plaintext`, sized to
 * `thumbnailMaxDimension` longest edge (aspect preserved, never upscaled)
 * at `thumbnailQuality`. Rejects when the bytes are not a decodable image
 * — the caller treats a thumbnail as opportunistic (logs + restores the
 * original without one) so one odd file never fails the whole import.
 *
 * `failOn: 'none'` matches the browser pipeline's leniency: decode what we
 * can rather than reject a usable photo over an EXIF/ICC warning. Genuine
 * garbage still throws (no pixels to encode), and `sharp`'s default
 * `limitInputPixels` guards against a decompression-bomb image smuggled
 * into an otherwise SHA-valid archive.
 */
export async function renderWebpThumbnail(plaintext: Buffer): Promise<Buffer> {
  return sharp(plaintext, { failOn: 'none' })
    .rotate()
    .resize(ATTACHMENT_PIPELINE.thumbnailMaxDimension, ATTACHMENT_PIPELINE.thumbnailMaxDimension, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: Math.round(ATTACHMENT_PIPELINE.thumbnailQuality * 100) })
    .toBuffer();
}
