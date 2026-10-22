/**
 * SPA-side listener for SW failure-mode signals (the signal contract in
 * `src/sw/decryptHandler.ts`).
 *
 * Asserts the round trip from a `BroadcastChannel('sw-attachment-errors')`
 * post (what the SW decrypt handler emits) to the `data-sw-error-code`
 * attribute landing on the matching `<img>` / `<iframe>` element. The
 * UI's `onError` handler reads that attribute to choose between the
 * "Datei fehlt" and "Schlüssel nicht verfügbar" placeholders; without this listener, the SW's
 * Response header would be visible only to consumers that read it
 * explicitly, breaking the gallery render path that relies on the DOM
 * attribute (see PhotoGallery tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { installAttachmentErrorListener } = await import('@/sw/installAttachmentErrorListener');
const { SW_ERROR_CHANNEL } = await import('@/sw/decryptHandler');

// All listener tests share a teardown so a stale `BroadcastChannel`
// from one test does not leak into the next.
let teardown: (() => void) | undefined;
let publisher: BroadcastChannel | undefined;

beforeEach(async () => {
  document.body.innerHTML = '';
  teardown = installAttachmentErrorListener();
  publisher = new BroadcastChannel(SW_ERROR_CHANNEL);
  // Node's BroadcastChannel takes one event-loop turn to fully join
  // the named channel after construction; without this flush, a
  // post-on-construction race intermittently drops the very first
  // message of a fresh test process. Subsequent tests don't hit it
  // because the channel is already registered.
  await new Promise((r) => setTimeout(r, 0));
});

afterEach(() => {
  publisher?.close();
  publisher = undefined;
  teardown?.();
  teardown = undefined;
});

/**
 * Wait one macrotask so cross-channel messages dispatch. `postMessage`
 * delivery on same-realm BroadcastChannels is asynchronous; a single
 * `setTimeout(0)` flush is enough.
 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('installAttachmentErrorListener', () => {
  it('writes data-sw-error-code on a matching <img> when an OBJECT_ABSENT message arrives', async () => {
    const img = document.createElement('img');
    img.src = 'http://localhost/encrypted-storage/p-42/att-1.original';
    document.body.appendChild(img);

    publisher!.postMessage({ requestUrl: img.src, code: 'OBJECT_ABSENT' });
    await flush();

    expect(img.getAttribute('data-sw-error-code')).toBe('OBJECT_ABSENT');
  });

  it('writes data-sw-error-code on a matching <iframe> when a DEK_UNWRAP_FAILED message arrives', async () => {
    const iframe = document.createElement('iframe');
    iframe.src = 'http://localhost/encrypted-storage/p-42/att-9.original';
    document.body.appendChild(iframe);

    publisher!.postMessage({ requestUrl: iframe.src, code: 'DEK_UNWRAP_FAILED' });
    await flush();

    expect(iframe.getAttribute('data-sw-error-code')).toBe('DEK_UNWRAP_FAILED');
  });

  it('does not mutate elements whose src does not match the broadcast requestUrl', async () => {
    const matching = document.createElement('img');
    matching.src = 'http://localhost/encrypted-storage/p-42/att-1.original';
    const other = document.createElement('img');
    other.src = 'http://localhost/encrypted-storage/p-42/att-2.original';
    document.body.append(matching, other);

    publisher!.postMessage({ requestUrl: matching.src, code: 'OBJECT_ABSENT' });
    await flush();

    expect(matching.getAttribute('data-sw-error-code')).toBe('OBJECT_ABSENT');
    expect(other.hasAttribute('data-sw-error-code')).toBe(false);
  });

  it('ignores messages with codes outside the two pinned values', async () => {
    // Defense in depth: BroadcastChannel is same-origin but the spec
    // pins exactly two codes. Reject anything else rather than poison
    // the DOM attribute with an arbitrary value.
    const img = document.createElement('img');
    img.src = 'http://localhost/encrypted-storage/p-42/att-1.original';
    document.body.appendChild(img);

    publisher!.postMessage({ requestUrl: img.src, code: 'INTERNAL_ERROR' });
    await flush();

    expect(img.hasAttribute('data-sw-error-code')).toBe(false);
  });

  it('ignores malformed messages (missing fields, wrong types)', async () => {
    const img = document.createElement('img');
    img.src = 'http://localhost/encrypted-storage/p-42/att-1.original';
    document.body.appendChild(img);

    publisher!.postMessage({ requestUrl: img.src });
    publisher!.postMessage({ code: 'OBJECT_ABSENT' });
    publisher!.postMessage(null);
    publisher!.postMessage('hello');
    await flush();

    expect(img.hasAttribute('data-sw-error-code')).toBe(false);
  });

  it('teardown closes the channel so messages no longer mutate the DOM', async () => {
    const img = document.createElement('img');
    img.src = 'http://localhost/encrypted-storage/p-42/att-1.original';
    document.body.appendChild(img);

    teardown!();
    teardown = undefined;

    publisher!.postMessage({ requestUrl: img.src, code: 'OBJECT_ABSENT' });
    await flush();

    expect(img.hasAttribute('data-sw-error-code')).toBe(false);
  });
});
