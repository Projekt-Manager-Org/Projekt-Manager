/**
 * Client-side image pipeline for attachment uploads
 * (ui/project-detail.md §8.15.4).
 *
 * Takes a raw `File` picked from the browser and returns the originals
 * that the upload store will POST to object storage:
 *   - `original` — the re-encoded file the user sees when clicking an
 *     attachment's lightbox. EXIF is preserved so GPS stays intact for
 *     the worker's field-capture context.
 *   - `thumbnail` — a short-edge WebP the gallery renders. Always
 *     produced for photo kinds; `null` for binaries and for requests
 *     with `hasThumbnail = false`.
 *   - `mimeType` — the final MIME of the original (unchanged from input
 *     for JPEG/PNG/WebP; kind is pinned by `classifyKind`).
 *   - `sizeBytes` — the final byte size of the original (matches the
 *     `Content-Length` value the init route signs into the presigned
 *     PUT URL).
 *
 * The pipeline is a pure module: it takes a `File` and settings, and
 * returns processed blobs. It never touches the store or API.
 *
 * Environment fallback — the module is imported from `src/state/
 * attachmentStore.ts`, which runs under both jsdom (component tests)
 * and Node (unit tests). `@uploadcare/image-shrink` requires a browser
 * environment (canvas + Image + URL.createObjectURL) that neither
 * jsdom nor Node provides. When `document.createElement('canvas').
 * getContext('2d')` is unavailable, `runImagePipeline` returns the
 * original file verbatim — no re-encode, no thumbnail — so the store's
 * orchestration path stays testable without a real browser.
 *
 * EXIF preservation — `@uploadcare/image-shrink` byte-splices the
 * source's APP1/EXIF segment back into the re-encoded JPEG. No IFD
 * parser sits in the path, so the LONG-vs-SHORT Orientation failure
 * mode that motivated the swap from `browser-image-compression` is
 * structurally absent. GPS rides along verbatim.
 *
 * Layer note: this module is in the domain layer. It imports nothing
 * from `state`, `ui`, `server`, `api`, or `hooks`; the only
 * application-internal dependency is the `[C]` catalogue at
 * `src/config/attachmentPipeline.ts`.
 */

import { shrinkFile } from '@uploadcare/image-shrink';
import { ATTACHMENT_PIPELINE } from '@/config/attachmentPipeline';
import { classifyKind } from './attachments';

export interface ProcessedUpload {
  /** Bytes that will be POSTed to the `originalUpload` presigned URL. */
  original: Blob;
  /** Bytes that will be POSTed to `thumbnailUpload`, or `null` for binaries. */
  thumbnail: Blob | null;
  /** Final MIME type of the original. */
  mimeType: string;
  /** Final size in bytes of the original. */
  sizeBytes: number;
}

/**
 * Liberal raw-source size cap used by the caller (store) to reject
 * obvious garbage before any pipeline work starts. Sized to admit any
 * plausible phone JPEG (worst credible: ~25 MB at 200 MP) while
 * rejecting RAW DNGs, video files, and multi-hundred-MB mispicks. The
 * post-pipeline check against `perFileSizeCapBytes` is still
 * authoritative; this gate just short-circuits inputs that could never
 * compress enough to be viable.
 *
 * Decoupled from `perFileSizeCapBytes` — see the rationale on
 * `rawInputCapBytes` in `attachmentPipeline.ts`.
 */
export function exceedsRawCap(file: File): boolean {
  return file.size > ATTACHMENT_PIPELINE.rawInputCapBytes;
}

/**
 * Heuristic: is the current runtime a browser capable of the canvas /
 * image-decoding operations the pipeline relies on?
 * `document.createElement('canvas').getContext('2d')` is the cheapest
 * probe that distinguishes a real browser from jsdom / Node.
 */
function canProcessImages(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return typeof canvas.getContext === 'function' && canvas.getContext('2d') !== null;
  } catch {
    return false;
  }
}

/**
 * Passthrough result — used in Node and in jsdom where canvas is absent.
 * The server still validates MIME + size, so a pass-through just means
 * the client can't participate in the downscale/re-encode optimisation.
 */
function passthrough(file: File): ProcessedUpload {
  return {
    original: file,
    thumbnail: null,
    mimeType: file.type,
    sizeBytes: file.size,
  };
}

/**
 * Iterate `shrinkFile` until output fits under `cap`.
 *
 * `shrinkFile` does one shot at the given `(size, quality)` and returns
 * whatever the canvas encoder produces. High-detail phone JPEGs at the
 * default `(2560, 0.82)` typically land around 0.5–1.5 MB — sometimes
 * over the 1 MB cap. Iterate by knocking down quality first (less
 * destructive), then dimension. Stop at six attempts: if a photo can't
 * be coerced under the cap by then, the source is pathological (huge
 * uncompressible texture, or a near-RAW DNG that slipped through the
 * MIME gate) and we'd rather throw than ship megabytes of detail loss.
 *
 * Note on `size` semantics — `@uploadcare/image-shrink`'s `size` is the
 * target *pixel area* (W×H), not a longest-edge dimension. The library
 * computes targetW = sqrt(size·ratio), targetH = sqrt(size/ratio) where
 * ratio = sourceW/sourceH, so targetW·targetH ≈ size and aspect is
 * preserved. To land the longest output edge at our `imageMaxDimension`
 * intent, we translate `L` (longest) into the area equivalent for this
 * source's aspect: `area = L² · (shorter/longer)`. Passing `L` directly
 * would yield a ~58×43-pixel thumbnail for any 4:3 phone photo.
 */
const SHRINK_ATTEMPTS: ReadonlyArray<{ scale: number; qualityFactor: number }> = [
  { scale: 1, qualityFactor: 1 },
  { scale: 1, qualityFactor: 0.85 },
  { scale: 1, qualityFactor: 0.7 },
  { scale: 0.75, qualityFactor: 0.85 },
  { scale: 0.5, qualityFactor: 0.85 },
  { scale: 0.5, qualityFactor: 0.7 },
];

/**
 * `@uploadcare/image-shrink` declines to resize when
 * `sourceW · STEP · sourceH · STEP < targetArea` (it throws "Not
 * required"). STEP is the per-step downscale factor inside the
 * library's iterative shrink loop; declining when the inequality holds
 * is the library's way of saying "the resize would only drop a single
 * step — more quality lost than bytes saved". See
 * `@uploadcare/image-shrink/dist/esm/index.browser.mjs` (`STEP = 0.71`,
 * `should be > sqrt(0.5)`).
 *
 * Mirrored here so we can compute the largest target the library WILL
 * accept for a given source, and clamp our intended target to that
 * ceiling when the configured `imageMaxDimension` would land us inside
 * the dead zone (sources whose pixel area is between ~1× and ~2× the
 * intended target — common for older phone cameras like the iPhone 4S
 * at 3264×2448). Without the clamp the library refuses, the source is
 * over the per-file cap, and the upload hard-fails with no recourse.
 */
const SHRINK_NOT_REQUIRED_STEP = 0.71;

/**
 * The largest target pixel area `shrinkFile` will accept for the given
 * source dimensions. Returns `POSITIVE_INFINITY` for degenerate sources
 * (decode failed) so the loop falls through to the library's own
 * handling instead of clamping to zero. Mirrors the library's float
 * arithmetic exactly — equivalent algebraic forms (e.g.
 * `sourceArea * STEP²`) drift on large sources due to IEEE-754
 * non-associativity.
 */
function shrinkAcceptCeiling(width: number, height: number): number {
  if (width <= 0 || height <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(
    1,
    Math.floor(width * SHRINK_NOT_REQUIRED_STEP * height * SHRINK_NOT_REQUIRED_STEP),
  );
}

async function readImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function shrinkUntilUnderCap(
  file: Blob,
  baseEdge: number,
  baseQuality: number,
  cap: number,
  fileName?: string,
): Promise<Blob> {
  const { width, height } = await readImageDimensions(file);
  const longerSrc = Math.max(width, height);
  const shorterSrc = Math.min(width, height);
  // Aspect-correct longest-edge → pixel-area conversion. See the block
  // comment on SHRINK_ATTEMPTS for the derivation.
  const aspectFactor = longerSrc > 0 ? shorterSrc / longerSrc : 1;
  const sourceArea = width * height;
  const acceptCeiling = shrinkAcceptCeiling(width, height);

  // Pre-flight: if the configured target lands in the library's "Not
  // required" zone (sourceArea / targetArea < ~1.984), the library
  // refuses to resize at scale=1. Two outcomes preserve the original
  // contract for the obvious cases:
  //   - source ≤ cap → return source verbatim. Re-encoding via canvas
  //     would lose quality without saving bytes, and the library's
  //     refusal is an explicit signal that the resize isn't worth it.
  //   - source > cap → fall through to the loop, which clamps target
  //     to `acceptCeiling` so the library accepts and re-encoding can
  //     get us under the cap. Effective dimensions land slightly below
  //     `imageMaxDimension` for these sources (e.g. 3264×2448 → ~2317
  //     long edge instead of 2560) — visually imperceptible, beats
  //     hard-failing the upload.
  const intendedAtBaseEdge = Math.max(1, Math.round(baseEdge * baseEdge * aspectFactor));
  if (intendedAtBaseEdge > acceptCeiling && file.size <= cap) {
    return file;
  }

  let last: Blob | null = null;
  for (let attemptIdx = 0; attemptIdx < SHRINK_ATTEMPTS.length; attemptIdx++) {
    const { scale, qualityFactor } = SHRINK_ATTEMPTS[attemptIdx];
    const targetEdge = Math.round(baseEdge * scale);
    const intendedArea = Math.max(1, Math.round(targetEdge * targetEdge * aspectFactor));
    // Clamp to the library's accept ceiling. For sources outside the
    // dead zone the clamp is a no-op (intendedArea ≤ acceptCeiling) and
    // behavior is unchanged. For sources inside the zone we trim to
    // exactly what the library will accept.
    const targetArea = Math.min(intendedArea, acceptCeiling);
    const quality = baseQuality * qualityFactor;
    let out: Blob;
    try {
      out = await shrinkFile(file, { size: targetArea, quality });
    } catch (err) {
      // Defensive paths only — with the pre-flight + per-iteration
      // clamp in place, "Not required" should be unreachable in normal
      // operation. Both branches still handle it gracefully:
      //   - generic rejection (decode failure, OOM, blocked toBlob): log
      //     and surface so the store maps to IMAGE_PROCESSING_FAILED.
      //   - "Not required" despite our clamp: indicates the library's
      //     STEP heuristic moved (version drift) or source dims came
      //     back degenerate. If source fits the cap we still ship it;
      //     otherwise tag the failure and bail.
      // `Error.cause` is ES2022; the project's lib is ES2020, so read
      // the property structurally to keep typecheck green without a
      // sweeping lib bump for one access.
      const cause =
        err && typeof err === 'object' && 'cause' in err ? (err as { cause: unknown }).cause : null;
      const isNotRequired = cause instanceof Error && cause.message === 'Not required';
      if (!isNotRequired) {
        console.warn('[imagePipeline] shrinkFile rejected', {
          fileName,
          attemptIdx,
          fileSize: file.size,
          dimensions: { width, height },
          targetEdge,
          targetArea,
          quality,
          error: err instanceof Error ? `${err.name}: ${err.message}` : err,
        });
        throw err;
      }
      if (file.size <= cap) return file;
      console.warn('[imagePipeline] shrink declined despite ceiling clamp and source exceeds cap', {
        fileName,
        attemptIdx,
        fileSize: file.size,
        cap,
        dimensions: { width, height },
        sourceArea,
        intendedArea,
        targetArea,
        acceptCeiling,
        hint: 'STEP heuristic in @uploadcare/image-shrink may have moved; re-derive shrinkAcceptCeiling',
      });
      throw new Error('IMAGE_PROCESSING_FAILED', { cause: err });
    }
    if (out.size <= cap) return out;
    last = out;
  }
  // Surface the tagged error so the store maps it to the
  // "Bildbearbeitung fehlgeschlagen" banner rather than a misleading
  // "Datei zu groß" from the post-pipeline cap check.
  console.warn('[imagePipeline] all attempts above cap', {
    fileName,
    fileSize: file.size,
    cap,
    finalAttemptSize: last?.size ?? null,
    dimensions: { width, height },
    attempts: SHRINK_ATTEMPTS.length,
  });
  throw new Error('IMAGE_PROCESSING_FAILED');
}

/**
 * Encode a WebP thumbnail at `dimension` longest edge / `quality`.
 *
 * `shrinkFile` outputs JPEG (or PNG for transparent sources) only —
 * thumbnails are deliberately WebP (better compression at small sizes)
 * so the gallery payload stays light. EXIF is dropped from thumbnails
 * by design; the original carries GPS for the worker view.
 */
async function encodeWebpThumbnail(
  file: Blob,
  dimension: number,
  quality: number,
): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    const ratio = Math.min(dimension / img.naturalWidth, dimension / img.naturalHeight, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/webp', quality);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

/**
 * Run the client-side upload pipeline for a single file.
 *
 * For photo MIME types (`image/jpeg`, `image/png`, `image/webp`):
 *   1. The original is downscaled to `imageMaxDimension` and re-encoded
 *      via `@uploadcare/image-shrink`. EXIF is byte-spliced from the
 *      source so GPS / orientation survive. The output is iterated
 *      until it fits under `perFileSizeCapBytes`.
 *   2. If `hasThumbnail` is true, a WebP thumbnail is generated at
 *      `thumbnailMaxDimension`.
 *
 * For binary MIME types, the file is passed through verbatim (no
 * thumbnail, no re-encode). The server still enforces the MIME
 * whitelist and size cap.
 */
export async function runImagePipeline(
  file: File,
  opts: { hasThumbnail: boolean },
): Promise<ProcessedUpload> {
  // Not a browser-capable runtime → pass through. The store's size-cap
  // check still runs against the raw file size, so we never upload
  // something the server would reject at the policy level.
  if (!canProcessImages()) {
    return passthrough(file);
  }

  // Binary kinds are uploaded as-is; server-side validation pins the
  // MIME and size ceiling.
  let kind: 'photo' | 'binary';
  try {
    kind = classifyKind(file.type);
  } catch {
    // Unknown MIME — let the server produce the authoritative error.
    // Pipeline stays a pure projection of the input.
    return passthrough(file);
  }

  if (kind === 'binary') {
    return passthrough(file);
  }

  // --- Photo branch ---------------------------------------------------------

  const mimeType = file.type;

  let original: Blob;
  try {
    original = await shrinkUntilUnderCap(
      file,
      ATTACHMENT_PIPELINE.imageMaxDimension,
      ATTACHMENT_PIPELINE.imageQuality,
      ATTACHMENT_PIPELINE.perFileSizeCapBytes,
      file.name,
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'IMAGE_PROCESSING_FAILED') {
      throw err;
    }
    // Decode failure, OOM, blocked toBlob — surface as the tagged error
    // so the store's banner reads "Bildbearbeitung fehlgeschlagen"
    // instead of the post-pipeline cap's misleading "Datei zu groß".
    console.warn('[imagePipeline] original compression failed', {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      error: err instanceof Error ? `${err.name}: ${err.message}` : err,
    });
    throw new Error('IMAGE_PROCESSING_FAILED', { cause: err });
  }

  let thumbnail: Blob | null = null;
  if (opts.hasThumbnail) {
    try {
      thumbnail = await encodeWebpThumbnail(
        file,
        ATTACHMENT_PIPELINE.thumbnailMaxDimension,
        ATTACHMENT_PIPELINE.thumbnailQuality,
      );
    } catch (err) {
      // Thumbnail is opportunistic — leave it null and let the store
      // clear `hasThumbnail` so the server issues only one descriptor.
      // Log so a vanishing-thumbnail regression isn't completely silent.
      console.warn('[imagePipeline] thumbnail encode failed (continuing without)', {
        fileName: file.name,
        error: err instanceof Error ? `${err.name}: ${err.message}` : err,
      });
      thumbnail = null;
    }
  }

  return {
    original,
    thumbnail,
    mimeType,
    sizeBytes: original.size,
  };
}
