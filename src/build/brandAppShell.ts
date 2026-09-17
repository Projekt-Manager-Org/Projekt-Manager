/**
 * Vite plugin: feed the app shell from the branding configuration
 * (AC-363).
 *
 * Two surfaces, one source. `index.html` carries placeholders this hook
 * substitutes, and `/manifest.webmanifest` is generated rather than
 * served out of `public/` — so nothing in the shell holds a second copy
 * of a value `brandingConfig.ts` already defines.
 *
 * Placeholder syntax is Vite's own `%KEY%` HTML-env form. Vite's
 * built-in env hook shares the same `pre` list but returns unknown keys
 * untouched, so the two cannot collide in either order.
 *
 * Dev/build split: a middleware answers the request under `npm run
 * dev`, `generateBundle` emits the asset for `vite build`. Both call the
 * same generator, so the manifest a developer loads is the one that
 * ships.
 *
 * Lives outside `vite.config.ts` so both hooks can be driven directly by
 * `src/config/__tests__/pwaManifest.test.ts`. Import specifiers carry
 * explicit `.ts` extensions — see ARCHITECTURE.md § `src/build/`.
 */
import type { Plugin } from 'vite';
import { BRANDING } from '../config/brandingConfig.ts';
import { buildPwaManifest } from '../config/pwaManifest.ts';
import type { BrandingConfig } from '../config/brandingConfig.ts';

/** Served path of the generated manifest; `index.html` links to it. */
const MANIFEST_FILENAME = 'manifest.webmanifest';

export function brandAppShell(branding: BrandingConfig = BRANDING): Plugin {
  const render = () => `${JSON.stringify(buildPwaManifest(branding), null, 2)}\n`;

  return {
    name: 'brand-app-shell',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string) {
        return html
          .replaceAll('%APP_NAME%', branding.appName)
          .replaceAll('%SHELL_THEME_COLOR%', branding.shell.themeColor);
      },
    },
    configureServer(server) {
      server.middlewares.use(`/${MANIFEST_FILENAME}`, (req, res, next) => {
        // Connect strips the mount prefix, so the exact request arrives
        // as `/`. Anything deeper, or carrying a query string, is not
        // ours — `<link rel="manifest">` never sends one.
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
