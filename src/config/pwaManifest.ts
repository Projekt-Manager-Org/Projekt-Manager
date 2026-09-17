/**
 * PWA manifest source (AC-363).
 *
 * Built here rather than checked in at `public/manifest.webmanifest`, so
 * the installation's name and shell colors have one definition site —
 * `brandingConfig.ts` — instead of a copy the browser reads and nothing
 * keeps true. The `brand-app-shell` plugin (`src/build/brandAppShell.ts`)
 * is the only caller: it serves this object on `/manifest.webmanifest`
 * in dev and emits it into `dist/` at build.
 *
 * `branding` is a required parameter rather than a defaulted one: the
 * generator stays pure, and every caller says which branding it means.
 *
 * Everything that is NOT branding stays a literal here — routing
 * (`start_url`, `scope`), display mode, language, and the icon set.
 * Those are app structure, not per-deployment identity, and promoting
 * them to config would invent knobs no deployment has asked for.
 *
 * The import carries an explicit `.ts` extension — see ARCHITECTURE.md
 * § `src/build/`.
 */
import type { BrandingConfig } from './brandingConfig.ts';

export interface PwaManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

export interface PwaManifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  lang: string;
  icons: readonly PwaManifestIcon[];
}

/**
 * Icon set, rasterized from the two SVG sources under `public/` by
 * `npm run gen:pwa-icons` and committed. 192 and 512 are Chrome's
 * installability minimum; the maskable variant is the Android adaptive
 * icon (issue #123) and carries its own safe-zone padding in the SVG.
 */
const ICONS: readonly PwaManifestIcon[] = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

export function buildPwaManifest(branding: BrandingConfig): PwaManifest {
  return {
    name: branding.appName,
    short_name: branding.shortName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: branding.shell.themeColor,
    background_color: branding.shell.backgroundColor,
    // Matches `<html lang>` in index.html; when a second locale arrives,
    // both sites move together.
    lang: 'de',
    icons: ICONS,
  };
}
