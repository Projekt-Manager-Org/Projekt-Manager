/**
 * What this device's push client does on registering (AC-674), on
 * unregistering (AC-675, and the device half of AC-655) and on sign-in
 * (AC-679). The auth store calls the last two:
 * `pushRegistrationOnAuth.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const subscribeMock = vi.fn();
const unsubscribeByEndpointMock = vi.fn();
const registrationStatusMock = vi.fn();

vi.mock('@/api/client', () => ({
  pushApi: {
    subscribe: (body: unknown) => subscribeMock(body),
    unsubscribeByEndpoint: (endpoint: string) => unsubscribeByEndpointMock(endpoint),
    registrationStatus: (endpoint: string) => registrationStatusMock(endpoint),
  },
}));

const { subscribeToPush, unsubscribeFromPush, dropSubscriptionNotRegisteredForUser } =
  await import('@/pwa/pushClient');

const ENDPOINT = 'https://push.example/this-device';
const browserUnsubscribe = vi.fn<() => Promise<boolean>>();

beforeEach(() => {
  browserUnsubscribe.mockReset().mockResolvedValue(true);
  unsubscribeByEndpointMock.mockReset().mockResolvedValue({ ok: true, data: null });
  registrationStatusMock.mockReset().mockResolvedValue({ ok: true, data: { registered: true } });
  vi.stubGlobal('window', { PushManager: class {}, Notification: class {} });
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => ({ endpoint: ENDPOINT, unsubscribe: browserUnsubscribe }),
        },
      }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('activating with permission granted', () => {
  const browserSubscribe = vi.fn();

  beforeEach(() => {
    subscribeMock.mockReset().mockResolvedValue({ ok: true, data: {} });
    browserSubscribe.mockReset().mockResolvedValue({
      endpoint: ENDPOINT,
      // 0xfb 0xff encodes to `-_8` in base64url and `+/8=` in base64.
      getKey: (name: string) => new Uint8Array(name === 'p256dh' ? [0xfb, 0xff] : [1]).buffer,
      unsubscribe: browserUnsubscribe,
    });
    vi.stubGlobal('Notification', { requestPermission: async () => 'granted' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ vapidPublicKey: 'AQAB' }))),
    );
    vi.stubGlobal('navigator', {
      userAgent: 'test-agent',
      serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe: browserSubscribe } }) },
    });
  });

  it("AC-674: registers the browser's subscription with the server", async () => {
    await expect(subscribeToPush()).resolves.toEqual({ ok: true });
    expect(subscribeMock).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      keys: { p256dh: '-_8', auth: 'AQ' },
      userAgent: 'test-agent',
    });
  });
});

describe('AC-655, AC-675: unregistering this device', () => {
  it('revokes the browser subscription and removes the server registration', async () => {
    await unsubscribeFromPush();
    expect(browserUnsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeByEndpointMock).toHaveBeenCalledWith(ENDPOINT);
  });

  it('revokes the browser subscription even when the server call fails', async () => {
    unsubscribeByEndpointMock.mockResolvedValue({ ok: false, error: { message: 'down' } });
    await expect(unsubscribeFromPush()).rejects.toThrow('down');
    expect(browserUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('AC-679: on sign-in, this device keeps only a registration of the signed-in user', () => {
  it('keeps the subscription registered for the user', async () => {
    await dropSubscriptionNotRegisteredForUser();
    expect(registrationStatusMock).toHaveBeenCalledWith(ENDPOINT);
    expect(browserUnsubscribe).not.toHaveBeenCalled();
  });

  it('revokes a subscription not registered for the user', async () => {
    registrationStatusMock.mockResolvedValue({ ok: true, data: { registered: false } });
    await dropSubscriptionNotRegisteredForUser();
    expect(browserUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('revokes the subscription when the check fails', async () => {
    registrationStatusMock.mockResolvedValue({ ok: false, error: { message: 'down' } });
    await dropSubscriptionNotRegisteredForUser();
    expect(browserUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when the browser holds no subscription', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: async () => undefined },
    });
    await dropSubscriptionNotRegisteredForUser();
    expect(registrationStatusMock).not.toHaveBeenCalled();
  });
});
