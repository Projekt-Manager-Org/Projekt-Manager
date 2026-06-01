# Demo recordings

Scripted, re-runnable multimedia walkthroughs of the app. Playwright drives
the real UI and records video; the dev box encodes it. No phone, no screen
capture, no flaky recording app.

```
prose walkthrough (human-authored)
        │  translated into a spec
        ▼
demo-*.spec.ts ── demo.step / scene / revealFacts + gliding cursor + seeded data
        │
        ▼  Playwright:  demo (desktop 1920×1080)  ·  demo-mobile (Pixel 7)
   video.webm   (silent, captions/chips/cards burned in)
        │  scripts/demo/encode.mjs  (ffmpeg)
        ├── --master  one 1920×1080 film, built in a single pass → demo-clips/demo-master.mp4
        └── --hero    README loop cut from the Daten reveal → assets/demo-hero.webp
```

Captions, persona chips, and the data-reveal cards are real DOM, burned
into the recording by the overlay — one source, no `.srt` sidecar to sync.
The master is built in **one** ffmpeg pass (normalize every clip onto the
canvas, concat, encode once) — a single decode and a single high-quality
encode keep text crisp.

## Run

```bash
npm run demo          # record (desktop + mobile), build master, cut hero
npm run demo:record   # record only → test-results/<folder>/video.webm
npm run demo:encode   # build the single-pass 1920×1080 master
npm run demo:hero     # cut the README loop (assets/demo-hero.webp)
```

Recording is opt-in: the `demo` / `demo-mobile` Playwright projects exist only
when `PLAYWRIGHT_RUN_DEMO=1`, so a normal `npm run test:e2e` never picks them
up. Both projects depend on `setup`, which seeds the isolated e2e DB/bucket —
demos run against the realistic snapshot and never touch dev data.

Recordings render in **light** mode by default — the theme most users run. The
seeded users store `theme-preference: 'system'`, so the app follows
`prefers-color-scheme`, which both demo projects pin via `use.colorScheme`. To
record the dark theme instead, set `DEMO_COLOR_SCHEME=dark`:

```bash
DEMO_COLOR_SCHEME=dark npm run demo
```

Any value other than `light` / `dark` fails the run rather than silently
recording the wrong theme. Regenerate the committed hero/master after switching,
since both bake in whichever theme produced them.

The master lands at `demo-clips/demo-master.mp4` (1920×1080, faststart),
ready for the Vimeo upload — `demo-clips/` is gitignored and survives the
`test-results/` wipe each `demo:record` does, so the finished film isn't lost
on the next run. The hero is a quality-first
animated webp cut from the Daten reveal; its baked defaults reproduce the
committed `assets/demo-hero.webp`, and `--hero-static` emits a single crisp
frame instead. `node scripts/demo/encode.mjs` (no flag) transcodes each clip
to a sibling `demo.mp4` for review; `--reel` stitches same-resolution clips.

## Local-only photo fixtures

The site photos and the phone backdrop are Pixabay stock — free to use and
modify, but redistributing them standalone (as raw files in a public repo) is a
Prohibited Use under the Pixabay Content License. They're gitignored, not
committed: drop any equivalent landscape photo at each path before recording —
the demo doesn't depend on specific imagery.

| File                                     | Used by                                              |
| ---------------------------------------- | ---------------------------------------------------- |
| `e2e/fixtures/demo/site-1.jpg`           | `demo-04-field.mobile.spec.ts`                       |
| `e2e/fixtures/demo/site-2.jpg`           | `demo-03-dock.spec.ts`                               |
| `scripts/demo/assets/phone-backdrop.jpg` | `demo-00`/`demo-99` + `encode.mjs` (phone composite) |

The committed `assets/demo-hero.webp` stays in the repo — a composited film
loop is a derivative work, not standalone Content.

## Authoring a scenario

A demo is a normal Playwright spec named `demo-*.spec.ts`. Each scenario yields
both a desktop and a mobile clip — the two projects run every match.

```ts
import { test, expect } from '@playwright/test';
import { startDemo } from './demo-helpers';
import { STORAGE_STATES } from './storage-states';

test.use({ storageState: STORAGE_STATES.owner }); // or a fresh session to show login

test('Kanban-Überblick', async ({ page }) => {
  const demo = await startDemo(page); // BEFORE the first goto
  await page.goto('/');

  await demo.step('Anmeldung als Inhaber', async () => {
    await demo.type(page.getByTestId('login-username'), 'inhaber');
    await demo.click(page.getByTestId('login-submit'));
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });
});
```

- `startDemo(page)` injects the visible cursor, caption banner, persona chip,
  and reveal layer. Call it before the first navigation (`addInitScript` only
  applies to later loads).
- `demo.step(caption, fn, opts?)` shows the on-screen caption, holds, runs the
  action, holds again. The caption is the narration — write it in German.
  Tune pacing per step with `{ settleMs, holdMs }`.
- `demo.scene({ name, role, device })` flashes a self-dismissing top-left chip
  at a segment's start so a stitched film stays oriented. Call it once after the
  first load; it does not block the rest of the take.
- `demo.revealFacts({ title, subtitle, facts, close })` blurs the live app
  behind frosted glass and floats backend guarantees as fact cards (each a plain
  melody line + a technical bassline) — for the data segment, whose subject has
  no UI.
- Drive interactions through `demo.click / fill / type / moveTo` rather than raw
  locator calls: each glides the visible cursor to the target first, so pointer
  motion reads naturally instead of teleporting. Assertions stay on `page`/`expect`.
- Target `data-testid`s and the `clickView` helper in `nav-helpers.ts`; mobile
  (Pixel 7, below the 768 px breakpoint) renders the real mobile shell, so prefer
  testids over layout-specific selectors.

Keep each scenario short and single-purpose — several focused clips read better
than one long take, and `--reel` can stitch them when a single file is wanted.

Prerequisites: `ffmpeg` (provides `ffmpeg` + `ffprobe`) on PATH. Scenarios that
exercise LLM email extraction additionally need `OPENROUTER_API_KEY` in `.env`.
