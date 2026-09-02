/**
 * Backup-freshness badge derivation — pure function layer.
 *
 * Given a `BackupStatus` (or `undefined` for "unreachable") and a set
 * of freshness thresholds, derives the badge state rendered on the
 * owner's authenticated landing view.
 *
 * Mapping rules (verification.md §15.22, AC-170 / AC-171):
 *   - `status === undefined`         → { kind: 'unknown' }
 *                                       (DB down AND mirror unavailable)
 *   - `lastBackupOk === false`
 *     AND `lastBackupAt === undefined`
 *                                     → { kind: 'red', reason: 'backup-never-run' }
 *                                       (pre-seed row — no run has ever happened)
 *   - `lastBackupOk === false`       → { kind: 'red', reason: 'last-run-failed' }
 *                                       (a real run failed — `lastBackupAt` is set)
 *   - `lastDrillOk === null`         → { kind: 'red', reason: 'drill-never-run' }
 *                                       (no Tier 2 drill has ever succeeded or failed —
 *                                        data-model.md §5.9 authoritative null signal)
 *   - backup age > backupRedDays     → { kind: 'red', reason: 'backup-stale' }
 *   - drill age > drillRedDays       → { kind: 'red', reason: 'backup-stale' }
 *                                       (drill staleness is a red signal at the red
 *                                        threshold — AC-171 treats an unverified
 *                                        backup cycle as worse than a stale one)
 *   - drill age > drillAmberDays     → { kind: 'amber', reason: 'drill-stale' }
 *   - backup age > backupAmberDays   → { kind: 'amber', reason: 'backup-aging' }
 *                                       (only reachable when the drill is green —
 *                                        drill amber takes precedence above)
 *   - otherwise                      → { kind: 'green' }
 *
 * The label on the 'unknown' branch is a German UI string per AC-171 —
 * "Status unbekannt". Rendering code may sentence-case it; tests match
 * case-insensitively so the component is free to choose.
 *
 * Pure function: no I/O, no React, no DB. Safe to import from both
 * server (for the authenticated endpoint response) and client (for
 * rendering) per the shared-domain layering rule in architecture.md §11.2.
 */

/**
 * Canonical type for the single-row `meta_backup_status` table
 * (data-model.md §5.9). This declaration is the cross-layer authority —
 * the server repository `backupStatus.ts` re-exports it, and the client
 * consumes it from here.
 */
export interface BackupStatus {
  /** ISO 8601 — timestamp of the last completed run (success or failure). */
  lastBackupAt?: string;
  /** true when the last run produced an uploaded, Tier-1-verified artifact. */
  lastBackupOk: boolean;
  /** ISO 8601 — timestamp of the last Tier-2 drill attempt. */
  lastDrillAt?: string;
  /**
   * true / false / null semantics per data-model.md §5.9:
   *   - true  : last Tier 2 drill succeeded
   *   - false : last Tier 2 drill failed
   *   - null  : no Tier 2 drill has ever succeeded OR failed (never-run)
   * Distinct from "skipped" — skipped leaves this value unchanged.
   */
  lastDrillOk: boolean | null;
  /** Short machine-readable failure cue; null on success. */
  lastError?: string;
  /** ISO 8601 — set by the backup service on every write (never on skip). */
  updatedAt: string;
}

export type BackupBadgeState =
  | { kind: 'unknown'; label: string }
  | { kind: 'green'; lastBackupAt?: string }
  | { kind: 'amber'; reason: 'drill-stale' | 'backup-aging'; lastBackupAt?: string }
  | {
      kind: 'red';
      reason: 'backup-stale' | 'drill-never-run' | 'last-run-failed' | 'backup-never-run';
      lastBackupAt?: string;
    };

export interface BadgeThresholds {
  /** Age (days) at which a fresh-but-aging backup switches to amber. */
  backupAmberDays: number;
  /** Age (days) at which a backup is considered red-stale. */
  backupRedDays: number;
  /** Age (days) at which a fresh-but-aging drill switches to amber. */
  drillAmberDays: number;
  /** Age (days) at which a drill is considered red-stale. */
  drillRedDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * AC-171 calls out "Status unbekannt" by name. Centralized here so the
 * renderer never forges a label by itself and drift between backends and
 * the client can't happen silently.
 */
const UNKNOWN_LABEL = 'Status unbekannt';

/** Day-delta between `then` and `now`. Negative when `then` is in the future. */
function daysBetween(then: Date, now: Date): number {
  return Math.floor((now.getTime() - then.getTime()) / DAY_MS);
}

export function deriveBadgeState(
  status: BackupStatus | undefined,
  now: Date,
  thresholds: BadgeThresholds,
): BackupBadgeState {
  // Misleading-state guard (AC-171): the unreachable branch must NEVER
  // silently hide the badge. It renders as an explicit unknown state.
  if (status === undefined) {
    return { kind: 'unknown', label: UNKNOWN_LABEL };
  }

  // Never-run signal: the migration pre-seeds the row with
  // `lastBackupOk=false` AND `lastBackupAt=undefined`. That pair is the
  // "no backup has ever run on this DB" state — distinct from "a real run
  // failed", which always carries a populated `lastBackupAt`. Surface it
  // with its own reason so the operator sees "never-run" instead of the
  // misleading "last-run-failed" cue.
  if (status.lastBackupOk === false && status.lastBackupAt === undefined) {
    return { kind: 'red', reason: 'backup-never-run' };
  }

  // A failed run outranks every other signal: a recent timestamp with
  // `lastBackupOk === false` is the "stale-but-green" trap AC-171
  // explicitly forbids. Check this before the age thresholds.
  if (status.lastBackupOk === false) {
    return { kind: 'red', reason: 'last-run-failed', lastBackupAt: status.lastBackupAt };
  }

  // Never-run drill. `null` (not `undefined`) is the authoritative
  // never-run signal per data-model.md §5.9. Surfaces as red, not amber,
  // because an unverified backup cycle is worse than a stale verified one.
  if (status.lastDrillOk === null) {
    return { kind: 'red', reason: 'drill-never-run', lastBackupAt: status.lastBackupAt };
  }

  // Backup age evaluation — both red and amber thresholds.
  if (status.lastBackupAt !== undefined) {
    const backupAgeDays = daysBetween(new Date(status.lastBackupAt), now);
    if (backupAgeDays > thresholds.backupRedDays) {
      return { kind: 'red', reason: 'backup-stale', lastBackupAt: status.lastBackupAt };
    }
  }

  // Drill age evaluation. `lastDrillAt === undefined` alongside
  // `lastDrillOk !== null` is an internal inconsistency — treat it as
  // red-stale to surface the problem loudly rather than coerce green.
  if (status.lastDrillAt === undefined) {
    return { kind: 'red', reason: 'backup-stale', lastBackupAt: status.lastBackupAt };
  }
  const drillAgeDays = daysBetween(new Date(status.lastDrillAt), now);
  if (drillAgeDays > thresholds.drillRedDays) {
    return { kind: 'red', reason: 'backup-stale', lastBackupAt: status.lastBackupAt };
  }
  if (drillAgeDays > thresholds.drillAmberDays) {
    return { kind: 'amber', reason: 'drill-stale', lastBackupAt: status.lastBackupAt };
  }

  // Amber backup-age window — only applies when drill is green. Drill
  // age in amber takes precedence (documented above).
  if (status.lastBackupAt !== undefined) {
    const backupAgeDays = daysBetween(new Date(status.lastBackupAt), now);
    if (backupAgeDays > thresholds.backupAmberDays) {
      // Distinct from 'drill-stale': the backup itself is aging while the
      // drill is still fresh. The two shared a reason string while the
      // reason only fed a badge tooltip, but the threshold monitor now
      // renders it into a push body — collapsing them would tell the
      // owner the drill is overdue when the backup is the problem.
      return { kind: 'amber', reason: 'backup-aging', lastBackupAt: status.lastBackupAt };
    }
  }

  return { kind: 'green', lastBackupAt: status.lastBackupAt };
}
