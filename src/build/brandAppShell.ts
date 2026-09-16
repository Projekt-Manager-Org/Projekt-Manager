/**
 * Vite plugin: feed the app shell from the branding configuration
 * (AC-363).
 *
 * Two surfaces, one source. `index.html` carries placeholders this hook
 * substitutes, and `/manifest.webmanifest` is generated rather than
 * served out of `public/` — so nothing in the shell holds a second copy
 * of a value `brandingConfig.ts` already defines.
 *
 * Placeholder syntax is Vite's own `%KEY%` HTML-env form. Vite appends
 * its built-in env hook to the same `pre` list, and that hook returns
 * unknown keys untouched, warning only for keys starting with the env
 * prefix (`VITE_`). Neither of ours does, so the two cannot collide in
 * either order.
 *
 * Dev/build split: a middleware answers the request under `npm run
 * dev`, `generateBundle` emits the asset for `vite build`. Both call the
 * same generator, so the manifest a developer loads is the manifest
 * that ships. (`buildServiceWorker` in `vite.config.ts` splits the same
 * way but uses `closeBundle`, because esbuild writes that file itself
 * rather than handing bytes to Rollup.)
 *
 * Lives outside `vite.config.ts` so the hooks can be driven directly by
 * `src/config/__tests__/pwaManifest.test.ts`: the emit path is
 * hand-written, and a typo in `fileName` would ship an image whose PWA
 * is silently not installable. A test gated on `dist/` existing would
 * never catch that — CI builds in the `lint` job and tests in
 * `check-shard`, on separate runners with no artifact handoff.
 *
 * Import specifiers below carry explicit `.ts` extensions, unlike the
 * rest of `src/`. This module is in `vite.config.ts`'s own import
 * graph, and Vite's coming native config loader (Node type-stripping)
 * does no extension resolution — extensionless specifiers there become
 * a hard `ERR_MODULE_NOT_FOUND` at that bump.
 */
import type { Plugin } from 'vite';
import { BRANDING } from '../config/brandingConfig.ts';
import { buildPwaManifest } from '../config/pwaManifest.ts';
import type { BrandingConfig } from '../config/brandingConfig.ts';

/** Served path of the generated manifest; `index.html` links to it. */
const MANIFEST_FILENAME = 'manifest.webmanifest';

/**
 * Escape what would break out of an HTML text node or an attribute
 * value. These are build-time constants from source, not user input —
 * this keeps a branding string containing `&` or a quote from silently
 * corrupting the shell, it is not an injection boundary.
 *
 * `<title>` is RCDATA, so a browser decodes the entities back: the tab
 * and `document.title` show the original characters either way.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function brandAppShell(branding: BrandingConfig = BRANDING): Plugin {
  const render = () => `${JSON.stringify(buildPwaManifest(branding), null, 2)}\n`;

  return {
    name: 'brand-app-shell',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string) {
        return html
          .replaceAll('%APP_NAME%', escapeHtml(branding.appName))
          .replaceAll('%SHELL_THEME_COLOR%', escapeHtml(branding.shell.themeColor));
      },
    },
    configureServer(server) {
      server.middlewares.use(`/${MANIFEST_FILENAME}`, (req, res, next) => {
        // Connect strips the mount prefix, so the exact request arrives
        // as `/`. Anything deeper is not ours. A query string would
        // arrive as `/?…` and fall through — `<link rel="manifest">`
        // never sends one, and `/sw.js` above has the same shape.
        if (req.method !== 'GET' || req.url !== '/') return next();
        res.setHeader('content-type', 'application/manifest+json; charset=utf-8');
        res.setHeader('cache-control', 'no-cache');
        res.end(render());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: MANIFEST_FILENAME, source: render() });
    },
  };
}
