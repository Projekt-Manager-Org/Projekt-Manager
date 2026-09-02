/**
 * Threshold-monitor policy constants — architecture.md §12.2 [C].
 *
 * Drives the periodic monitor (`src/server/services/threshold-monitor.ts`)
 * that turns two *conditions* into notification *events*:
 *   - the backup badge sitting on any non-green state;
 *   - global storage usage crossing `storageWarnPercent` of the
 *     deployment's declared capacity (`STORAGE_QUOTA_GB`).
 *
 * Why a monitor rather than a publish at the failure site: a backup
 * failure is detected in the `backup` container (a separate image, see
 * ADR-0020), while `publishSystemEvent` dispatches through references
 * bound at app-server startup. A publish from the runner would hit the
 * unbound branch and silently no-op. Staleness has no failure site at
 * all — nothing happens at the moment a backup goes stale. Both are
 * therefore evaluated from the app process, reading the same DB rows
 * the runner writes.
 *
 * The cap itself is NOT here — it is per-deployment (it tracks the
 * provisioned bucket), so it lives in the env as `STORAGE_QUOTA_GB`.
 * These three are policy and change by code edit plus redeploy, per the
 * [C] pattern established by `BACKUP_THRESHOLDS`.
 *
 *   - storageWarnPercent = 80 — the warn band. Below the cap by enough
 *     margin that the owner can act (delete, or raise the cap) before
 *     uploads would actually be at risk. Warn-only: nothing rejects an
 *     upload at this line.
 *   - intervalMinutes = 15 — sweep cadence. Both conditions move on the
 *     order of hours (backup runs 5×/weekday; storage grows by upload),
 *     so a sub-15-minute sweep would burn ticks without shortening the
 *     time-to-notice in any meaningful way.
 *   - repeatMinutes = 1440 — re-notify cadence while a condition stays
 *     true. A condition that persists is still worth repeating (the
 *     first push may have been missed), but a 15-minute nag trains the
 *     owner to swipe every notification away, which costs more than it
 *     buys. Daily is the compromise. A condition that *changes* (amber
 *     → red) re-notifies immediately regardless of this window.
 */
export interface ThresholdMonitorConfig {
  /** Percent of `STORAGE_QUOTA_GB` at which the warning fires. [C] */
  storageWarnPercent: number;
  /** Sweep cadence in minutes. [C] */
  intervalMinutes: number;
  /** Re-notify cadence in minutes while a condition persists. [C] */
  repeatMinutes: number;
}

/** [C] — customer-configurable; see module docstring for rationale. */
export const THRESHOLD_MONITOR: ThresholdMonitorConfig = {
  storageWarnPercent: 80,
  intervalMinutes: 15,
  repeatMinutes: 1440,
};

/**
 * Bytes per declared GB. Power-of-1024 to match `formatBytes`
 * (AC-274) — a cap of 50 and a badge reading "50.00 GB" must mean the
 * same number of bytes, or the warning fires at a figure the owner
 * cannot reconcile with what the UI shows them.
 */
export const BYTES_PER_GB = 1024 * 1024 * 1024;
