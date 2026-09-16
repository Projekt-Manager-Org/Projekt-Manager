/**
 * Service Worker push fallback identity (AC-363).
 *
 * A push that arrives with no body, or a body the SW cannot parse, still
 * raises a notification — and that notification names the installation.
 * The name it uses is the third copy of `BRANDING.appName` the app shell
 * used to keep (alongside `<title>` and the manifest).
 *
 * The branding module is mocked to a name that is NOT the one this repo
 * ships. Asserting against the real `BRANDING.appName` would prove
 * nothing: it is the same string the handler used to hardcode, so the
 * test would pass either way. A foreign name is what separates "derived
 * from config" from "coincides with the default".
 *
 * Three arms reach the fallback title through different paths, plus one
 * that must NOT: a payload carrying its own title has to win, or an
 * implementation that ignores the payload and always announces the app
 * name would satisfy every other case here. What the server puts IN
 * that payload is a separate contract (`pushPayloadComposer.test.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const FOREIGN_APP_NAME = 'Müller Bau Projekte';

vi.mock('@/config/brandingConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/brandingConfig')>();
  return { ...actual, BRANDING: { ...actual.BRANDING, appName: FOREIGN_APP_NAME } };
});

const { handlePush } = await import('../pushHandlers');

const showNotification = vi.fn();

/**
 * `pushHandlers` reads the worker global `self`. Under jsdom that is
 * `window`, which carries no `registration` — so the property is
 * installed for the duration of each test and removed afterwards.
 */
beforeEach(() => {
  showNotification.mockReset();
  Object.defineProperty(globalThis.self, 'registration', {
    value: { showNotification },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis.self as unknown as Record<string, unknown>, 'registration');
});

/** Minimal stand-in for the parts of `PushEvent` the handler touches. */
function pushEvent(data: PushMessageData | null): PushEvent {
  return {
    data,
    waitUntil: (value: Promise<unknown>) => void value,
  } as unknown as PushEvent;
}

describe('handlePush — AC-363 fallback notification identity', () => {
  it('titles a body-less push with the configured app name', () => {
    handlePush(pushEvent(null));
    expect(showNotification).toHaveBeenCalledWith(FOREIGN_APP_NAME, expect.anything());
  });

  it('titles an unparseable push with the configured app name', () => {
    const data = {
      json: () => {
        throw new SyntaxError('not JSON');
      },
      text: () => 'raw text',
    } as unknown as PushMessageData;

    handlePush(pushEvent(data));
    expect(showNotification).toHaveBeenCalledWith(
      FOREIGN_APP_NAME,
      expect.objectContaining({ body: 'raw text' }),
    );
  });

  it('titles a push whose payload omits a title with the configured app name', () => {
    const data = {
      json: () => ({ body: 'Projekt aktualisiert', url: '/projekte' }),
      text: () => '',
    } as unknown as PushMessageData;

    handlePush(pushEvent(data));
    expect(showNotification).toHaveBeenCalledWith(
      FOREIGN_APP_NAME,
      expect.objectContaining({ body: 'Projekt aktualisiert' }),
    );
  });

  it('lets a payload title win over the configured app name', () => {
    // The arm that stops the fallback from swallowing real pushes:
    // without it, `showNotification(BRANDING.appName, …)` unconditionally
    // would pass every case above.
    const data = {
      json: () => ({ title: 'Projekt 2026-014', body: 'Termin verschoben', url: '/projekte' }),
      text: () => '',
    } as unknown as PushMessageData;

    handlePush(pushEvent(data));
    expect(showNotification).toHaveBeenCalledWith(
      'Projekt 2026-014',
      expect.objectContaining({ body: 'Termin verschoben' }),
    );
  });
});
