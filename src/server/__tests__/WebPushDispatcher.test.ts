/**
 * WebPushDispatcher unit tests — ADR-0023.
 *
 * Pins the status-code → PushDispatchStatus mapping on the two
 * critical axes:
 *   - 200/201/202 → `'ok'`           (push accepted by the service)
 *   - 404/410     → `'gone'`         (subscription dead, prune it)
 *   - other       → `'error'`        (429, 5xx, network, timeout)
 *
 * `send()` must never throw — the publisher's fan-out loop relies on
 * infallibility (architecture.md §11.11).
 *
 * Scope: we mock `web-push.sendNotification` via `vi.mock`. No real
 * HTTP, no real VAPID crypto. A full integration test against a live
 * push service is out of scope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock web-push BEFORE importing the dispatcher so the dispatcher's
// module-level `import webpush from 'web-push'` picks up the mock.
vi.mock('web-push', async () => {
  const actual = await vi.importActual<typeof import('web-push')>('web-push');
  return {
    ...actual,
    default: {
      setVapidDetails: vi.fn(),
      sendNotification: vi.fn(),
    },
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
    // Keep WebPushError as the real class so `instanceof` checks work.
    WebPushError: actual.WebPushError,
  };
});

import webpush, { WebPushError } from 'web-push';
import { WebPushDispatcher, mapStatus } from '../services/WebPushDispatcher.js';

const mockSendNotification = vi.mocked(webpush.sendNotification);
const mockSetVapidDetails = vi.mocked(webpush.setVapidDetails);

const target = {
  id: 'sub-1',
  userId: 'user-1',
  endpoint: 'https://push.example.test/endpoint/abc',
  p256dh: 'p256-key',
  auth: 'auth-key',
};

// AC-211 — payload now carries the user-facing strings the SW reads
// alongside the diagnostic eventClass / auditEntryId fields.
const payload = {
  title: 'Projekt-Statuswechsel vorwärts',
  body: '2026-002 Innenraumgestaltung Weber → Beauftragt',
  url: '/projects/project-1',
  eventClass: 'project.transition_forward',
  auditEntryId: null,
};

describe('WebPushDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT call setVapidDetails on construction (per-call vapidDetails used instead)', () => {
    // Constructor no longer calls setVapidDetails — VAPID credentials are
    // passed per-call via the `vapidDetails` option in sendNotification.
    // This prevents a race when two dispatcher instances coexist (e.g.
    // tests), because the module-level state in `web-push` would otherwise
    // be last-write-wins.
    new WebPushDispatcher({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:admin@example.test',
    });
    expect(mockSetVapidDetails).not.toHaveBeenCalled();
  });

  it('maps 201 Created to "ok"', async () => {
    mockSendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });

    const dispatcher = new WebPushDispatcher({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:admin@example.test',
    });

    await expect(dispatcher.send(target, payload)).resolves.toBe('ok');
  });

  it('maps 410 Gone to "gone"', async () => {
    // 410 comes back as a thrown WebPushError — the real transport
    // distinguishes 2xx (resolved) from error-class status (rejected).
    mockSendNotification.mockRejectedValue(
      new WebPushError('gone', 410, {}, 'Subscription expired', target.endpoint),
    );

    const dispatcher = new WebPushDispatcher({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:admin@example.test',
    });

    await expect(dispatcher.send(target, payload)).resolves.toBe('gone');
  });

  it('maps 404 Not Found to "gone"', async () => {
    mockSendNotification.mockRejectedValue(
      new WebPushError('not found', 404, {}, 'Not Found', target.endpoint),
    );

    const dispatcher = new WebPushDispatcher({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:admin@example.test',
    });

    await expect(dispatcher.send(target, payload)).resolves.toBe('gone');
  });

  it('maps 429 Too Many Requests to "error" (not "gone")', async () => {
    // 429 is transient — the subscription is still valid; callers
    // should not prune it.
    mockSendNotification.mockRejectedValue(
      new WebPushError('rate limited', 429, {}, 'Too Many Requests', target.endpoint),
    );

    const dispatcher = new WebPushDispatcher({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:admin@example.test',
    });

    await expect(dispatcher.send(target, payload)).resolves.toBe('error');
  });

  it('maps a network failure to "error" without throwing', async () => {
    mockSendNotification.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const dispatcher = new WebPushDispatcher({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:admin@example.test',
    });

    await expect(dispatcher.send(target, payload)).resolves.toBe('error');
  });

  it('JSON-serializes the payload and forwards TTL + timeout options', async () => {
    mockSendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });

    const dispatcher = new WebPushDispatcher({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:admin@example.test',
    });

    await dispatcher.send(target, payload);

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const [subArg, payloadArg, optsArg] = mockSendNotification.mock.calls[0]!;
    expect(subArg).toEqual({
      endpoint: target.endpoint,
      keys: { p256dh: target.p256dh, auth: target.auth },
    });
    expect(payloadArg).toBe(JSON.stringify(payload));
    expect(optsArg).toEqual(
      expect.objectContaining({
        TTL: expect.any(Number),
        timeout: expect.any(Number),
        vapidDetails: expect.objectContaining({
          subject: 'mailto:admin@example.test',
          publicKey: 'pub',
          privateKey: 'priv',
        }),
      }),
    );
  });
});

describe('mapStatus', () => {
  it.each([
    [200, 'ok'],
    [201, 'ok'],
    [202, 'ok'],
    [404, 'gone'],
    [410, 'gone'],
    [400, 'error'],
    [429, 'error'],
    [500, 'error'],
    [502, 'error'],
    [null, 'error'],
  ] as const)('status %s → %s', (code, expected) => {
    expect(mapStatus(code)).toBe(expected);
  });
});
