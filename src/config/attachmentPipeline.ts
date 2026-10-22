/**
 * Client-side attachment pipeline parameters.
 *
 * Centralises every value referenced by the browser upload pipeline and
 * the per-project-page enforcement surface. Each field is a `[C]`
 * customer-configurable setting per
 * [architecture.md §12.2](../../docs/spec/architecture.md#122-company-configurable-settings).
 *
 * Consumers:
 *   - `src/domain/imagePipeline.ts` reads the image/thumbnail encoding
 *     parameters and the per-file byte cap to enforce the size gate
 *     before calling `init` (matches the server-side cap that the
 *     presigned PUT pins via signed `Content-Length`, AC-399).
 *   - `src/ui/detail/BinaryList.tsx` reads the bulk-download caps to
 *     block client-side selections exceeding either cap (AC-435).
 *
 * Defaults mirror the architecture spec §12.2:
 *   - per-file cap: 1 MB (AC-398 ceiling and policy upper bound)
 *   - bulk caps: 20 files AND 20 MB (AC-415 twin-cap predicate)
 *   - image-longest-edge / quality + thumbnail-longest-edge / quality
 *     are calibrated so a worker phone photo fits well within the
 *     1 MB per-file cap with EXIF (including GPS) preserved.
 *
 * Layer note: this module sits in the config layer (eslint CONFIG_BANNED).
 * It exports plain values — no domain imports — so the domain pipeline
 * imports these constants freely.
 */

import {
  BULK_DOWNLOAD_MAX_BYTES_DEFAULT,
  BULK_DOWNLOAD_MAX_FILES_DEFAULT,
} from './attachmentDefaults';

export interface AttachmentPipelineConfig {
  /** Longest edge (pixels) applied to the re-encoded original. [C] */
  imageMaxDimension: number;
  /** JPEG / WebP quality (0..1) applied to the re-encoded original. [C] */
  imageQuality: number;
  /** Longest edge (pixels) applied to the WebP thumbnail. [C] */
  thumbnailMaxDimension: number;
  /** WebP quality (0..1) applied to the thumbnail. [C] */
  thumbnailQuality: number;
  /** Per-file size cap (bytes) — matches the presigned policy ceiling. [C] */
  perFileSizeCapBytes: number;
  /**
   * Pre-pipeline raw-input cap (bytes). Filters obvious mispicks
   * (multi-GB uploads, RAW DNGs, video files) before any decode work
   * runs. Sized for the worst credible phone JPEG: a 200 MP Galaxy Sxx
   * Ultra at maximum detail can emit ~25 MB; 50 MP Pixel/Samsung
   * captures are typically 10–15 MB. 30 MB leaves ~20% headroom for
   * outliers while still catching anything that could never compress
   * under the server cap.
   *
   * NOT coupled to `perFileSizeCapBytes` — the raw cap is "is this a
   * plausible photo source", the per-file cap is "what does the server
   * presigned-policy accept". Different concepts; tying them together
   * would silently break ordinary phone uploads if the output cap is
   * ever tightened. [C]
   */
  rawInputCapBytes: number;
  /** Bulk-download cap (file count). [C] */
  bulkDownloadMaxFiles: number;
  /** Bulk-download cap (summed byte size). [C] */
  bulkDownloadMaxBytes: number;
}

/** [C] — customer-configurable; see module docstring for rationale. */
export const ATTACHMENT_PIPELINE: AttachmentPipelineConfig = {
  imageMaxDimension: 2560,
  imageQuality: 0.82,
  thumbnailMaxDimension: 320,
  thumbnailQuality: 0.72,
  perFileSizeCapBytes: 1 * 1024 * 1024,
  rawInputCapBytes: 30 * 1024 * 1024,
  bulkDownloadMaxFiles: BULK_DOWNLOAD_MAX_FILES_DEFAULT,
  bulkDownloadMaxBytes: BULK_DOWNLOAD_MAX_BYTES_DEFAULT,
};
