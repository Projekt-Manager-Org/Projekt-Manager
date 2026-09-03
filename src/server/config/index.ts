/**
 * Centralized server configuration constants.
 *
 * All policy-level values that were previously scattered across route handlers
 * and service modules live here. Environment-dependent values are resolved
 * via getEnv() at call time — never from process.env at import time, because
 * that bypass let ALLOW_INSECURE_HTTP and NODE_ENV be read from the raw env
 * even after env.ts validated a different value (consolidation review C-3).
 */

import { getEnv } from './env.js';

// --- Authentication & Sessions -----------------------------------------------

// Session duration is the single source of truth — cookieMaxAgeSec
// derives from it, so the cookie Max-Age and the server-side session
// expiry cannot drift apart silently. Before this change the two values
// were hand-synchronized with a "must match" comment, which is exactly
// the kind of invariant that breaks during a routine refactor.
// See consolidation review F F-4 / round-2 F M-3.
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours [C]

export const AUTH_CONFIG = {
  /** How long a session cookie stays valid (canonical). */
  sessionDurationMs: SESSION_DURATION_MS,

  /**
   * Cookie maxAge in seconds — derived from sessionDurationMs so the
   * browser-side cookie lifetime and the server-side session row expiry
   * always match. Asserted in src/server/__tests__/auth.test.ts.
   */
  cookieMaxAgeSec: SESSION_DURATION_MS / 1000,

  /**
   * Pre-computed bcrypt hash used to equalise timing when user is not found.
   * The actual plaintext is irrelevant — we only need bcrypt to burn the same
   * CPU time as a real comparison.
   */
  dummyHash: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
} as const;

/**
 * Whether to set the `Secure` flag on session cookies.
 *
 * Production with real TLS → true. Explicit HTTP evaluation mode
 * (ALLOW_INSECURE_HTTP=true, see ADR-0013) → false. Development → false.
 *
 * Reads from the validated env (env.ts) — requires validateEnvRuntime()
 * to have been called first (start.ts does this before buildApp()). Tests
 * use startApp() in api-helpers.ts which also calls validateEnvRuntime().
 */
export function getCookieSecure(): boolean {
  const env = getEnv();
  return env.NODE_ENV === 'production' && env.ALLOW_INSECURE_HTTP !== 'true';
}

// --- Rate Limiting -----------------------------------------------------------

/**
 * Rate limits.
 *
 * Returned by a function (not a module-level const) so the env read
 * happens at call time — consistent with getCookieSecure() and the
 * file-level rule that process.env is never read at import time.
 *
 * Login limit default is environment-aware:
 *   - production (NODE_ENV=production): 5/min — tight anti-spraying guard.
 *   - dev/test: 30/min — Playwright E2E and manual dev flows log in
 *     with many fresh browser contexts; 5/min throttles the suite.
 * `LOGIN_RATE_LIMIT_MAX` overrides both, for operators that want a
 * different floor or ceiling without rebuilding.
 *
 * Reads the override and NODE_ENV via `getEnv()` — the schema validates
 * `LOGIN_RATE_LIMIT_MAX` as a positive integer or unset, so an invalid
 * value crashes the app at boot rather than silently falling back to the
 * default (a misconfigured ceiling is an operator-facing fault, not a
 * runtime fallback). NODE_ENV defaults to 'production' in the schema so
 * a missing var still gets the tighter anti-spraying ceiling.
 */
export function getRateLimit() {
  const env = getEnv();
  const defaultMax = env.NODE_ENV === 'production' ? 5 : 30;
  const loginRateMax = env.LOGIN_RATE_LIMIT_MAX ?? defaultMax;
  return {
    /** Login endpoint. */
    login: { max: loginRateMax, timeWindow: '1 minute' as const },

    /** Password change endpoint. */
    passwordChange: { max: 5, timeWindow: '1 minute' as const },

    /**
     * Push subscription mutations (POST / DELETE). Enough headroom for
     * normal browser behaviour (re-subscribe on rotation, a handful of
     * devices) without allowing bulk enumeration.
     */
    subscriptionMutate: { max: 20, timeWindow: '1 minute' as const },
  };
}

// --- Storage -----------------------------------------------------------------

export const STORAGE_CONFIG = {
  /**
   * Allowed pattern for object storage keys (prevents path traversal).
   * Allowed: alphanumeric, `/`, `_`, `.`, `-`, length 1–1024.
   * Additional structural rules (no `..` sequences, no leading `/` or `.`)
   * are enforced by `validateKey()` in `server/storage/client.ts`.
   * Single source of truth — do not inline this regex elsewhere; import
   * it from here so the key-safety rule cannot drift between call sites.
   */
  validKeyPattern: /^[a-zA-Z0-9/_.-]{1,1024}$/,

  /** Minimum signed URL expiry in seconds. */
  minSignedUrlExpirySec: 1,

  /** Maximum signed URL expiry in seconds. */
  maxSignedUrlExpirySec: 3600,

  /**
   * Bucket-orphan prune cadence, in minutes (issue #169). Daily:
   * an orphan is inert — it costs bucket space and nothing else — so
   * nothing is gained by sweeping more often. Env override:
   * `STORAGE_PRUNE_INTERVAL_MINUTES`.
   */
  pruneIntervalMinutes: 1440,

  /**
   * Minimum object age, in minutes, before the prune will hide it.
   * Shields the two writers that PUT bytes before inserting their row
   * (invoice renderer, takeout import) — see
   * `server/storage/pruneBucketOrphans.ts`. 24 h is orders of magnitude
   * beyond either window, and waiting costs nothing. Env override:
   * `STORAGE_PRUNE_MIN_AGE_MINUTES`.
   */
  pruneMinAgeMinutes: 1440,
} as const;
