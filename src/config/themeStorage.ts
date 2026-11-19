/*
 * Client-side theme preference cache.
 *
 * THEME_PREFERENCE_KEY is internal. public/theme-init.js (the pre-paint
 * script, which cannot import this module) and the e2e tests in
 * e2e/theming.spec.ts and e2e/theme-preference.spec.ts repeat it, so a
 * change updates them too.
 */

export const THEME_PREFERENCE_KEY = 'theme-preference';

export type ThemePreference = 'light' | 'dark' | 'system';

export type ResolvedTheme = 'light' | 'dark';
