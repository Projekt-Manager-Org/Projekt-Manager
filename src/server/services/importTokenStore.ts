/**
 * Short-lived import-token store for the binary-leg post-session-invalidation
 * resume path (issue #230 fixup).
 *
 * Context
 * -------
 * The Layer 1 import envelope expanded to include `users`. When an operator
 * commits an override-import into a non-empty target, the `users` TRUNCATE
 * cascades through `sessions.user_id ON DELETE CASCADE` and evaporates the
 * operator's session mid-flow. The binary leg (per-attachment init / PUT /
 * complete) then 401s because the session it relied on is gone.
 *
 * Mechanism
 * ---------
 * The text-leg response carries a short-lived bearer token alongside
 * `sessionInvalidated: true`. The orchestrator forwards the token via
 * `Authorization: Bearer <token>` on every binary-leg call. Attachment
 * endpoints used by the binary leg accept the token as an alternative to
 * session-cookie auth (see `createAuthMiddlewareWithImportToken`).
 *
 * Storage model
 * -------------
 * In-memory `Map`, process-local, keyed by token. The VPS is a single-
 * instance deployment (no horizontal scale, no shared cache), so process-
 * local storage is sufficient. A backup-runner restart mid-import drops
 * every live token — the operator re-imports from the orchestrator. This
 * is a deliberate tradeoff against adding a DB table for a credential
 * with a five-minute lifetime.
 *
 * Security shape
 * --------------
 * - 32 bytes of `crypto.randomBytes`, base64url-encoded (~43 chars).
 * - Fixed TTL = 5 minutes. Multi-use within TTL (N init + N complete +
 *   possibly DELETE-rollback calls per import; single-use would break the
 *   flow).
 * - Permission set is enumerated per token (not a generic owner
 *   credential): `attachment:write` and `attachment:hide`.
 * - Tied to operator identity via `userId` so the request can attribute
 *   audit writes correctly post-TRUNCATE (the envelope round-trips the
 *   operator's row; the same id resolves on the imported user).
 * - Expiry-only validity; no rotation, no refresh. Explicit revoke
 *   supported for completeness (`revokeImportToken`).
 *
 * Lazy GC: expired entries get pruned inline on every `verifyImportToken`
 * traversal. No background sweeper — the map is bounded by the import
 * cadence (a handful of tokens per operator-session at peak).
 */

import { randomBytes } from 'node:crypto';
import type { Permission } from '../../config/permissions.js';

export const IMPORT_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Permission set granted to the import-token bearer credential. Exactly
 * what the binary leg needs:
 *   - `attachment:write` — init + complete
 *   - `attachment:hide`  — rollback DELETE
 *   - `data:restore`     — the restore-mode init AND-gate (AC-255) on
 *                          `POST /api/projects/:id/attachments/init`
 *                          when the body carries a `restore` block;
 *                          satisfied at the service layer via
 *                          `request.importTokenPermissions` so the
 *                          token's scope bounds the credential
 *                          end-to-end (not the operator's full role
 *                          set).
 *
 * Pinned here because both the mint site (`ImportService.import`) and
 * the test suite (`import-token.test.ts`) reference the exact same set;
 * drift would let the binary-leg orchestrator hold a token that 403s on
 * its own endpoint.
 */
export const IMPORT_TOKEN_PERMISSIONS: readonly Permission[] = [
  'attachment:write',
  'attachment:hide',
  'data:restore',
];

export interface ImportTokenRecord {
  userId: string;
  permissions: readonly Permission[];
  expiresAt: Date;
}

const STORE = new Map<string, ImportTokenRecord>();

/**
 * Mint a fresh token. Stores `{userId, permissions, expiresAt: now+5min}`
 * keyed by the token and returns the token string. Evicts every prior
 * live token for the same `userId` — the single-operator topology only
 * supports one import at a time, so leftover tokens from an
 * abandoned/failed run would be a dangling credential the TTL alone
 * carries for up to 5 min.
 */
export function mintImportToken(userId: string, permissions: readonly Permission[]): string {
  for (const [key, value] of STORE.entries()) {
    if (value.userId === userId) STORE.delete(key);
  }
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + IMPORT_TOKEN_TTL_MS);
  STORE.set(token, { userId, permissions, expiresAt });
  return token;
}

/**
 * Return the record if the token exists AND `expiresAt > now`. Returns
 * `null` otherwise. Prunes any expired entries observed during the lookup
 * so the map cannot grow unboundedly across a long-running process.
 */
export function verifyImportToken(token: string): ImportTokenRecord | null {
  // Inline GC: expired entries get evicted as we encounter them. Bounded
  // by the active-token set so the constant-factor overhead is small
  // compared to a per-request background sweeper.
  const now = Date.now();
  const record = STORE.get(token);
  if (record && record.expiresAt.getTime() <= now) {
    STORE.delete(token);
    return null;
  }
  // Opportunistic sweep: prune other expired entries to bound memory.
  // O(n) over the live set; n stays small (per-operator-session cadence).
  for (const [key, value] of STORE.entries()) {
    if (value.expiresAt.getTime() <= now) STORE.delete(key);
  }
  return record ?? null;
}

/**
 * Explicit revoke. No-op if absent. The import orchestrator does not call
 * this today — the TTL is the primary bound — but the function exists so
 * a future completion-signal can shorten the credential's lifetime.
 */
export function revokeImportToken(token: string): void {
  STORE.delete(token);
}

/**
 * Test-only seam — wipes the map so tests don't leak tokens across cases.
 * Production code MUST NOT call this; the underscore prefix signals
 * private/test surface to readers.
 */
export function _resetImportTokenStoreForTests(): void {
  STORE.clear();
}
