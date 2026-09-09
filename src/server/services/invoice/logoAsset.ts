/**
 * Brand-logo byte source for the invoice renderer (issue #189).
 *
 * The logo is a deploy-time asset, not business data: `BRANDING.mark.logo`
 * names a served path, the browser loads it for the header, and this
 * module reads the same file off disk so the rendered PDF carries the
 * identical mark. One asset, two surfaces — no upload pipeline, no
 * descriptor row, no object storage (ADR-0001).
 *
 * "The same file" spans two roots by necessity: production serves `dist/`
 * via `@fastify/static`, while `npm run dev` serves `public/` through
 * Vite and builds no `dist/` at all. Whichever root the browser is being
 * served from is the one read here — see `candidatePaths` below.
 *
 * Every failure mode returns `null` instead of throwing. The caller is
 * inside the invoice issuance transaction, which holds the gapless
 * number-sequence lock: a missing or malformed branding file must not
 * be able to abort issuance. An invoice without a logo is a cosmetic
 * problem; a failed issuance is a business one.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BRANDING } from '../../../config/brandingConfig.js';
import { DIST_ROOT, PUBLIC_ROOT } from '../../staticRoot.js';

/**
 * Directory the asset must live in, relative to the build root. Pinned
 * rather than free-form so a config typo cannot turn into an arbitrary
 * file read: `BRANDING` is build-time input, but it is still the kind of
 * value that gets edited per deployment by whoever is holding the
 * keyboard that day.
 */
const BRAND_DIR = 'brand';

/**
 * Upper bound on the asset. A logo is a few tens of kilobytes; anything
 * past this is a mistake (a full-resolution photo, a wrong file) and
 * would bloat every issued PDF permanently, since issued bytes are
 * immutable under ADR-0026.
 */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * One-line warning, no stack. Every caller here is reporting a
 * deployment-configuration mistake, not an exceptional condition, and
 * this runs once per rendered invoice — a stack trace per render buries
 * the sentence that actually tells the operator what to fix.
 */
function warn(detail: string): void {
  console.warn(`[branding] ${detail} — logo omitted from rendered invoices.`);
}

export type LogoFormat = 'png' | 'jpg';

export interface LogoAsset {
  bytes: Uint8Array;
  format: LogoFormat;
}

/**
 * Format sniffed from magic bytes, not from the file extension — the
 * extension is a naming convention, the header is what `embedPng` /
 * `embedJpg` actually parse. Returns null for anything else, which is
 * how a `.png`-named WebP (a very easy mistake to make on export) gets
 * rejected here instead of throwing inside pdf-lib.
 */
function sniffFormat(bytes: Uint8Array): LogoFormat | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  return null;
}

/**
 * Resolve the configured web path against one static root, or null if it
 * does not name a file inside that root's brand directory. Rejects
 * absolute paths, parent-directory escapes, and anything that lands
 * outside `<root>/brand` after normalisation.
 */
function resolveUnder(root: string, configured: string): string | null {
  const brandRoot = path.join(root, BRAND_DIR);
  const relative = configured.replace(/^\/+/, '');
  if (!relative.startsWith(`${BRAND_DIR}/`)) return null;

  const resolved = path.resolve(root, relative);
  // `path.resolve` has already collapsed any `..`; confirm the result is
  // still under the brand directory rather than trusting the prefix
  // check above on its own.
  if (resolved !== brandRoot && !resolved.startsWith(`${brandRoot}${path.sep}`)) return null;
  return resolved;
}

/**
 * Candidate paths for the configured asset, in precedence order.
 *
 * `public/` first, `dist/` second — deliberately, because that ordering
 * makes both environments read what the browser is being served.
 *
 *   - Production: the runtime image carries `dist/` only (the Dockerfile
 *     copies `/app/dist` and nothing else), so `public/` misses and
 *     `dist/` — what `@fastify/static` serves — wins.
 *   - Development: `npm run dev` serves `public/` through Vite and
 *     builds no `dist/`. Probing `dist/` first would let a stale
 *     artifact from someone's earlier `npm run build` shadow the file
 *     Vite is actually serving, and those bytes would be frozen into an
 *     immutable issued PDF (ADR-0026). `start.ts` refuses to serve a
 *     stray `dist/` outside production for the same reason.
 *
 * Both roots are confined to their own `brand/` subdirectory
 * independently.
 */
function candidatePaths(configured: string): string[] {
  return [resolveUnder(PUBLIC_ROOT, configured), resolveUnder(DIST_ROOT, configured)].filter(
    (p): p is string => p !== null,
  );
}

/**
 * Read the configured brand logo, or null when none is configured or the
 * configured one is unusable. Warnings go to stderr: a deployment that
 * set the key and got no logo needs to find out, but not by having its
 * invoices fail.
 *
 * Deliberately uncached — issuance is a rare, human-paced operation, and
 * a cache here would need invalidation semantics that buy nothing.
 */
export function loadBrandLogo(): LogoAsset | null {
  const configured = BRANDING.mark.logo;
  if (!configured) return null;

  const candidates = candidatePaths(configured);
  if (candidates.length === 0) {
    warn(`BRANDING.mark.logo (${configured}) must be a path under /${BRAND_DIR}/`);
    return null;
  }

  for (const candidate of candidates) {
    let bytes: Uint8Array;
    try {
      const size = statSync(candidate).size;
      if (size > MAX_LOGO_BYTES) {
        warn(`${candidate} is ${size} bytes, over the ${MAX_LOGO_BYTES}-byte cap`);
        return null;
      }
      bytes = new Uint8Array(readFileSync(candidate));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Absent under this root — try the next one. Only the last miss
        // is worth reporting, and `warn` below does that once.
        continue;
      }
      // Present but unreadable (EACCES, EISDIR, ELOOP, …). Falling
      // through to the other root would embed bytes the browser is not
      // being served, and freeze them into an immutable PDF — the exact
      // divergence the two-root lookup exists to prevent.
      warn(`${candidate} could not be read (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`);
      return null;
    }

    const format = sniffFormat(bytes);
    if (!format) {
      warn(`${candidate} is neither PNG nor JPEG (@cantoo/pdf-lib embeds only these)`);
      return null;
    }
    return { bytes, format };
  }

  warn(`${configured} was not found under ${candidates.join(' or ')}`);
  return null;
}
