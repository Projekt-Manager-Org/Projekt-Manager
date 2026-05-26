/**
 * Service Worker entry — single bundled artifact at `/sw.js`.
 *
 * Two surfaces in one worker:
 *   - Push + notificationclick (pushHandlers.ts) — Web Push, iter-8.
 *   - Synthetic-origin fetch intercept on `/encrypted-storage/*`
 *     (decryptHandler.ts) — binary attachment e2e, iter-9, ADR-0024
 *     §Service-Worker decryption.
 *
 * Lifecycle: skipWaiting + clients.claim so a freshly-deployed SW
 * controls open tabs without a second reload — same behavior as the
 * iter-8 standalone worker.
 */

/// <reference lib="webworker" />

import { handleEncryptedStorageRequest } from './decryptHandler';
import { handlePush, handleNotificationClick } from './pushHandlers';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/encrypted-storage/')) {
    event.respondWith(handleEncryptedStorageRequest(event.request));
    return;
  }
});

self.addEventListener('push', handlePush);
self.addEventListener('notificationclick', handleNotificationClick);
