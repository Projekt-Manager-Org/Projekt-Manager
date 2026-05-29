/**
 * Browser file-download helpers.
 *
 * Two layers:
 *   - `triggerBlobDownload` — turn an in-memory Blob into a save dialog via a
 *     transient `<a download>` + object URL, revoking on the next tick so the
 *     browser's download pickup is not raced by URL cleanup.
 *   - `downloadAuthedFile` — fetch a same-origin, credentialed endpoint into a
 *     Blob, then hand off to `triggerBlobDownload`.
 *
 * Why fetch-to-blob rather than pointing an `<a download>` straight at the
 * endpoint: routes that return `Content-Disposition: attachment` (the invoice
 * PDF route) download fine on desktop, but on mobile browsers that ignore the
 * `download` attribute — iOS Safari, and any browser running the app as an
 * installed PWA in `standalone` display mode — the click degrades to a
 * top-level navigation to the attachment response. The browser commits the
 * navigation, cannot render an attachment as a document, and leaves the
 * originating tab on a blank page (`about:blank`). Fetching the bytes into a
 * same-document blob URL sidesteps the navigation, so the download behaves
 * uniformly across desktop and mobile.
 */

/** Trigger a browser download for an in-memory Blob. */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Fetch a same-origin, credentialed endpoint and save its body as `filename`.
 * Rejects on a non-2xx response so callers can surface the failure rather than
 * handing the user an error page dressed up as a download.
 */
export async function downloadAuthedFile(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    throw new Error(`download failed: ${res.status}`);
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}
