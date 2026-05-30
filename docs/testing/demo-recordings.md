# Demo recordings

Scripted, re-runnable multimedia walkthroughs of the app. Playwright drives
the real UI and records video; the dev box encodes it. No phone, no screen
capture, no flaky recording app.

```
prose walkthrough (human-authored)
        │  translated into a spec
        ▼
demo-*.spec.ts ── demo.step(caption, fn) + gliding cursor + seeded data
        │
        ▼  Playwright:  demo (desktop 1400×1200)  ·  demo-mobile (Pixel 7)
   video.webm   (silent, captions burned in)
        │  scripts/demo/encode.mjs  (ffmpeg)
        ▼
   demo.mp4   (+ optional demo-reel-<WxH>.mp4)
```

Captions are burned into the video by the on-screen banner — one caption
source, no `.srt` sidecar to keep in sync.

## Run

```bash
npm run demo          # record (desktop + mobile) then encode to MP4
npm run demo:record   # record only → test-results/<folder>/video.webm
npm run demo:encode   # encode existing recordings; add -- --reel to stitch
```

Recording is opt-in: the `demo` / `demo-mobile` Playwright projects exist only
when `PLAYWRIGHT_RUN_DEMO=1`, so a normal `npm run test:e2e` never picks them
up. Both projects depend on `setup`, which seeds the isolated e2e DB/bucket —
demos run against the realistic snapshot and never touch dev data.

Output lands beside each recording in `test-results/<folder>/`: `demo.mp4`
(H.264, plays everywhere, captions burned in). `--reel` concatenates
same-resolution clips into `test-results/demo-reel-<WxH>.mp4`.

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

- `startDemo(page)` injects the visible cursor + caption banner. Call it before
  the first navigation (`addInitScript` only applies to later loads).
- `demo.step(caption, fn, opts?)` shows the on-screen caption, holds, runs the
  action, holds again. The caption is the narration — write it in German.
  Tune pacing per step with `{ settleMs, holdMs }`.
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
