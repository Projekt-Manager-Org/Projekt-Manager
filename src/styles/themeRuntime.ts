/*
 * Runtime theme subscription.
 *
 * The pre-paint script at public/theme-init.js handles the first paint.
 * Once the module graph boots, this runtime keeps the applied scheme in
 * sync with:
 *   - OS color-scheme changes, when preference is 'system' (AC-112).
 *   - Cross-tab updates to the preference via the storage event.
 *
 * On startup the runtime also re-applies the cached preference so the
 * module path is self-sufficient if the pre-paint script is ever blocked
 * (e.g., by a stricter CSP) or fails — then the theme still recovers on
 * the first module tick instead of waiting for a session hydration.
 *
 * public/theme-init.js is intentionally import-free; this module
 * duplicates a minimal resolver rather than sharing code.
 */

import {
  THEME_PREFERENCE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from '../config/themeStorage';

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

function readPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_PREFERENCE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // localStorage may throw in private-browsing or sandboxed contexts.
  }
  return 'system';
}

function resolveScheme(pref: ThemePreference, mql: MediaQueryList | null): ResolvedTheme {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return mql?.matches ? 'dark' : 'light';
}

function applyScheme(scheme: ResolvedTheme): void {
  if (scheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

/**
 * Resolve a theme preference to a concrete scheme and apply it to the
 * document root. Shared by the startup runtime below, the authStore's
 * `updateThemePreference` action, and the session-hydration path so all
 * three touch the same resolve/apply pair — public/theme-init.js is the
 * one deliberate duplicate (it has to stay import-free for the pre-JS
 * frame to work).
 *
 * Safe to call in non-browser contexts (SSR, tests without a DOM); it
 * no-ops when `window`/`document` are undefined.
 */
export function applyThemePreference(preference: ThemePreference): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_SCHEME_QUERY) : null;
  applyScheme(resolveScheme(preference, mql));
}

export function startThemeRuntime(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const mql = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_SCHEME_QUERY) : null;

  const reapply = (): void => {
    applyScheme(resolveScheme(readPreference(), mql));
  };

  // Defense in depth: if the pre-paint script did not run (CSP block,
  // 404, parse error, ...), the cached preference is still unapplied
  // when the module graph boots. Re-applying here keeps an
  // unauthenticated reload on the correct scheme instead of waiting for
  // a session hydration that never comes.
  reapply();

  if (mql) {
    // Only 'system' preference should react to OS changes; the resolver
    // handles that gating, so we can attach unconditionally.
    mql.addEventListener('change', reapply);
  }

  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === THEME_PREFERENCE_KEY || event.key === null) reapply();
  });
}
