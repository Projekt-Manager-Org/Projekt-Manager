/// <reference types="vite/client" />

/**
 * Build-time git short-SHA baked in by `vite.config.ts`'s `define`.
 * Empty string when no git context is available (shallow CI checkout,
 * container build without `.git`). Always exactly the 7-char short form
 * — vite truncates before inlining.
 */
declare const __APP_GIT_SHA__: string;
