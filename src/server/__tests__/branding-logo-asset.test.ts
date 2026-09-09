/**
 * Unit tests — brand-logo asset resolution (issue #189, AC-360).
 *
 * `loadBrandLogo` is the only thing standing between a per-deployment
 * config string and a file read inside the invoice-issuance transaction,
 * so the interesting cases are all refusals: paths that escape the brand
 * directory, files whose bytes are not what the extension claims, and
 * assets large enough to bloat every permanently-immutable issued PDF.
 * Every refusal must be a `null`, never a throw — issuance holds the
 * gapless number-sequence lock while this runs.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BRANDING } from '../../config/brandingConfig.js';
import { DIST_ROOT, PUBLIC_ROOT } from '../staticRoot.js';
import { loadBrandLogo } from '../services/invoice/logoAsset.js';

const BRAND_DIR = path.join(DIST_ROOT, 'brand');
const PUBLIC_BRAND_DIR = path.join(PUBLIC_ROOT, 'brand');
/** Outside the brand dir on purpose — the traversal arms aim at it. */
const ESCAPE_TARGET = path.join(DIST_ROOT, 'ac360-escape-target.png');

/** Minimal valid PNG signature + enough tail to look like a file. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0),
]);
/** JPEG SOI + APP0 marker. */
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0)]);
/** RIFF/WEBP — a plausible mistake, and one pdf-lib cannot embed. */
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);

// Files only — never directories. `dist/`, `dist/brand/` and
// `public/brand/` are shared with `branding-invoice-render.test.ts`,
// which the integration project runs in a sibling worker: a suite that
// recursively removed a directory it happened to create first would
// delete the other suite's fixtures mid-run. On CI the test job never
// builds, so neither directory pre-exists and that race is the normal
// case. Every fixture name here is `ac360-`-prefixed, so file-level
// teardown is collision-free; an empty directory left behind under a
// gitignored build root is the cheap half of the trade.
const written: string[] = [];

function writeAsset(name: string, bytes: Buffer): void {
  const target = path.join(BRAND_DIR, name);
  writeFileSync(target, bytes);
  written.push(target);
}

function writePublicAsset(name: string, bytes: Buffer): void {
  mkdirSync(PUBLIC_BRAND_DIR, { recursive: true });
  const target = path.join(PUBLIC_BRAND_DIR, name);
  writeFileSync(target, bytes);
  written.push(target);
}

// Snapshot before any spy is installed: reading `BRANDING.mark` inside
// `configureLogo` would go through the spy that call just created, which
// has no return value yet.
const ORIGINAL_MARK = { ...BRANDING.mark };

function configureLogo(value: string | undefined): void {
  vi.spyOn(BRANDING, 'mark', 'get').mockReturnValue({ ...ORIGINAL_MARK, logo: value });
}

beforeAll(() => {
  mkdirSync(BRAND_DIR, { recursive: true });
  // A file OUTSIDE the brand dir, to prove traversal is refused on the
  // path shape rather than on the file happening not to exist.
  writeFileSync(ESCAPE_TARGET, PNG_BYTES);
  written.push(ESCAPE_TARGET);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const f of written) rmSync(f, { force: true });
});

describe('loadBrandLogo — AC-360 brand logo asset', () => {
  it('returns null when no logo is configured (the default install)', () => {
    configureLogo(undefined);
    expect(loadBrandLogo()).toBeNull();
  });

  it('loads a PNG under /brand/ and reports its sniffed format', () => {
    writeAsset('ac360-logo.png', PNG_BYTES);
    configureLogo('/brand/ac360-logo.png');

    const asset = loadBrandLogo();
    expect(asset).not.toBeNull();
    expect(asset!.format).toBe('png');
    expect(asset!.bytes.length).toBe(PNG_BYTES.length);
  });

  it('loads a JPEG under /brand/', () => {
    writeAsset('ac360-logo.jpg', JPEG_BYTES);
    configureLogo('/brand/ac360-logo.jpg');

    expect(loadBrandLogo()?.format).toBe('jpg');
  });

  it('sniffs the bytes, not the extension — a WebP named .png is refused', () => {
    writeAsset('ac360-liar.png', WEBP_BYTES);
    configureLogo('/brand/ac360-liar.png');

    // pdf-lib embeds PNG and JPEG only; letting this through would throw
    // inside the issuance transaction instead of degrading here.
    expect(loadBrandLogo()).toBeNull();
  });

  it('refuses a path outside the brand directory', () => {
    configureLogo('/ac360-escape-target.png');
    expect(loadBrandLogo()).toBeNull();
  });

  it('refuses a traversal that resolves out of the brand directory', () => {
    configureLogo('/brand/../ac360-escape-target.png');
    expect(loadBrandLogo()).toBeNull();
  });

  it('refuses an asset over the size cap', () => {
    const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(2 * 1024 * 1024)]);
    writeAsset('ac360-huge.png', oversized);
    configureLogo('/brand/ac360-huge.png');

    expect(loadBrandLogo()).toBeNull();
  });

  it('returns null rather than throwing when the file is missing', () => {
    configureLogo('/brand/ac360-does-not-exist.png');
    expect(() => loadBrandLogo()).not.toThrow();
    expect(loadBrandLogo()).toBeNull();
  });

  it('resolves under dist/ when public/ has no copy — the production layout', () => {
    // The runtime image carries `dist/` only; `@fastify/static` serves
    // it, and this is the root the browser is being fed from there.
    writeAsset('ac360-dist-only.png', PNG_BYTES);
    configureLogo('/brand/ac360-dist-only.png');

    expect(loadBrandLogo()?.format).toBe('png');
  });

  it('resolves under public/ when dist/ has no copy — the development layout', () => {
    // `npm run dev` serves `public/` through Vite and never builds a
    // `dist/`, so a dist-only lookup would resolve in production and
    // nowhere else. The asset exists ONLY under public/ here.
    writePublicAsset('ac360-public-only.png', PNG_BYTES);
    configureLogo('/brand/ac360-public-only.png');

    expect(loadBrandLogo()?.format).toBe('png');
  });

  it('lets public/ win over a stale dist/ copy — the file Vite serves is the file embedded', () => {
    // A leftover `npm run build` artifact must not shadow the asset the
    // dev server is actually serving: the browser would show one mark
    // and the PDF would carry another, permanently (ADR-0026). Distinct
    // formats make it unambiguous which root answered.
    writeAsset('ac360-both.png', JPEG_BYTES);
    writePublicAsset('ac360-both.png', PNG_BYTES);

    configureLogo('/brand/ac360-both.png');

    expect(loadBrandLogo()?.format).toBe('png');
  });

  it('treats a present-but-invalid asset as a hard stop, not a reason to keep searching', () => {
    // Falling through to the other root would silently embed a different
    // file than the browser loads — exactly the divergence the two-root
    // lookup exists to prevent.
    writePublicAsset('ac360-broken.png', WEBP_BYTES);
    writeAsset('ac360-broken.png', PNG_BYTES);

    configureLogo('/brand/ac360-broken.png');

    expect(loadBrandLogo()).toBeNull();
  });
});
