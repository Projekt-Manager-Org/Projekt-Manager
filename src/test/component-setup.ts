/**
 * Component-test setup: registers jest-dom matchers and configures
 * Testing Library cleanup after each test.
 *
 * Also installs a no-op `EventSource` stub. jsdom does not implement
 * the WHATWG `EventSource` interface, and the shared SSE client
 * (`src/sse/client.ts`) constructs one lazily on first subscriber.
 * Any component test that mounts a surface holding a subscriber
 * (e.g. the Footer storage badge under a `data:export` user) would
 * otherwise crash with `ReferenceError: EventSource is not defined`.
 * The stub matches the surface the SSE client uses
 * (`addEventListener` / `removeEventListener` / `close`); no events
 * are ever dispatched, which is the right default for unit tests
 * that mock or ignore SSE.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `__APP_GIT_SHA__` is baked into the client bundle by vite's `define`
// at build time (see vite.config.ts). Vitest runs through its own
// config (vitest.config.ts) and does NOT see vite.config.ts's define,
// so the identifier resolves as a normal global lookup at test
// runtime. Default to empty string here so the Footer renders without
// the chip; tests that pin chip behaviour override with
// `vi.stubGlobal('__APP_GIT_SHA__', '...')`.
if (typeof (globalThis as { __APP_GIT_SHA__?: string }).__APP_GIT_SHA__ === 'undefined') {
  (globalThis as unknown as { __APP_GIT_SHA__: string }).__APP_GIT_SHA__ = '';
}

if (typeof globalThis.EventSource === 'undefined') {
  class EventSourceStub {
    url: string;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
    dispatchEvent(): boolean {
      return false;
    }
  }
  (globalThis as { EventSource: unknown }).EventSource = EventSourceStub;
}

// jsdom does not implement window.matchMedia. Components that probe
// media queries at construction (VollstaendigerExportDialog's mobile
// probe, for instance) would crash any test that mounts them
// indirectly via the Daten view. Stub returns "no match" — the desktop
// branch in every consumer.
if (typeof globalThis.matchMedia === 'undefined') {
  (globalThis as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    addListener: (): void => {},
    removeListener: (): void => {},
    dispatchEvent: (): boolean => false,
  });
}

afterEach(() => {
  cleanup();
});
