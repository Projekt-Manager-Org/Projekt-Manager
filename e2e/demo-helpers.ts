import type { Page, Locator } from '@playwright/test';

/**
 * Demo-recording helpers — turn a Playwright spec into a human-friendly
 * walkthrough video.
 *
 * Three problems this solves over raw `waitForTimeout` sprinkling:
 *   1. **Captions** — each step shows an on-screen banner so a silent
 *      video reads as a narrated walkthrough. The banner is a real DOM
 *      element, so it is burned into the recording with no post-encode
 *      step and no caption sidecar to keep in sync.
 *   2. **Visible cursor that moves like a hand** — Playwright does not
 *      render the pointer, and a `locator.click()` only emits a single
 *      mousemove, so a naive fake cursor teleports between targets.
 *      `moveTo()/click()/fill()/type()` glide the cursor along an eased,
 *      time-spaced path to the target before acting, so motion is legible.
 *   3. **Consistent pacing** — `step()` holds before and after each
 *      action by the same default amounts, replacing ad-hoc sleeps.
 *
 * Drive interactions through the demo methods (not raw locator calls) so
 * the cursor stays in sync with what is happening:
 *
 *   test('guided tour', async ({ page }) => {
 *     const demo = await startDemo(page);
 *     await page.goto('/');
 *     await demo.step('Anmeldung als Inhaber', async () => {
 *       await demo.type(page.getByTestId('login-username'), 'inhaber');
 *       await demo.click(page.getByTestId('login-submit'));
 *     });
 *   });
 */

declare global {
  interface Window {
    /** Set by the injected overlay; updates the on-screen caption banner. */
    __demoSetCaption?: (text: string) => void;
    /** Set by the injected overlay; updates the smaller technical note line. */
    __demoSetNote?: (text: string) => void;
  }
}

export interface DemoStepOptions {
  /** Hold after the caption appears, before the action runs (ms). */
  settleMs?: number;
  /** Hold after the action completes, before the next step (ms). */
  holdMs?: number;
  /**
   * Optional second, smaller line under the caption — the "technical"
   * register (RBAC, encryption, audit). Cleared when the next step omits it.
   */
  note?: string;
}

const STEP_DEFAULTS: Required<Pick<DemoStepOptions, 'settleMs' | 'holdMs'>> = {
  settleMs: 700,
  holdMs: 1200,
};

/**
 * Cursor-glide tuning. `mouse.move(x, y, { steps })` dispatches its
 * intermediate events with no real delay between them, so the fake
 * cursor would still snap to the target in one transition. We instead
 * space the moves ourselves: one mousemove per frame, eased, so the
 * cursor visibly travels. Step count scales with distance for roughly
 * constant on-screen speed.
 */
const GLIDE_FRAME_MS = 7;
const GLIDE_PX_PER_STEP = 18;
const GLIDE_MIN_STEPS = 7;
const GLIDE_MAX_STEPS = 24;

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
  function readNote() {
    try { return sessionStorage.getItem('__demoNote'); } catch (e) { return null; }
  }
  function persistNote(t) {
    try { sessionStorage.setItem('__demoNote', t); } catch (e) { /* opaque origin */ }
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
        transition: 'transform 0.03s linear', transform: 'translate(-100px, -100px)'
      });
      document.body.appendChild(cursor);
    }

    if (!document.getElementById('__demo-captionbox')) {
      // Caption + note live in ONE bottom-anchored flex column so they
      // always stack (never overlap), even when the caption wraps to
      // several lines on a narrow phone viewport.
      var box = document.createElement('div');
      box.id = '__demo-captionbox';
      Object.assign(box.style, {
        position: 'fixed', left: '50%', bottom: '6%', transform: 'translateX(-50%)',
        maxWidth: '82%', display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: '8px', pointerEvents: 'none', zIndex: Z
      });

      var banner = document.createElement('div');
      banner.id = '__demo-caption';
      Object.assign(banner.style, {
        padding: '14px 28px', background: 'rgba(15, 15, 22, 0.88)', color: '#ffffff',
        font: '600 22px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        borderRadius: '14px', boxShadow: '0 6px 26px rgba(0, 0, 0, 0.5)',
        textAlign: 'center', whiteSpace: 'pre-wrap',
        opacity: '0', transition: 'opacity 0.25s ease'
      });
      box.appendChild(banner);

      var note = document.createElement('div');
      note.id = '__demo-note';
      Object.assign(note.style, {
        padding: '6px 16px', background: 'rgba(15, 15, 22, 0.72)',
        color: 'rgba(214, 226, 244, 0.92)',
        font: '500 14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        borderRadius: '9px', textAlign: 'center', whiteSpace: 'pre-wrap',
        letterSpacing: '0.2px', opacity: '0', transition: 'opacity 0.25s ease'
      });
      box.appendChild(note);

      document.body.appendChild(box);
    }

    var b = document.getElementById('__demo-caption');
    var stored = readCaption();
    if (b && stored) { b.textContent = stored; b.style.opacity = '1'; }

    var n = document.getElementById('__demo-note');
    var storedNote = readNote();
    if (n && storedNote) { n.textContent = storedNote; n.style.opacity = '1'; }
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

  window.__demoSetNote = function (text) {
    persistNote(text);
    var nn = document.getElementById('__demo-note');
    if (nn) { nn.textContent = text; nn.style.opacity = text ? '1' : '0'; }
  };
})();
`;

/** A live demo session bound to one page. */
export class Demo {
  /** Last cursor position we glided to — start tracking from the centre. */
  private cx: number;
  private cy: number;

  constructor(private readonly page: Page) {
    const vp = page.viewportSize();
    this.cx = vp ? vp.width / 2 : 200;
    this.cy = vp ? vp.height / 2 : 200;
  }

  /**
   * Show `caption`, hold, run `fn`, hold again. The banner stays on
   * screen until the next `step()` replaces it.
   */
  async step(caption: string, fn: () => Promise<void>, opts: DemoStepOptions = {}): Promise<void> {
    const { settleMs, holdMs } = { ...STEP_DEFAULTS, ...opts };
    await this.page.evaluate((t) => window.__demoSetCaption?.(t), caption);
    await this.page.evaluate((t) => window.__demoSetNote?.(t), opts.note ?? '');
    await this.page.waitForTimeout(settleMs);
    await fn();
    await this.page.waitForTimeout(holdMs);
  }

  /** Smoothly glide the visible cursor to the centre of `target`. */
  async moveTo(target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) return;
    await this.glideTo(box.x + box.width / 2, box.y + box.height / 2);
  }

  /** Glide to `target`, then click it (keeps Playwright actionability). */
  async click(target: Locator): Promise<void> {
    await this.moveTo(target);
    await target.click();
  }

  /** Glide to `target`, then fill it in one shot. */
  async fill(target: Locator, text: string): Promise<void> {
    await this.moveTo(target);
    await target.fill(text);
  }

  /** Glide to `target`, then type character-by-character (visible keystrokes). */
  async type(target: Locator, text: string, opts?: { delay?: number }): Promise<void> {
    await this.moveTo(target);
    await target.pressSequentially(text, opts);
  }

  /**
   * Eased, time-spaced interpolation from the last cursor position to
   * `(tx, ty)`. One mousemove per `GLIDE_FRAME_MS` so the cursor visibly
   * travels; the real synthetic pointer follows the same path, so a
   * subsequent `click()` lands exactly where the cursor came to rest.
   */
  private async glideTo(tx: number, ty: number): Promise<void> {
    const sx = this.cx;
    const sy = this.cy;
    const dist = Math.hypot(tx - sx, ty - sy);
    const steps = Math.min(
      GLIDE_MAX_STEPS,
      Math.max(GLIDE_MIN_STEPS, Math.round(dist / GLIDE_PX_PER_STEP)),
    );
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // ease-in-out (accelerate, then decelerate) for natural-looking motion
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await this.page.mouse.move(sx + (tx - sx) * e, sy + (ty - sy) * e);
      await this.page.waitForTimeout(GLIDE_FRAME_MS);
    }
    this.cx = tx;
    this.cy = ty;
  }
}

/**
 * Install the overlay and return a demo session. Call this BEFORE the
 * first `page.goto` — `addInitScript` only applies to subsequent
 * navigations.
 */
export async function startDemo(page: Page): Promise<Demo> {
  await page.addInitScript(OVERLAY_SCRIPT);
  return new Demo(page);
}
