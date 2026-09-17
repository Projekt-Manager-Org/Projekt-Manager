/**
 * Branding configuration — customer-specific per ADR-0001.
 * Each installation overrides these values for their company.
 *
 * Raw color literals are permitted ONLY in this file (it is on the
 * AC-108 allowlist alongside `tokens.css` and `stateConfig.ts`).
 *
 * Brand accent contract ([C] in spec §12.2 / §12.5):
 *   - `accent.light` and `accent.dark` are the brand accent for light and
 *     dark themes respectively — both keys are required, no auto-derivation
 *     (clarity over cleverness, per #101).
 *   - These values are injected into the CSS custom properties
 *     `--brand-accent-light` and `--brand-accent-dark` at boot by
 *     `src/styles/applyBranding.ts`. No other module consumes these raw
 *     hex strings; stylesheets reference the semantic `--color-accent`
 *     token chain instead.
 *   - Each value MUST meet WCAG AA against both `--color-surface-base`
 *     (the body background it sits on in borders/focus-rings) and
 *     `--color-text-on-accent` (the label text on filled accent
 *     surfaces) in its respective mode. The defaults below pair with
 *     `--color-text-on-accent: slate-900` and give 4.97:1 (light) and
 *     7.31:1 (dark) — do not regress without re-checking contrast.
 *
 * Brand mark contract:
 *   - `mark.bg` and `mark.bars` paint the generic fallback mark
 *     (rendered inline as SVG by `src/ui/layout/BrandMark.tsx`). The mark
 *     is a rounded square background with three vertical bars in the order
 *     given by `bars`. Theme-independent; the same hex values render in
 *     light and dark modes.
 *   - `mark.logo` is the installation's own logo and overrides the
 *     fallback wherever the mark is drawn. Unset in this repo: the
 *     pilot company's asset is private (ADR-0001), so the generic mark
 *     is what ships.
 *
 * Supplying `mark.logo` (issue #189). Its behaviour — resolution,
 * refusal, and both render surfaces — is specified by AC-360 / AC-361 /
 * AC-362 in `docs/spec/verification.md`; what an operator provides:
 *   - Drop the file in `public/brand/`, COMMIT IT, and set this key to
 *     its served path, leading slash included (`/brand/logo.png`). The
 *     asset ships the same way `public/favicon.svg` and `public/icons/`
 *     do: CI builds the container image from the git checkout, `vite
 *     build` copies `public/` into `dist/`, and the image carries
 *     `dist/` alone. An untracked asset therefore works under
 *     `npm run dev` and reaches no deployed instance — the header falls
 *     back to the generic mark and every invoice render warns.
 *   - It must stay under `public/brand/`; the renderer refuses anything
 *     outside it. Confinement is lexical, so a symlink planted inside
 *     `brand/` is followed — the directory's write permissions are the
 *     real boundary.
 *   - PNG or JPEG. The same bytes feed the header and the invoice PDF,
 *     and the PDF engine embeds no other format.
 *   - Ship it 84px tall or more. The header paints it up to 28px tall,
 *     so 3x stays crisp on dense displays.
 *
 * Favicon and PWA icons (issue #408). Not config — files, and a
 * separate asset from `mark.logo`: square marks rather than a wide
 * header strip. A deployment replaces the two SVG sources and
 * regenerates the PNG set:
 *   - `public/favicon.svg` — the browser-tab mark, also the source for
 *     `icon-192.png` / `icon-512.png` and the push notification's icon.
 *   - `public/favicon-maskable.svg` — the Android adaptive icon. Its
 *     `viewBox` pads the artwork on every side so the launcher may crop
 *     to a circle, a squircle or a rounded square without clipping it.
 *     Keep that padding: a maskable icon drawn edge to edge loses its
 *     corners on most Android launchers.
 *   - `npm run gen:pwa-icons` rasterizes both into `public/icons/`.
 *     Commit the PNGs — nothing regenerates them at build time.
 */
export interface BrandingConfig {
  appName: string;
  /**
   * Home-screen label of the installed PWA (`short_name` in the
   * manifest). Separate from `appName` because launchers truncate:
   * Android shows roughly 12 characters under the icon, so this is the
   * name that has to survive on its own.
   */
  shortName: string;
  /**
   * Brand line in the application's own footer (`src/ui/layout/Footer.tsx`).
   *
   * NOT to be confused with `company_profile.footerText`, which is
   * owner-editable German prose printed at the foot of every rendered
   * invoice (data-model.md §5.17). Different surface, different
   * lifecycle, different editor — deliberately named apart so a grep
   * for either lands on one of them only.
   */
  footerBrandLine: string;
  accent: {
    light: string;
    dark: string;
  };
  mark: {
    bg: string;
    bars: readonly [string, string, string];
    logo?: string;
  };
  /**
   * App-shell chrome, consumed only by the generated PWA manifest and
   * the `theme-color` meta the same build step injects into
   * `index.html` (AC-363). Deliberately NOT the brand accent: that one
   * is a light/dark pair under a contrast contract, these are single
   * values on surfaces the browser paints outside the document, where
   * no stylesheet and no theme attribute reaches.
   */
  shell: {
    /** Browser and installed-app chrome (address bar, task switcher). */
    themeColor: string;
    /** Splash background behind the icon, before the app's first paint. */
    backgroundColor: string;
  };
}

export const BRANDING: BrandingConfig = {
  appName: 'Projekt-Manager',
  shortName: 'Projekte',
  footerBrandLine: 'Projekt-Manager',
  accent: {
    light: '#3b82f6', // tailwind blue-500 — 4.97:1 against slate-900
    dark: '#60a5fa', //  tailwind blue-400 — 7.31:1 against slate-900
  },
  mark: {
    bg: '#1e293b', // slate-800
    bars: [
      '#f97316', // orange-500
      '#3b82f6', // blue-500
      '#22c55e', // green-500
    ],
    // logo: '/brand/logo.png',  <- a deployment sets this; see the contract above.
  },
  shell: {
    themeColor: '#1e293b', // slate-800 — matches the generic mark's background
    backgroundColor: '#f8fafc', // slate-50 — the light theme's surface base
  },
};
