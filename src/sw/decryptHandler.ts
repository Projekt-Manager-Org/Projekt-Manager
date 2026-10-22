/**
 * Service Worker decrypt handler — synthetic-origin intercept seam for
 * binary attachment e2e encryption (ADR-0024 §Service-Worker decryption,
 * AC-416 in `docs/spec/verification.md`).
 *
 * The SPA installs a Service Worker that intercepts every request to
 * `/encrypted-storage/<projectId>/<attachmentId>.<variant>` (variant ∈
 * {original, thumbnail}). The handler:
 *
 *   1. Calls `GET /api/projects/<projectId>/attachments/<attachmentId>/download-url?variant=<variant>`
 *      to obtain `{ url, expiresAt, dekMaterial }`.
 *   2. Fetches `url` to obtain the ciphertext bytes from object storage.
 *   3. AES-256-GCM-decrypts with `dekMaterial` (per-blob nonce is the
 *      ciphertext's leading 12 bytes — same convention `clientEncryption.ts`
 *      writes on upload).
 *   4. Returns the plaintext bytes via the Fetch response so
 *      `<img src="/encrypted-storage/...">` and friends keep working.
 *
 * Failure-mode signal contract — defined here; the UI maps it to the
 * AC-436 / AC-244 / AC-437 placeholders. Only two codes are sanctioned:
 *
 *   - `OBJECT_ABSENT` — storage 404 / NoSuchKey on the presigned-GET
 *     fetch. Drives the `"Datei fehlt"` placeholder (AC-436).
 *   - `DEK_UNWRAP_FAILED` — `download-url` returned exactly
 *     `422 VALIDATION_ERROR { code: 'DEK_UNWRAP_FAILED' }`. Drives the
 *     `"Schlüssel nicht verfügbar"` placeholder (AC-244). The AES-GCM
 *     auth-tag path on read also collapses to this code: from the
 *     consumer's perspective a tag mismatch reads identically to an
 *     envelope-unwrap fault — the key "cannot be unwrapped" (AC-244),
 *     and the bytes are refused either way (AC-418). The handler does not invent
 *     additional codes.
 *
 * Every other failure path (transport drops, non-pinned status codes,
 * parse failures, missing fields, malformed base64, ciphertext fetches
 * that 5xx) falls through to a generic non-2xx Response with NO
 * `data-sw-error-code` set. The UI's `onError` handler renders a
 * generic error path in that case rather than mis-attributing to one
 * of the two pinned divergences.
 *
 * DOM-attribute mirror. The signal appears on BOTH
 * the failing Response (header) AND the requesting `<img>` / `<iframe>`
 * element (DOM attribute). A Service Worker cannot touch the DOM — only
 * a window-side script can. The handler posts the code over a
 * `BroadcastChannel('sw-attachment-errors')` along with the synthetic
 * request URL; the SPA-side listener
 * (`src/sw/installAttachmentErrorListener.ts`) subscribes, finds the
 * matching `<img>` / `<iframe>` by `src`, and writes the
 * `data-sw-error-code` attribute. Pub/sub keeps the handler a pure
 * function (no DOM coupling) and keeps the test seam mockable.
 *
 * Pure-handler scope: this module is the URL-routed function the SW
 * runtime calls; it does NOT install fetch listeners. The fetch-event
 * registration and integration with the push handlers live in
 * `src/sw/index.ts` (bundled to `dist/sw.js` by the
 * `buildServiceWorker` Vite plugin).
 */

import { SYNTHETIC_ORIGIN_PREFIX } from '@/config/syntheticOrigin';
import { decryptBlob, decodeDekMaterial } from '@/domain/clientEncryption';

const VALID_VARIANTS = new Set(['original', 'thumbnail']);

/** Stable error codes of the failure-mode signal contract above. */
type SwErrorCode = 'OBJECT_ABSENT' | 'DEK_UNWRAP_FAILED';

/**
 * Pub/sub channel name for the SW → SPA DOM-mirror handoff. The
 * matching listener installs in `src/sw/installAttachmentErrorListener.ts`
 * and reads `{ requestUrl, code }` messages. Same-origin only by
 * BroadcastChannel semantics.
 */
export const SW_ERROR_CHANNEL = 'sw-attachment-errors';

export interface SwErrorMessage {
  requestUrl: string;
  code: SwErrorCode;
}

interface DownloadUrlResponse {
  url: string;
  expiresAt: string;
  dekMaterial: string;
  /**
   * Plaintext MIME of the requested variant — set as `Content-Type` on
   * the decrypted response so `<iframe src>` previews of PDFs render
   * inline (the browser would download an `application/octet-stream`
   * instead). Falls back to octet-stream when omitted; older server
   * builds without the field stay download-only, matching prior behavior.
   */
  mimeType?: string;
}

interface ParsedSyntheticPath {
  projectId: string;
  attachmentId: string;
  variant: string;
}

/**
 * Parse a synthetic-origin path of the shape
 * `/encrypted-storage/<projectId>/<attachmentId>.<variant>`. Returns
 * `null` if the path does not match — the caller treats `null` as
 * "not our route, hand back to the network".
 */
function parseSyntheticPath(pathname: string): ParsedSyntheticPath | null {
  if (!pathname.startsWith(SYNTHETIC_ORIGIN_PREFIX)) return null;
  const rest = pathname.slice(SYNTHETIC_ORIGIN_PREFIX.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) return null;
  const projectId = rest.slice(0, slashIdx);
  const tail = rest.slice(slashIdx + 1);
  const dotIdx = tail.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === tail.length - 1) return null;
  const attachmentId = tail.slice(0, dotIdx);
  const variant = tail.slice(dotIdx + 1);
  if (!VALID_VARIANTS.has(variant)) return null;
  return { projectId, attachmentId, variant };
}

/**
 * Post the SW error code to the SPA-side listener so it can mirror it
 * onto the requesting DOM element. Best-effort: a runtime without
 * `BroadcastChannel` (older Safari, fenced-frames) skips the post —
 * the response header still carries the code, so consumers that read
 * the header (`fetch().then(r => r.headers.get(...))`) still see it.
 */
function broadcastSwError(requestUrl: string, code: SwErrorCode): void {
  if (typeof BroadcastChannel === 'undefined') return;
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(SW_ERROR_CHANNEL);
    const message: SwErrorMessage = { requestUrl, code };
    channel.postMessage(message);
  } catch {
    // BroadcastChannel construction can throw in degraded contexts
    // (private browsing, some embedded WebViews). The header path is
    // still valid; swallow and continue.
  } finally {
    channel?.close();
  }
}

/**
 * Build a non-2xx Response carrying the SW error-code contract:
 *   - `data-sw-error-code` response header,
 *   - JSON body `{ code, message }` so consumers that read the body
 *     (the binary download path) can disambiguate AC-436 vs AC-244
 *     without a second request,
 *   - matching BroadcastChannel post so the SPA-side listener can
 *     mirror the code onto the requesting `<img>` / `<iframe>` DOM
 *     element.
 */
function failureResponse(
  requestUrl: string,
  code: SwErrorCode,
  status: number,
  message: string,
): Response {
  broadcastSwError(requestUrl, code);
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: {
      'content-type': 'application/json',
      'data-sw-error-code': code,
    },
  });
}

/**
 * Build a generic non-2xx Response for failure paths the spec does NOT
 * sanction either of the two pinned codes for (transport drops, 5xx
 * storage faults, malformed metadata, etc.). No `data-sw-error-code`,
 * no BroadcastChannel post — the consumer's `<img onError>` reads the
 * absence of the attribute as "generic error" rather than mis-routing
 * to one of the two pinned placeholders.
 */
function genericFailureResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * Handle a synthetic-origin request. The SW routes here only after
 * matching the `/encrypted-storage/` prefix; we still re-validate the
 * shape so a misrouted call cannot crash the worker — defense in
 * depth.
 */
export async function handleEncryptedStorageRequest(request: Request): Promise<Response> {
  const url = new URL(request.url, 'http://sw.local');
  const parsed = parseSyntheticPath(url.pathname);
  if (!parsed) {
    return new Response(null, { status: 404 });
  }

  const { projectId, attachmentId, variant } = parsed;

  // Step 1 — obtain the presigned URL + unwrapped DEK.
  // Same-origin fetch with credentials inherited from the SW context;
  // the server gates the call on `attachment:read` + scope.
  const downloadUrlEndpoint =
    `/api/projects/${encodeURIComponent(projectId)}` +
    `/attachments/${encodeURIComponent(attachmentId)}` +
    `/download-url?variant=${encodeURIComponent(variant)}`;

  let descriptorResponse: Response;
  try {
    descriptorResponse = await fetch(downloadUrlEndpoint, {
      method: 'GET',
      credentials: 'same-origin',
    });
  } catch {
    // Network failure on the metadata call — neither pinned code
    // applies (DEK_UNWRAP_FAILED needs a 422 + explicit body code). Surface generic so the UI does not
    // mis-route to AC-244 placeholders.
    return genericFailureResponse(502, 'download-url metadata fetch failed in transit');
  }

  if (!descriptorResponse.ok) {
    // Only `422 VALIDATION_ERROR` with
    // `body.code === 'DEK_UNWRAP_FAILED'` produces the AC-244 signal.
    // Every other status (401, 403, 404, 5xx, …) is generic. We
    // attempt to read the body only on 422 to keep the parse cost
    // off the common-error path.
    if (descriptorResponse.status === 422) {
      let parsed: { code?: unknown } | null;
      try {
        // `JSON.parse('null')` returns the literal `null` at runtime — the
        // `as` cast does not protect against it, so keep the union honest
        // and read through `?.` below.
        parsed = (await descriptorResponse.json()) as { code?: unknown } | null;
      } catch {
        // 422 with non-JSON body — not the documented shape.
        return genericFailureResponse(502, 'download-url 422 body was not valid JSON');
      }
      if (parsed?.code === 'DEK_UNWRAP_FAILED') {
        return failureResponse(
          request.url,
          'DEK_UNWRAP_FAILED',
          422,
          'download-url reported envelope unwrap failure',
        );
      }
      // 422 with a different code — generic; the spec only sanctions
      // DEK_UNWRAP_FAILED at 422 for download-url.
      return genericFailureResponse(
        502,
        'download-url 422 did not carry the DEK_UNWRAP_FAILED code',
      );
    }
    return genericFailureResponse(
      descriptorResponse.status,
      'download-url returned a non-2xx response',
    );
  }

  let descriptor: DownloadUrlResponse;
  try {
    descriptor = (await descriptorResponse.json()) as DownloadUrlResponse;
  } catch {
    return genericFailureResponse(502, 'download-url body was not valid JSON');
  }

  if (
    typeof descriptor.url !== 'string' ||
    typeof descriptor.dekMaterial !== 'string' ||
    descriptor.url.length === 0 ||
    descriptor.dekMaterial.length === 0
  ) {
    return genericFailureResponse(502, 'download-url body missing url/dekMaterial fields');
  }

  let dek: Uint8Array;
  try {
    dek = decodeDekMaterial(descriptor.dekMaterial);
  } catch {
    // Malformed base64 / wrong length — the server emitted a malformed
    // descriptor. Not a sanctioned-code path; surface generic.
    return genericFailureResponse(502, 'dekMaterial failed structural validation');
  }

  // Step 2 — fetch the ciphertext from the presigned URL. No auth
  // headers; the URL is signed and credential-bearing.
  let ciphertextResponse: Response;
  try {
    ciphertextResponse = await fetch(descriptor.url, {
      method: 'GET',
      credentials: 'omit',
    });
  } catch {
    // Storage-side transport failure — neither pinned code applies.
    // OBJECT_ABSENT is reserved for an explicit 404 / NoSuchKey
    // response; a transport drop has no such signal.
    return genericFailureResponse(502, 'ciphertext fetch failed in transit');
  }

  if (ciphertextResponse.status === 404) {
    // AC-436 path: the row exists and the DEK unwraps, but the
    // backing object is gone. Most likely a Layer-1 restore whose
    // Layer-3 storage diverged.
    return failureResponse(
      request.url,
      'OBJECT_ABSENT',
      404,
      'ciphertext object absent at storage',
    );
  }

  if (!ciphertextResponse.ok) {
    // 401 (signature drift), 403 (URL expired), 5xx (storage outage),
    // etc. — none of these are object-absence. Surface
    // generic so the UI shows a transient-error path rather than the
    // permanent-divergence "Datei fehlt" placeholder.
    return genericFailureResponse(
      ciphertextResponse.status,
      'ciphertext fetch returned a non-2xx response',
    );
  }

  // Step 3 — decrypt. AES-GCM auth-tag failure (tampered bytes,
  // corrupted ciphertext, or wrong DEK) throws an OperationError;
  // the consumer cannot tell envelope-unwrap-fail from cipher-mismatch
  // from the outside, so both collapse to DEK_UNWRAP_FAILED (AC-244);
  // the bytes are refused either way (AC-418).
  let ciphertext: Uint8Array;
  try {
    const buf = await ciphertextResponse.arrayBuffer();
    ciphertext = new Uint8Array(buf);
  } catch {
    return genericFailureResponse(502, 'failed to read ciphertext bytes');
  }

  let plaintext: Uint8Array;
  try {
    plaintext = await decryptBlob(ciphertext, dek);
  } catch {
    return failureResponse(
      request.url,
      'DEK_UNWRAP_FAILED',
      502,
      'AES-GCM authentication tag verification failed',
    );
  }

  // Step 4 — serve plaintext. The download-url descriptor carries the
  // plaintext mime; surfacing it as `Content-Type` is what lets
  // `<iframe src>` PDF previews render inline (the browser collapses
  // `application/octet-stream` to a download). Falls back to
  // octet-stream when the server omits the field — keeps the worker
  // forward-compat against an older deploy that hasn't shipped the
  // mime addition yet.
  const responseMime =
    typeof descriptor.mimeType === 'string' && descriptor.mimeType.length > 0
      ? descriptor.mimeType
      : 'application/octet-stream';
  return new Response(plaintext as BodyInit, {
    status: 200,
    headers: {
      'content-type': responseMime,
      'cache-control': 'no-store',
    },
  });
}
