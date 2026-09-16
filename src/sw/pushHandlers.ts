/**
 * Service Worker push + notificationclick handlers (spec
 * ui/behavior.md §9.8). Wired into the bundled SW entry at
 * `src/sw/index.ts`.
 *
 * Scope is deliberately minimal:
 *   - No fetch/caching strategy, no offline support.
 *   - No periodic sync, no background fetch.
 *   - No analytics, no telemetry, no third-party network calls.
 *
 * The push surface only exists to make Web Push work — everything else
 * (binary attachment decryption) lives in `decryptHandler.ts` and is
 * wired in `index.ts` alongside these.
 */

/// <reference lib="webworker" />

import { BRANDING } from '@/config/brandingConfig';

declare const self: ServiceWorkerGlobalScope;

interface PushPayload {
  title: string;
  body: string;
  url: string;
}

/**
 * Parse a push payload into `{ title, body, url }`. The server sends
 * JSON; if a push lands with no body or an unparseable body, fall back
 * to a generic notification so the user still sees *something*.
 */
function parsePayload(event: PushEvent): PushPayload {
  // AC-363: the notification names the installation, so the name comes
  // from the branding config rather than a literal that drifts from it.
  const fallback: PushPayload = { title: BRANDING.appName, body: '', url: '/' };
  if (!event.data) return fallback;
  try {
    const data = event.data.json() as Partial<PushPayload>;
    return {
      title: typeof data.title === 'string' && data.title.length > 0 ? data.title : fallback.title,
      body: typeof data.body === 'string' ? data.body : fallback.body,
      url: typeof data.url === 'string' && data.url.length > 0 ? data.url : fallback.url,
    };
  } catch {
    const text = event.data.text();
    return { ...fallback, body: typeof text === 'string' ? text : '' };
  }
}

export function handlePush(event: PushEvent): void {
  const { title, body, url } = parsePayload(event);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url },
    }),
  );
}

export function handleNotificationClick(event: NotificationEvent): void {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  const targetUrl = (data && typeof data.url === 'string' && data.url) || '/';
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Find a tab already showing the target path. If one exists, focus
      // it — do not redirect other open tabs. If none exists, open a new
      // window pointing at the target URL.
      const targetPath = new URL(targetUrl, self.location.origin).pathname;
      const match = allClients.find((c) => new URL(c.url).pathname === targetPath);
      if (match) {
        await match.focus();
        return;
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
}
