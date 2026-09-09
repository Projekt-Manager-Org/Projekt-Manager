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
 *     (rendered inline as SVG by `src/ui/layout/Header.tsx`). The mark is
 *     a rounded square background with three vertical bars in the order
 *     given by `bars`. Theme-independent; the same hex values render in
 *     light and dark modes.
 *   - `mark.logo` is the installation's own logo and overrides the
 *     fallback wherever the mark is drawn. Unset in this repo: the
 *     pilot company's asset is private (ADR-0001), so the generic mark
 *     is what ships. A deployment sets it by dropping a file under
 *     `public/brand/` and pointing this key at the served path.
 *
 * Logo asset contract (`mark.logo`, issue #189):
 *   - Served path, e.g. `/brand/logo.png`. The file lives at
 *     `public/brand/logo.png`; Vite serves it from there in development
 *     and copies it into `dist/` for production. It MUST sit under
 *     `/brand/` — the invoice renderer resolves the same path on the
 *     filesystem (checking `dist/` then `public/`) and refuses anything
 *     that escapes that directory.
 *   - PNG or JPEG only. The header would take any format the browser
 *     renders, but the same bytes are embedded into the invoice PDF and
 *     `@cantoo/pdf-lib` supports exactly these two. One asset, both
 *     surfaces — a separate print variant can be added if the web mark
 *     ever needs to be vector.
 *   - Ship it at 3x the 32px header box (96x96 or larger) so the
 *     rasterised mark stays crisp; the PDF scales it into a 120x40pt
 *     box preserving aspect ratio.
 *   - A missing or unreadable file is a deployment misconfiguration,
 *     never a hard failure: the header falls back to the inline SVG and
 *     invoice issuance renders without a logo rather than aborting.
 */
export interface BrandingConfig {
  appName: string;
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
}

export const BRANDING: BrandingConfig = {
  appName: 'Projekt-Manager',
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
};
