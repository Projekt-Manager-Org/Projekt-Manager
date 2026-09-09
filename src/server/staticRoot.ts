/**
 * Single source of truth for the built-frontend root on disk.
 *
 * Two consumers resolve the same directory for different reasons:
 *   - `start.ts` hands it to `registerStaticAssets` so `@fastify/static`
 *     serves the SPA and its assets.
 *   - `services/invoice/logoAsset.ts` reads the configured brand logo
 *     out of it at render time, so the header and the invoice PDF are
 *     fed by the exact same file.
 *
 * Resolution deliberately lives in ONE module because `import.meta.url`
 * behaves differently either side of the build. `build:server` bundles
 * every server module into `dist/server/start.js`, so at runtime this
 * resolves from `dist/server` regardless of which source file the code
 * originally came from; under `tsx` / vitest the modules stay separate
 * and it resolves from `src/server`. Both land on the repo/app-root
 * `dist` only because this file sits directly under `src/server` — the
 * same depth the bundle output has. Moving it deeper would silently
 * break the unbundled path (the sibling `invoice/xsd` lookup in
 * `xsdValidator.ts` leans on the same property).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the Vite build output (`dist/`). */
export const DIST_ROOT = path.resolve(__dirname, '../../dist');

/**
 * Absolute path to Vite's `public/` source directory.
 *
 * Only interesting in development. `npm run dev` serves static files from
 * `public/` through the Vite dev server and never produces a `dist/`, so a
 * server-side reader that looked only at `DIST_ROOT` would find nothing
 * locally and everything in production — the worst kind of divergence,
 * since the broken half is the one nobody runs the tests against. Readers
 * check `DIST_ROOT` first (authoritative in production, where this path
 * is not even copied into the runtime image) and fall back to here.
 */
export const PUBLIC_ROOT = path.resolve(__dirname, '../../public');
