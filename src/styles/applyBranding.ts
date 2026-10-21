/*
 * Brand accent injection.
 *
 * Reads the `[C]` brand accent from `src/config/brandingConfig.ts` and
 * writes it to the document root as two CSS custom properties:
 *   --brand-accent-light
 *   --brand-accent-dark
 *
 * The semantic accent chain (--color-accent, --color-accent-hover,
 * --color-accent-active-surface, --color-focus-ring) resolves through
 * these at runtime, with fallback defaults declared in tokens.css for
 * the pre-JS frame (see §12.5 of the architecture spec).
 *
 * Call this BEFORE `startThemeRuntime()` in `src/main.tsx`: the theme
 * cascade then resolves against an already-populated brand accent on
 * the same frame. The pre-paint theme script (public/theme-init.js)
 * deliberately does NOT touch the brand accent — it runs before
 * modules load and would have no access to BRANDING. The tokens.css
 * fallback covers the sub-frame gap.
 *
 * Limitation: a deployment with a NON-default accent sees a single-
 * frame flash of the default accent before `applyBranding()` fires. A
 * build-time substitution into index.html would close this gap; it's
 * not done today because the flash is one frame on a non-theme-critical
 * surface (buttons, focus ring) and is invisible on the default-brand
 * config that this repo ships.
 */

import { BRANDING } from '../config/brandingConfig';

// Stylesheet id used to find and replace the brand sheet on subsequent
// calls (e.g. HMR or test re-mounts). Keeping a single owned <style>
// element avoids accumulating duplicates.
const BRAND_STYLE_ID = 'brand-accent';

export function applyBranding(): void {
  // SSR / non-browser safety. The app is CSR-only today, but the guard is
  // cheap and keeps the module import-safe in test runners that stub the
  // DOM after module load.
  if (typeof document === 'undefined') return;
  const head = document.head;
  if (!head) return;

  // Inject as a CSS rule (not inline style on <html>) so the cascade
  // composes normally — later <style> tags injected by tests, themes,
  // or build-time substitution can override the brand without fighting
  // inline-style specificity. Property names --brand-accent-light /
  // --brand-accent-dark are specified by AC-114.
  const css = `:root {
  --brand-accent-light: ${BRANDING.accent.light};
  --brand-accent-dark: ${BRANDING.accent.dark};
}`;

  let sheet = document.getElementById(BRAND_STYLE_ID) as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = BRAND_STYLE_ID;
    head.appendChild(sheet);
  }
  sheet.textContent = css;
}
