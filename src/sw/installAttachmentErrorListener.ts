/**
 * SPA-side listener for the Service Worker decrypt handler's
 * failure-mode signals (ui/project-detail.md §8.15.7 "DOM-attribute
 * mirror"; AC-244).
 *
 * The Service Worker cannot touch the DOM — only a window-side script
 * can. The decrypt handler (`src/sw/decryptHandler.ts`) posts
 * `{ requestUrl, code }` over `BroadcastChannel('sw-attachment-errors')`
 * for every error path that emits one of the two pinned codes
 * (`OBJECT_ABSENT`, `DEK_UNWRAP_FAILED`). This listener subscribes,
 * locates the requesting `<img>` / `<iframe>` element by `src`, and
 * writes the `data-sw-error-code` attribute. The element's `onError`
 * handler (PhotoGallery, BinaryList) reads the attribute to choose
 * between the AC-224 `"Datei fehlt"` and AC-244
 * `"Schlüssel nicht verfügbar"` placeholders; without the attribute
 * it renders the generic `"Datei konnte nicht geladen werden"`.
 *
 * Wiring: invoked once from `src/main.tsx` at SPA bootstrap, before
 * React mounts. Idempotent — re-invocation closes the prior channel
 * and opens a fresh one (helpful for HMR).
 *
 * Element-lookup strategy: `document.querySelectorAll('img[src], iframe[src]')`
 * filtered by exact-match `src`. The synthetic-origin URL is unique
 * per attachment + variant, so a strict equality match is sufficient.
 * If the element has been replaced (React reconciliation) between
 * fetch start and the broadcast, the attribute is set on whatever
 * matches the URL at message-receive time — consistent with how the
 * `<img onError>` event would fire on the live element.
 */

import { SW_ERROR_CHANNEL, type SwErrorMessage } from './decryptHandler';

const ATTRIBUTE_NAME = 'data-sw-error-code';

let activeChannel: BroadcastChannel | undefined;

/**
 * Subscribe to the SW error channel and mirror codes onto matching
 * DOM elements. Returns a teardown function for tests / HMR.
 */
export function installAttachmentErrorListener(): () => void {
  // Older Safari and some embedded WebViews lack `BroadcastChannel`.
  // No-op there — the response header still carries the code, and
  // consumers that read `fetch().then(r => r.headers.get(...))` can
  // still observe it. The DOM mirror is best-effort surface area.
  if (typeof BroadcastChannel === 'undefined') return () => {};

  // Idempotency: if a previous listener is still attached (HMR, double
  // bootstrap), tear it down so we do not double-write the attribute.
  activeChannel?.close();

  const channel = new BroadcastChannel(SW_ERROR_CHANNEL);
  activeChannel = channel;

  channel.onmessage = (event: MessageEvent<SwErrorMessage>) => {
    const data = event.data;
    if (!data || typeof data.requestUrl !== 'string' || typeof data.code !== 'string') {
      return;
    }
    if (data.code !== 'OBJECT_ABSENT' && data.code !== 'DEK_UNWRAP_FAILED') {
      // Defense in depth: the channel is same-origin, but the spec
      // pins exactly two codes. Drop anything else rather than
      // poisoning the DOM with arbitrary attribute values.
      return;
    }
    if (typeof document === 'undefined') return;
    const elements = document.querySelectorAll<HTMLImageElement | HTMLIFrameElement>(
      'img[src], iframe[src]',
    );
    elements.forEach((el) => {
      if (el.src === data.requestUrl) {
        el.setAttribute(ATTRIBUTE_NAME, data.code);
      }
    });
  };

  return () => {
    channel.close();
    if (activeChannel === channel) activeChannel = undefined;
  };
}
