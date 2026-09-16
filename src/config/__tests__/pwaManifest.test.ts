/**
 * App shell identity (AC-363) — two layers.
 *
 * `buildPwaManifest` (src/config/pwaManifest.ts) is the manifest's one
 * source. The `brand-app-shell` plugin (src/build/brandAppShell.ts) is
 * what carries that output to the browser, and it is hand-written: a wrong emit
 * filename or a missed placeholder ships an image whose PWA is silently
 * not installable. The generator's contract is covered below, and the
 * plugin's two delivery hooks are driven directly — a test gated on
 * `dist/` existing would never run, because CI builds in the `lint` job
 * and tests in `check-shard`, on separate runners with no artifact
 * handoff.
 *
 * Not covered here: the dev middleware, and that the served document's
 * `<link rel="manifest">` resolves. Those need a running server and are
 * asserted in `e2e/insecure-banner.spec.ts`.
 *
 * Identity fields are asserted against `BRANDING`, never against string
 * literals. A literal here would re-create the duplication AC-363
 * removes — the test would keep passing for a renamed installation while
 * the tab, the home screen and the splash still said "Projekt-Manager".
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRANDING } from '../brandingConfig';
import { buildPwaManifest } from '../pwaManifest';
import { brandAppShell } from '../../build/brandAppShell';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '../../..');

describe('buildPwaManifest — AC-363 app shell identity', () => {
  it('takes every identity field from the branding configuration', () => {
    const m = buildPwaManifest(BRANDING);
    expect(m.name).toBe(BRANDING.appName);
    expect(m.short_name).toBe(BRANDING.shortName);
    expect(m.theme_color).toBe(BRANDING.shell.themeColor);
    expect(m.background_color).toBe(BRANDING.shell.backgroundColor);
  });

  it('follows the branding it is given rather than the shipped default', () => {
    // The real proof that nothing is hardcoded: feed a foreign identity
    // and watch all four fields move. Asserting only against the live
    // BRANDING (above) would still pass if the generator ignored its
    // argument and read the module-level constant directly.
    //
    // The two colors are the shipped pair swapped, not invented hex:
    // raw palette literals are barred outside the token source (AC-108),
    // and a swap discriminates exactly as well — a generator reading the
    // module constant returns them the right way round and fails.
    const m = buildPwaManifest({
      ...BRANDING,
      appName: 'Müller Bau',
      shortName: 'Müller',
      shell: {
        themeColor: BRANDING.shell.backgroundColor,
        backgroundColor: BRANDING.shell.themeColor,
      },
    });
    expect(m.name).toBe('Müller Bau');
    expect(m.short_name).toBe('Müller');
    expect(m.theme_color).toBe(BRANDING.shell.backgroundColor);
    expect(m.background_color).toBe(BRANDING.shell.themeColor);
  });

  it('carries the installability fields Chrome requires', () => {
    const m = buildPwaManifest(BRANDING);
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('standalone');
    // `lang` is not an installability field, but it was in the static
    // asset and the manifest is the only place it is declared for the
    // installed app. Pinned so deleting that file did not quietly drop
    // it.
    expect(m.lang).toBe('de');
    // The manifest spec takes CSS colors, but a deployment writing
    // `rebeccapurple` into these keys would be applying a token name to
    // a surface no stylesheet reaches. Hex is the contract.
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('declares 192 and 512 PNG icons and a maskable purpose', () => {
    const m = buildPwaManifest(BRANDING);
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(m.icons.every((i) => i.type === 'image/png')).toBe(true);
    const hasMaskable = m.icons.some((i) => i.purpose.split(/\s+/).includes('maskable'));
    expect(hasMaskable).toBe(true);
  });

  it('points at icon files that exist on disk', () => {
    // The icon set stays a set of files under `public/` — a deployment
    // replaces the two source SVGs and re-runs `npm run gen:pwa-icons`.
    // Nothing regenerates them at build time, so a manifest naming a
    // path that was never rasterized is a live failure mode.
    const m = buildPwaManifest(BRANDING);
    for (const icon of m.icons) {
      const abs = path.join(repoRoot, 'public', icon.src.replace(/^\//, ''));
      expect(existsSync(abs), `icon file missing: ${icon.src}`).toBe(true);
    }
  });

  it('leaves no static manifest under public/', () => {
    // Vite copies `public/` verbatim into `dist/`, so a re-introduced
    // static file would overwrite the emitted one and silently win —
    // with every assertion above still green, because they only ever
    // look at the generator.
    expect(existsSync(path.join(repoRoot, 'public/manifest.webmanifest'))).toBe(false);
  });
});

describe('brandAppShell plugin — AC-363 delivery', () => {
  it('emits the generator output at the path index.html links to', () => {
    const emitFile = vi.fn();
    const plugin = brandAppShell();
    // Rollup calls `generateBundle` with the plugin context as `this`.
    (plugin.generateBundle as (this: { emitFile: unknown }) => void).call({ emitFile });

    expect(emitFile).toHaveBeenCalledTimes(1);
    const emitted = emitFile.mock.calls[0][0] as { fileName: string; source: string };
    // The filename is what `<link rel="manifest" href="...">` resolves
    // against; a typo here is a 404 with no other symptom than a PWA
    // that will not install.
    expect(emitted.fileName).toBe('manifest.webmanifest');
    expect(readFileSync(path.join(repoRoot, 'index.html'), 'utf8')).toContain(
      `href="/${emitted.fileName}"`,
    );
    expect(JSON.parse(emitted.source)).toEqual(buildPwaManifest(BRANDING));
  });

  it('substitutes every shell placeholder in the real index.html', () => {
    const plugin = brandAppShell();
    const hook = plugin.transformIndexHtml as { handler: (html: string) => string };
    const source = readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
    const out = hook.handler(source);

    expect(out).toContain(`<title>${BRANDING.appName}</title>`);
    expect(out).toContain(`content="${BRANDING.shell.themeColor}"`);
    // Driven against the shipped index.html, not a fixture: a
    // placeholder added there and not here would otherwise reach the
    // browser verbatim. Also catches a placeholder token written into
    // index.html's own explanatory comment, which the replace would
    // rewrite — putting a second copy of the substituted value back
    // into the document this AC just removed it from.
    expect(out).not.toMatch(/%[A-Z_]+%/);
  });

  it('escapes markup-significant characters in a branding string', () => {
    // The shipped `appName` contains nothing that needs escaping, so
    // the case above cannot exercise the escape at all. A deployment
    // named "Müller & Söhne" would otherwise emit a bare `&` into the
    // document — and `-->` in a name would close index.html's comment
    // early, swallowing the head.
    const plugin = brandAppShell({ ...BRANDING, appName: 'Müller & Söhne <"1">' });
    const hook = plugin.transformIndexHtml as { handler: (html: string) => string };
    const out = hook.handler('<title>%APP_NAME%</title>');

    expect(out).toBe('<title>Müller &amp; Söhne &lt;&quot;1&quot;&gt;</title>');
  });
});
