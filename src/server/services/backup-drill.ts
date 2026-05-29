/**
 * Layer 2 drill service — Tier 2 verify-on-cycle.
 *
 * Implements verification.md §15.22 AC-168. Downloads the latest
 * encrypted dump + manifest, decrypts with the operator-loaded tmpfs
 * identity, restores into an ephemeral Postgres, and compares the
 * restore-side manifest against the sidecar manifest.
 *
 * AC-168 contract (the test-pinned slice):
 *   - When `identityPath` does not exist OR the file is empty: the
 *     drill is SKIPPED. `meta_backup_status.lastDrillAt` and
 *     `lastDrillOk` are NOT touched. `updatedAt` is NOT bumped (a skip
 *     is not a write — bumping updatedAt on a no-op creates a fake
 *     "the row moved" signal with no Tier-2 outcome behind it).
 *   - A skip is NOT a failure. It returns { outcome: 'skipped',
 *     reason: 'key-absent' } so the caller can log it distinctly.
 *
 * Production wires the downloader + decrypt against R2 + `age -d`.
 * Tests pass stubs; the skip-branch never calls them (the test asserts
 * this by having them throw).
 *
 * Identity material handling (AC-175, ADR-0020):
 *   - The identity file path is read from disk only long enough to
 *     check existence + non-empty.
 *   - The contents are NEVER logged, NEVER included in error messages,
 *     NEVER echoed back through return values.
 *   - Decryption happens by passing the identity PATH to `age -d -i`;
 *     the bytes are never materialized in JS memory outside the
 *     subprocess's own handling.
 */

import fs from 'node:fs/promises';
import type { Database } from '../db/connection.js';
import { getBackupStatus, updateBackupStatus } from '../repositories/backupStatus.js';
import { type Manifest } from './backup.js';

export interface DrillResult {
  outcome: 'ok' | 'failed' | 'skipped';
  /** Populated when outcome !== 'ok'. */
  reason?: string;
  /** Populated when outcome === 'failed'. */
  mismatchedTable?: string;
}

export interface DrillOptions {
  db: Database;
  /**
   * Path to the tmpfs-resident decryption identity. Resolution rule:
   *   - missing file OR empty file → skip (no state change).
   *   - present & non-empty        → attempt decrypt + verify.
   * The path is inspected only for existence + size; the contents are
   * never read into memory here.
   */
  identityPath: string;
  /**
   * Download the most recent encrypted dump from the off-site store.
   * Production wires R2; tests stub. Returns ciphertext bytes.
   */
  downloadLatestDump: () => Promise<Uint8Array>;
  /**
   * Decrypt ciphertext using the identity at `identityPath`. Production
   * shells out to `age -d -i <identityPath>`; tests stub. The identity
   * path is passed through so the decrypt implementation never has to
   * read the identity bytes in its own frame.
   */
  decrypt: (ciphertext: Uint8Array, identityPath: string) => Promise<Uint8Array>;
  /**
   * Run timestamp. Defaults to `new Date()`. Threaded through so tests
   * can pin the exact `lastDrillAt` value written on ok/failed paths.
   */
  now?: Date;
  /**
   * Verify hook — spawns an ephemeral Postgres, restores the plaintext
   * dump, and recomputes the manifest. Tests that exercise the non-skip
   * path inject this. Default raises because the skip-branch tests
   * never reach it.
   */
  verifyManifest?: (dump: Uint8Array) => Promise<Manifest>;
  /**
   * Expected manifest for the verify comparison. Production reads this
   * from the encrypted sidecar alongside the dump; tests inject directly.
   */
  expectedManifest?: Manifest;
}

/**
 * Execute one Tier 2 drill. See module header for the skip semantics.
 */
export async function runDrill(opts: DrillOptions): Promise<DrillResult> {
  const identityState = await inspectIdentity(opts.identityPath);
  if (identityState === 'absent' || identityState === 'empty') {
    // AC-168: skip → NO state change. No updateBackupStatus call.
    return { outcome: 'skipped', reason: 'key-absent' };
  }

  const now = opts.now ?? new Date();

  // Download the latest dump.
  let ciphertext: Uint8Array;
  try {
    ciphertext = await opts.downloadLatestDump();
  } catch (err) {
    const message = errorMessage(err);
    await updateBackupStatus(opts.db, {
      lastDrillAt: now.toISOString(),
      lastDrillOk: false,
      lastError: `drill-download: ${message}`,
    });
    return { outcome: 'failed', reason: `download: ${message}` };
  }

  // Decrypt. The identity path is passed through; the identity bytes
  // never enter this frame.
  let plaintext: Uint8Array;
  try {
    plaintext = await opts.decrypt(ciphertext, opts.identityPath);
  } catch {
    // Scrub any details: the path was passed in by the caller, but we
    // still avoid echoing it back — an operator tailing logs should not
    // see the literal tmpfs path in an error cue (defense-in-depth).
    await updateBackupStatus(opts.db, {
      lastDrillAt: now.toISOString(),
      lastDrillOk: false,
      lastError: 'drill-decrypt: failed',
    });
    return { outcome: 'failed', reason: 'decrypt-failed' };
  }

  // Verify. The verify hook is mandatory for non-skip paths; if the
  // caller forgot to wire it, fail loudly rather than silently "pass".
  if (!opts.verifyManifest || !opts.expectedManifest) {
    // Treat as configuration error — not a drill failure — so the status
    // row doesn't flip to lastDrillOk=false for an operator-side bug.
    // But we also can't leave the caller thinking the drill succeeded.
    await updateBackupStatus(opts.db, {
      lastDrillAt: now.toISOString(),
      lastDrillOk: false,
      lastError: 'drill-config: verify hooks missing',
    });
    return { outcome: 'failed', reason: 'verify-not-wired' };
  }

  let restoreManifest: Manifest;
  try {
    restoreManifest = await opts.verifyManifest(plaintext);
  } catch (err) {
    const message = errorMessage(err);
    await updateBackupStatus(opts.db, {
      lastDrillAt: now.toISOString(),
      lastDrillOk: false,
      lastError: `drill-verify: ${message}`,
    });
    return { outcome: 'failed', reason: `verify: ${message}` };
  }

  const mismatchedTable = firstDivergingTable(opts.expectedManifest, restoreManifest);
  if (mismatchedTable) {
    await updateBackupStatus(opts.db, {
      lastDrillAt: now.toISOString(),
      lastDrillOk: false,
      lastError: `drill-mismatch on ${mismatchedTable}`,
    });
    return { outcome: 'failed', reason: 'manifest-mismatch', mismatchedTable };
  }

  await updateBackupStatus(opts.db, {
    lastDrillAt: now.toISOString(),
    lastDrillOk: true,
    lastError: null,
  });
  return { outcome: 'ok' };
}

/**
 * Convenience re-export for callers that want to observe the last
 * recorded state after a run (e.g., to feed the badge derivation).
 */
export { getBackupStatus };

// ---------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------

/**
 * Identity-path classification. `absent` covers "file does not exist";
 * `empty` covers "file exists but its size is 0" — both are "no key
 * loaded" in the operator flow and must skip identically.
 */
async function inspectIdentity(identityPath: string): Promise<'absent' | 'empty' | 'present'> {
  try {
    const stats = await fs.stat(identityPath);
    if (!stats.isFile()) return 'absent';
    if (stats.size === 0) return 'empty';
    return 'present';
  } catch {
    // ENOENT — the common "no key loaded" state — plus any other stat
    // failure maps to absent. We refuse to distinguish permission
    // errors here because doing so would surface identity-path details
    // in logs; skip silently and the operator re-runs load-drill-key.sh.
    return 'absent';
  }
}

function firstDivergingTable(source: Manifest, restore: Manifest): string | null {
  const allTables = new Set([...Object.keys(source), ...Object.keys(restore)]);
  const sorted = [...allTables].sort();
  for (const table of sorted) {
    const s = source[table];
    const r = restore[table];
    if (!s || !r) return table;
    if (s.rowCount !== r.rowCount) return table;
    if (s.checksum !== r.checksum) return table;
  }
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // drizzle wraps a driver failure as `Failed query: <sql>` and tucks
    // the real Postgres message (e.g. `relation "x" does not exist`) onto
    // `.cause`. Surface the cause so the drill cue is actionable rather
    // than the opaque wrapper — the #1 reason a drill failure is slow to
    // diagnose. The wrapper's `params:` tail stays for the SQL context.
    const cause = err.cause;
    if (cause instanceof Error && cause.message && cause.message !== err.message) {
      return `${err.message} (cause: ${cause.message})`;
    }
    return err.message;
  }
  return typeof err === 'string' ? err : 'unknown';
}
