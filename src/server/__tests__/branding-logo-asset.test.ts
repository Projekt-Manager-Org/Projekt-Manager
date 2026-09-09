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
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BRANDING } from '../../config/brandingConfig.js';
import { DIST_ROOT, PUBLIC_ROOT } from '../staticRoot.js';
import { loadBrandLogo } from '../services/invoice/logoAsset.js';

const BRAND_DIR = path.join(DIST_ROOT, 'brand');

/** Minimal valid PNG signature + enough tail to look like a file. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0),
]);
/** JPEG SOI + APP0 marker. */
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0)]);
/** RIFF/WEBP — a plausible mistake, and one pdf-lib cannot embed. */
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);

const written: string[] = [];
// Only tear down directories this suite created. A developer with a real
// `dist/` from `npm run build` must get it back untouched.
const createdDirs: string[] = [];

function writeAsset(name: string, bytes: Buffer): void {
  const target = path.join(BRAND_DIR, name);
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
  if (!existsSync(DIST_ROOT)) createdDirs.push(DIST_ROOT);
  if (!existsSync(BRAND_DIR)) createdDirs.push(BRAND_DIR);
  mkdirSync(BRAND_DIR, { recursive: true });
  // A file OUTSIDE the brand dir, to prove traversal is refused on the
  // path shape rather than on the file happening not to exist.
  const outside = path.join(DIST_ROOT, 'escape-target.png');
  writeFileSync(outside, PNG_BYTES);
  written.push(outside);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const f of written) rmSync(f, { force: true });
  // Deepest first, so `dist/brand` goes before `dist`.
  for (const d of [...createdDirs].reverse()) rmSync(d, { recursive: true, force: true });
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
    configureLogo('/escape-target.png');
    expect(loadBrandLogo()).toBeNull();
  });

  it('refuses a traversal that resolves out of the brand directory', () => {
    configureLogo('/brand/../escape-target.png');
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

  it('falls back to public/ when dist/ has no copy — the development layout', () => {
    // `npm run dev` serves `public/` through Vite and never builds a
    // `dist/`, so a dist-only lookup would resolve in production and
    // nowhere else. The asset exists ONLY under public/ here.
    const publicBrand = path.join(PUBLIC_ROOT, 'brand');
    if (!existsSync(publicBrand)) createdDirs.push(publicBrand);
    mkdirSync(publicBrand, { recursive: true });
    const target = path.join(publicBrand, 'ac360-public-only.png');
    writeFileSync(target, PNG_BYTES);
    written.push(target);

    configureLogo('/brand/ac360-public-only.png');

    expect(loadBrandLogo()?.format).toBe('png');
  });

  it('does not let the public/ fallback rescue an asset that is present but invalid', () => {
    // Present-under-dist-but-broken is a hard stop, not a reason to keep
    // searching: silently serving a different file than the one the
    // browser loads would defeat the whole "one asset, two surfaces" point.
    writeAsset('ac360-both.png', WEBP_BYTES);
    const publicBrand = path.join(PUBLIC_ROOT, 'brand');
    if (!existsSync(publicBrand)) createdDirs.push(publicBrand);
    mkdirSync(publicBrand, { recursive: true });
    const shadow = path.join(publicBrand, 'ac360-both.png');
    writeFileSync(shadow, PNG_BYTES);
    written.push(shadow);

    configureLogo('/brand/ac360-both.png');

    expect(loadBrandLogo()).toBeNull();
  });
});
