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
 *   - Drop the file in `public/brand/` and set this key to its served
 *     path, leading slash included (`/brand/logo.png`). It must stay
 *     under that directory; the renderer refuses anything outside it.
 *     Confinement is lexical, so a symlink planted inside `brand/` is
 *     followed — the directory's write permissions are the real boundary.
 *   - PNG or JPEG. The same bytes feed the header and the invoice PDF,
 *     and the PDF engine embeds no other format.
 *   - Ship it 84px tall or more. The header paints it up to 28px tall,
 *     so 3x stays crisp on dense displays.
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
