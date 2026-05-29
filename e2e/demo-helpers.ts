import fs from 'node:fs';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Demo-recording helpers — turn a Playwright spec into a human-friendly
 * walkthrough video.
 *
 * Three problems this solves over raw `waitForTimeout` sprinkling:
 *   1. **Captions** — each step shows an on-screen banner so a silent
 *      video reads as a narrated walkthrough. The banner is a real DOM
 *      element, so it is burned into the recording with no post-encode
 *      step. The same caption list is dumped to `captions.json` next to
 *      the video, from which `scripts/demo/encode.mjs` can emit a `.srt`.
 *   2. **Visible cursor** — Playwright does not render the pointer in the
 *      recording. We inject a fake cursor that follows the synthetic
 *      pointer (its `mousemove`/`mousedown` events are real DOM events)
 *      plus a click ripple, so clicks are legible on screen.
 *   3. **Consistent pacing** — `step()` holds before and after each
 *      action by the same default amounts, replacing ad-hoc sleeps.
 *
 * Usage (note the second `testInfo` arg of the test callback):
 *
 *   test('guided tour', async ({ page }, testInfo) => {
 *     const demo = await startDemo(page, testInfo);
 *     await page.goto('/');
 *     await demo.step('Anmeldung als Inhaber', async () => {
 *       await page.getByTestId('login-username').fill('inhaber');
 *       ...
 *     });
 *     await demo.finish();
 *   });
 */

declare global {
  interface Window {
    /** Set by the injected overlay; updates the on-screen caption banner. */
    __demoSetCaption?: (text: string) => void;
  }
}

export interface DemoStepOptions {
  /** Hold after the caption appears, before the action runs (ms). */
  settleMs?: number;
  /** Hold after the action completes, before the next step (ms). */
  holdMs?: number;
}

const STEP_DEFAULTS: Required<DemoStepOptions> = { settleMs: 700, holdMs: 1200 };

interface CaptionEntry {
  text: string;
  /** ms from demo start (≈ video start) when this caption appeared. */
  atMs: number;
}

/**
 * Browser overlay, injected once per document via `addInitScript`:
 * a fake cursor that follows the synthetic pointer, a click ripple, and
 * a caption banner wired to `window.__demoSetCaption`. Re-runs on every
 * navigation (fresh JS context), restoring the current caption from
 * `sessionStorage` so it survives same-origin navigations.
 *
 * Authored as a raw JS string on purpose: a TS function passed to
 * `addInitScript` is serialized via `Function.prototype.toString()`, but
 * the esbuild/tsx transpile injects a `__name` keepNames helper into the
 * compiled body — which is undefined in the page and throws on load
 * ("__name is not defined"). A string is injected verbatim, immune to
 * whatever transpile the test runner applies. `sessionStorage` access is
 * guarded because it throws on opaque origins (e.g. about:blank).
 */
const OVERLAY_SCRIPT = String.raw`
(function () {
  if (window.__demoOverlayInstalled) return;
  window.__demoOverlayInstalled = true;
  var Z = '2147483647';

  function readCaption() {
    try { return sessionStorage.getItem('__demoCaption'); } catch (e) { return null; }
  }
  function persistCaption(t) {
    try { sessionStorage.setItem('__demoCaption', t); } catch (e) { /* opaque origin */ }
  }

  function build() {
    if (!document.body) { requestAnimationFrame(build); return; }

    if (!document.getElementById('__demo-cursor')) {
      var cursor = document.createElement('div');
      cursor.id = '__demo-cursor';
      Object.assign(cursor.style, {
        position: 'fixed', top: '0', left: '0', width: '24px', height: '24px',
        marginLeft: '-12px', marginTop: '-12px', borderRadius: '50%',
        background: 'rgba(255, 70, 70, 0.40)', border: '2px solid rgba(255, 255, 255, 0.92)',
        boxShadow: '0 0 10px rgba(0, 0, 0, 0.55)', pointerEvents: 'none', zIndex: Z,
        transition: 'transform 0.08s linear', transform: 'translate(-100px, -100px)'
      });
      document.body.appendChild(cursor);
    }

    if (!document.getElementById('__demo-caption')) {
      var banner = document.createElement('div');
      banner.id = '__demo-caption';
      Object.assign(banner.style, {
        position: 'fixed', left: '50%', bottom: '7%', transform: 'translateX(-50%)',
        maxWidth: '82%', padding: '14px 28px', background: 'rgba(15, 15, 22, 0.88)',
        color: '#ffffff',
        font: '600 22px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        borderRadius: '14px', boxShadow: '0 6px 26px rgba(0, 0, 0, 0.5)',
        pointerEvents: 'none', zIndex: Z, textAlign: 'center', whiteSpace: 'pre-wrap',
        opacity: '0', transition: 'opacity 0.25s ease'
      });
      document.body.appendChild(banner);
    }

    var b = document.getElementById('__demo-caption');
    var stored = readCaption();
    if (b && stored) { b.textContent = stored; b.style.opacity = '1'; }
  }

  build();

  document.addEventListener('mousemove', function (e) {
    var c = document.getElementById('__demo-cursor');
    if (c) c.style.transform = 'translate(' + e.clientX + 'px, ' + e.clientY + 'px)';
  }, true);

  document.addEventListener('mousedown', function (e) {
    if (!document.body) return;
    var r = document.createElement('div');
    Object.assign(r.style, {
      position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px',
      width: '12px', height: '12px', marginLeft: '-6px', marginTop: '-6px',
      borderRadius: '50%', border: '2px solid rgba(255, 70, 70, 0.95)',
      pointerEvents: 'none', zIndex: Z, transform: 'scale(1)', opacity: '1',
      transition: 'transform 0.45s ease-out, opacity 0.45s ease-out'
    });
    document.body.appendChild(r);
    requestAnimationFrame(function () { r.style.transform = 'scale(4)'; r.style.opacity = '0'; });
    setTimeout(function () { r.remove(); }, 500);
  }, true);

  window.__demoSetCaption = function (text) {
    persistCaption(text);
    var bb = document.getElementById('__demo-caption');
    if (bb) { bb.textContent = text; bb.style.opacity = text ? '1' : '0'; }
  };
})();
`;

/** A live demo session bound to one page + test. */
export class Demo {
  private readonly captions: CaptionEntry[] = [];

  constructor(
    private readonly page: Page,
    private readonly testInfo: TestInfo,
    private readonly t0: number,
  ) {}

  /**
   * Show `caption`, hold, run `fn`, hold again. The banner stays on
   * screen until the next `step()` replaces it.
   */
  async step(caption: string, fn: () => Promise<void>, opts: DemoStepOptions = {}): Promise<void> {
    const { settleMs, holdMs } = { ...STEP_DEFAULTS, ...opts };
    this.captions.push({ text: caption, atMs: Date.now() - this.t0 });
    await this.page.evaluate((t) => window.__demoSetCaption?.(t), caption);
    await this.page.waitForTimeout(settleMs);
    await fn();
    await this.page.waitForTimeout(holdMs);
  }

  /**
   * Persist the caption timeline next to the video so the encode step
   * can emit a `.srt`. Playwright writes `video.webm` into
   * `testInfo.outputDir`; we drop `captions.json` in the same folder.
   */
  async finish(): Promise<void> {
    fs.mkdirSync(this.testInfo.outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.testInfo.outputDir, 'captions.json'),
      JSON.stringify(
        {
          title: this.testInfo.title,
          project: this.testInfo.project.name,
          entries: this.captions,
        },
        null,
        2,
      ),
    );
  }
}

/**
 * Install the overlay and start the caption timeline. Call this BEFORE
 * the first `page.goto` — `addInitScript` only applies to subsequent
 * navigations.
 */
export async function startDemo(page: Page, testInfo: TestInfo): Promise<Demo> {
  await page.addInitScript(OVERLAY_SCRIPT);
  return new Demo(page, testInfo, Date.now());
}
