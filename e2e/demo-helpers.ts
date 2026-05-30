import type { Page, Locator } from '@playwright/test';

/**
 * Demo-recording helpers — turn a Playwright spec into a human-friendly
 * walkthrough video.
 *
 * Four problems this solves over raw `waitForTimeout` sprinkling:
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
 *   4. **Scene framing** — `scene()` shows a small, self-dismissing
 *      persona chip (who/role/device) at the top of each segment so a
 *      stitched film tells the viewer whose shoes they are in;
 *      `revealFacts()` blurs the live app behind frosted glass and floats
 *      the otherwise-invisible backend guarantees on top as fact cards.
 *
 * Drive interactions through the demo methods (not raw locator calls) so
 * the cursor stays in sync with what is happening:
 *
 *   test('guided tour', async ({ page }) => {
 *     const demo = await startDemo(page);
 *     await page.goto('/');
 *     await demo.scene({ name: 'Maria Schmidt', role: 'Büro', device: 'Desktop' });
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
    /** Show the persona chip; auto-fades after `holdMs`. */
    __demoSetScene?: (p: { name: string; role: string; device: string; holdMs: number }) => void;
    /** Fade the frosted-glass reveal layer in (true) or out (false). */
    __demoGlass?: (on: boolean) => void;
    /** Set the reveal heading + subtitle and fade them in. */
    __demoFactTitle?: (title: string, subtitle: string) => void;
    /** Append one fact card (plain melody line + technical bassline) and fade it in. */
    __demoFactAdd?: (melody: string, bassline: string) => void;
    /** Set the closing punch line under the fact list and fade it in. */
    __demoFactClose?: (text: string) => void;
    /** Show/hide the scene-change cue (forward-flowing chevrons). */
    __demoFactNext?: (on: boolean) => void;
    /** Clear all reveal content (title, facts, close, cue) for reuse. */
    __demoFactReset?: () => void;
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

/** Who/where a segment is shot from — the self-dismissing persona chip. */
export interface DemoScene {
  /** Display name, e.g. "Maria Schmidt". */
  name: string;
  /** Role label, e.g. "Büro", "Inhaber", "Mitarbeiter". */
  role: string;
  /** Device label, e.g. "Desktop" or "Handy" (selects the chip glyph). */
  device: 'Desktop' | 'Handy';
  /** How long the chip stays before it fades out (ms). */
  holdMs?: number;
}

/** A single plain-language claim paired with its technical proof. */
export interface DemoFact {
  /** The human (melody) line — plain language, the promise. */
  melody: string;
  /** The technical (bassline) line — the mechanism, for devs/power users. */
  bassline: string;
}

export interface DemoRevealOptions {
  /** Heading shown above the fact list. */
  title: string;
  /** One-line subtitle under the heading. */
  subtitle: string;
  /** The fact cards, revealed one by one. */
  facts: DemoFact[];
  /** Optional closing punch line under the list. */
  close?: string;
  /** Hold after the glass + title appear, before the first fact (ms). */
  settleMs?: number;
  /** Hold after each fact card appears (ms). */
  perFactMs?: number;
  /** Hold after the closing line, before the scene-change cue (ms). */
  closeMs?: number;
  /** Hold after the cue appears, before the segment ends (ms). */
  holdMs?: number;
}

const STEP_DEFAULTS: Required<Pick<DemoStepOptions, 'settleMs' | 'holdMs'>> = {
  settleMs: 700,
  holdMs: 1200,
};

const SCENE_DEFAULT_HOLD_MS = 3800;

const REVEAL_DEFAULTS: Required<
  Pick<DemoRevealOptions, 'settleMs' | 'perFactMs' | 'closeMs' | 'holdMs'>
> = {
  settleMs: 1100,
  perFactMs: 1650,
  closeMs: 1500,
  holdMs: 3000,
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
 * a fake cursor that follows the synthetic pointer, a click ripple, a
 * caption banner, a self-dismissing persona chip, and a frosted-glass
 * fact-reveal layer — all wired to `window.__demo*` hooks. Re-runs on
 * every navigation (fresh JS context), restoring the current caption from
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
  var DEV_ICON = {
    Desktop: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6ea8fe" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    Handy: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6ea8fe" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>'
  };

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

    if (!document.getElementById('__demo-overlay-style')) {
      // Keyframes for the scene-change cue (the chevrons that flow forward
      // after the last Daten card). Inline styles can't carry @keyframes.
      var st = document.createElement('style');
      st.id = '__demo-overlay-style';
      st.textContent =
        '@keyframes demoNextFlow{0%,100%{opacity:.25;transform:translateX(0)}' +
        '50%{opacity:1;transform:translateX(8px)}}' +
        '#__demo-glass-next span{display:inline-block;animation:demoNextFlow 1.1s ease-in-out infinite}' +
        '#__demo-glass-next span:nth-child(2){animation-delay:.14s}' +
        '#__demo-glass-next span:nth-child(3){animation-delay:.28s}';
      (document.head || document.documentElement).appendChild(st);
    }

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

    if (!document.getElementById('__demo-scene')) {
      // Persona chip — top-left, self-dismissing. Two lines: name (bold)
      // over "role · device", with a small device glyph.
      var chip = document.createElement('div');
      chip.id = '__demo-scene';
      Object.assign(chip.style, {
        position: 'fixed', top: '5%', left: '3.2%', display: 'flex', alignItems: 'center',
        gap: '14px', padding: '16px 26px', background: 'rgba(13, 18, 28, 0.94)',
        border: '1px solid rgba(110, 168, 254, 0.45)', borderLeft: '5px solid #6ea8fe',
        borderRadius: '15px', boxShadow: '0 14px 38px rgba(0, 0, 0, 0.6)',
        pointerEvents: 'none', zIndex: Z,
        opacity: '0', transform: 'translateY(-14px) scale(0.92)',
        transition: 'opacity 0.4s ease, transform 0.45s cubic-bezier(0.18, 0.9, 0.28, 1.25)'
      });
      var icon = document.createElement('div');
      icon.id = '__demo-scene-icon';
      Object.assign(icon.style, { display: 'flex', alignItems: 'center', flex: '0 0 auto' });
      chip.appendChild(icon);
      var txt = document.createElement('div');
      Object.assign(txt.style, { display: 'flex', flexDirection: 'column', lineHeight: '1.25' });
      var nm = document.createElement('div');
      nm.id = '__demo-scene-name';
      Object.assign(nm.style, {
        color: '#ffffff', font: '700 23px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        letterSpacing: '0.2px'
      });
      var rl = document.createElement('div');
      rl.id = '__demo-scene-role';
      Object.assign(rl.style, {
        color: '#9db4d6',
        font: '600 14.5px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        letterSpacing: '0.3px', marginTop: '1px'
      });
      txt.appendChild(nm); txt.appendChild(rl);
      chip.appendChild(txt);
      document.body.appendChild(chip);
    }

    if (!document.getElementById('__demo-glass')) {
      // Frosted-glass reveal — blurs the live app behind it and floats
      // the invisible backend guarantees on top as fact cards.
      var glass = document.createElement('div');
      glass.id = '__demo-glass';
      Object.assign(glass.style, {
        position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: '0 8%',
        background: 'linear-gradient(rgba(7, 11, 19, 0.64), rgba(7, 11, 19, 0.78))',
        backdropFilter: 'blur(16px)', webkitBackdropFilter: 'blur(16px)',
        pointerEvents: 'none', zIndex: Z, opacity: '0',
        transition: 'opacity 0.55s ease'
      });

      var gt = document.createElement('div');
      gt.id = '__demo-glass-title';
      Object.assign(gt.style, {
        color: '#ffffff', textAlign: 'center', opacity: '0',
        font: '700 40px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        transition: 'opacity 0.45s ease', letterSpacing: '0.3px'
      });
      glass.appendChild(gt);

      var gs = document.createElement('div');
      gs.id = '__demo-glass-sub';
      Object.assign(gs.style, {
        color: '#aebfd6', textAlign: 'center', marginTop: '12px', opacity: '0',
        font: '500 21px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        transition: 'opacity 0.45s ease'
      });
      glass.appendChild(gs);

      var gf = document.createElement('div');
      gf.id = '__demo-glass-facts';
      Object.assign(gf.style, {
        display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '40px',
        width: '100%', maxWidth: '900px'
      });
      glass.appendChild(gf);

      var gc = document.createElement('div');
      gc.id = '__demo-glass-close';
      Object.assign(gc.style, {
        color: '#6ea8fe', textAlign: 'center', marginTop: '40px', opacity: '0',
        font: '600 24px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        transition: 'opacity 0.5s ease'
      });
      glass.appendChild(gc);

      // Scene-change cue — chevrons that flow forward once the reveal is done,
      // telling the viewer the film is about to cut to the next segment.
      var gn = document.createElement('div');
      gn.id = '__demo-glass-next';
      Object.assign(gn.style, {
        marginTop: '30px', color: '#6ea8fe', letterSpacing: '6px', opacity: '0',
        font: '700 34px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        transition: 'opacity 0.5s ease'
      });
      gn.innerHTML = '<span>›</span><span>›</span><span>›</span>';
      glass.appendChild(gn);

      document.body.appendChild(glass);
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

  window.__demoSceneTimer = null;
  window.__demoSetScene = function (p) {
    var chip = document.getElementById('__demo-scene');
    if (!chip) return;
    var icon = document.getElementById('__demo-scene-icon');
    if (icon) icon.innerHTML = DEV_ICON[p.device] || DEV_ICON.Desktop;
    var nm = document.getElementById('__demo-scene-name');
    if (nm) nm.textContent = p.name;
    var rl = document.getElementById('__demo-scene-role');
    if (rl) rl.textContent = p.role + ' · ' + p.device;
    chip.style.opacity = '1';
    chip.style.transform = 'translateY(0) scale(1)';
    if (window.__demoSceneTimer) clearTimeout(window.__demoSceneTimer);
    window.__demoSceneTimer = setTimeout(function () {
      chip.style.opacity = '0';
      chip.style.transform = 'translateY(-14px) scale(0.92)';
    }, p.holdMs);
  };

  window.__demoGlass = function (on) {
    var g = document.getElementById('__demo-glass');
    if (g) g.style.opacity = on ? '1' : '0';
    // Hide the hand cursor while the glass is up — there is nothing to click.
    var c = document.getElementById('__demo-cursor');
    if (c) c.style.opacity = on ? '0' : '1';
  };

  window.__demoFactTitle = function (title, subtitle) {
    var gt = document.getElementById('__demo-glass-title');
    if (gt) { gt.textContent = title; gt.style.opacity = '1'; }
    var gs = document.getElementById('__demo-glass-sub');
    if (gs) { gs.textContent = subtitle; gs.style.opacity = subtitle ? '1' : '0'; }
  };

  window.__demoFactAdd = function (melody, bassline) {
    var gf = document.getElementById('__demo-glass-facts');
    if (!gf) return;
    var row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', flexDirection: 'column', gap: '4px', textAlign: 'left',
      padding: '14px 22px', borderRadius: '14px',
      background: 'rgba(20, 28, 42, 0.55)', border: '1px solid rgba(120, 150, 190, 0.22)',
      borderLeft: '3px solid #6ea8fe', opacity: '0', transform: 'translateY(12px)',
      transition: 'opacity 0.4s ease, transform 0.4s ease'
    });
    var m = document.createElement('div');
    Object.assign(m.style, {
      color: '#ffffff',
      font: '600 21px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    });
    m.textContent = melody;
    var bl = document.createElement('div');
    Object.assign(bl.style, {
      color: 'rgba(157, 180, 214, 0.95)',
      font: '500 14.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.2px'
    });
    bl.textContent = bassline;
    row.appendChild(m); row.appendChild(bl);
    gf.appendChild(row);
    requestAnimationFrame(function () {
      row.style.opacity = '1';
      row.style.transform = 'translateY(0)';
    });
  };

  window.__demoFactClose = function (text) {
    var gc = document.getElementById('__demo-glass-close');
    if (gc) { gc.textContent = text; gc.style.opacity = text ? '1' : '0'; }
  };

  window.__demoFactNext = function (on) {
    var gn = document.getElementById('__demo-glass-next');
    if (gn) gn.style.opacity = on ? '1' : '0';
  };

  window.__demoFactReset = function () {
    var gf = document.getElementById('__demo-glass-facts');
    if (gf) gf.innerHTML = '';
    var gt = document.getElementById('__demo-glass-title');
    if (gt) { gt.textContent = ''; gt.style.opacity = '0'; }
    var gs = document.getElementById('__demo-glass-sub');
    if (gs) { gs.textContent = ''; gs.style.opacity = '0'; }
    var gc = document.getElementById('__demo-glass-close');
    if (gc) { gc.textContent = ''; gc.style.opacity = '0'; }
    var gn = document.getElementById('__demo-glass-next');
    if (gn) gn.style.opacity = '0';
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

  /**
   * Flash the persona chip (who/role/device) at the top-left for `holdMs`,
   * then let it fade. Call once at the start of a persona segment; it does
   * not block the rest of the take — the chip dismisses itself.
   */
  async scene(scene: DemoScene): Promise<void> {
    const payload = {
      name: scene.name,
      role: scene.role,
      device: scene.device,
      holdMs: scene.holdMs ?? SCENE_DEFAULT_HOLD_MS,
    };
    await this.page.evaluate((p) => window.__demoSetScene?.(p), payload);
    // Let the chip settle in before the action starts.
    await this.page.waitForTimeout(450);
  }

  /**
   * Blur the live app behind frosted glass and reveal the invisible
   * backend guarantees as fact cards, one by one. Used for the data
   * segment, where the thing being shown has no UI — it lives in the
   * server, the object store, and the backup drills.
   */
  async revealFacts(opts: DemoRevealOptions): Promise<void> {
    const { settleMs, perFactMs, closeMs, holdMs } = { ...REVEAL_DEFAULTS, ...opts };
    await this.page.evaluate(() => {
      window.__demoSetCaption?.('');
      window.__demoSetNote?.('');
      window.__demoFactReset?.();
      window.__demoGlass?.(true);
    });
    await this.page.waitForTimeout(550);
    await this.page.evaluate(
      ({ title, subtitle }) => window.__demoFactTitle?.(title, subtitle),
      { title: opts.title, subtitle: opts.subtitle },
    );
    await this.page.waitForTimeout(settleMs);

    for (const fact of opts.facts) {
      await this.page.evaluate(
        ({ melody, bassline }) => window.__demoFactAdd?.(melody, bassline),
        { melody: fact.melody, bassline: fact.bassline },
      );
      await this.page.waitForTimeout(perFactMs);
    }

    if (opts.close) {
      await this.page.evaluate((t) => window.__demoFactClose?.(t), opts.close);
      await this.page.waitForTimeout(closeMs);
    }
    // Flow the scene-change cue, then dwell so the reveal doesn't snap away.
    await this.page.evaluate(() => window.__demoFactNext?.(true));
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
