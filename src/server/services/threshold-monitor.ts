/**
 * Threshold monitor — turns two standing *conditions* into notification
 * *events* (ADR-0023 catalog classes `backup.failed` and
 * `disk.threshold_reached`).
 *
 * Why a periodic evaluator rather than a publish at the failure site:
 *
 *   - The backup failure IS written at a failure site, but that site is
 *     the `backup` container — a separate image (ADR-0020). The
 *     notification publisher dispatches through `boundDb` /
 *     `boundDispatcher`, module-level references set only by
 *     `registerNotificationPublisher` during app-server startup. A
 *     `publishSystemEvent` call from the runner process would hit the
 *     unbound branch, log `notification-publisher-not-wired`, and
 *     silently drop the notification.
 *   - Staleness has no failure site at all. `backup-stale`,
 *     `backup-aging`, `drill-stale`, and the never-run states are
 *     derived from row *age* — nothing happens at the moment they trip,
 *     so nothing can publish at that moment.
 *
 * Both are therefore evaluated here, in the app process, over the same
 * `meta_backup_status` row the runner writes. The DB is the cross-process
 * channel; no new IPC.
 *
 * Consequence worth naming: this also covers the dead-runner case. A
 * `backup` container that never starts writes nothing at all, so the
 * failure path never fires — but the row keeps aging, and this monitor
 * notices at the badge's own thresholds.
 *
 * Re-notify policy (`THRESHOLD_MONITOR.repeatMinutes`): a condition
 * notifies on entry, then at most once per repeat window while it
 * persists. A condition whose *key* changes (amber → red, or a
 * different reason) notifies immediately — that is new information.
 * Clearing a condition forgets its slot, so a re-entry notifies again.
 *
 * The slot state is deliberately in-memory. It is a de-duplication
 * convenience, not a correctness requirement: an app restart replays at
 * most one duplicate notification per standing condition, which is
 * harmless, and persisting it would add schema, a migration, and a
 * repository for nothing.
 */

import { BACKUP_THRESHOLDS } from '../../config/backupThresholds.js';
import { THRESHOLD_MONITOR } from '../../config/thresholdMonitor.js';
import { deriveBadgeState } from '../../domain/backupBadge.js';
import type { Database } from '../db/connection.js';
import { BackupStatusService } from './BackupStatusService.js';
import { StorageUsageService } from './StorageUsageService.js';
import { publishSystemEvent } from './notification-publisher.js';
import type { ServiceLogger } from './Logger.js';

/** Injectable publish surface — the real one is `publishSystemEvent`. */
export type PublishSystemEventFn = (event: {
  eventClass: 'backup.failed' | 'disk.threshold_reached';
  payload?: Record<string, unknown>;
}) => Promise<void>;

export interface RunThresholdMonitorOptions {
  db: Database;
  logger: ServiceLogger;
  /**
   * Declared capacity in bytes (`STORAGE_QUOTA_GB` × 1024³), or null
   * when the deployment has not declared one — in which case the
   * storage check is skipped entirely.
   */
  quotaBytes: number | null;
  /** Injectable clock — tests drive the repeat window through this. */
  now?: Date;
  /** Injectable publisher — tests assert dispatch without a bound app. */
  publish?: PublishSystemEventFn;
}

type SlotName = 'backup' | 'storage';

interface SlotState {
  conditionKey: string;
  lastNotifiedAtMs: number;
}

const slots = new Map<SlotName, SlotState>();

/**
 * Test-only reset. Production never calls this — the slots are process
 * state that legitimately outlives individual sweeps.
 */
export function __resetThresholdMonitorState(): void {
  slots.clear();
}

/**
 * Notify when the condition is newly true, when its key changed, or
 * when the repeat window has elapsed since the last notification.
 */
function shouldNotify(
  slot: SlotName,
  conditionKey: string,
  nowMs: number,
  repeatMs: number,
): boolean {
  const prev = slots.get(slot);
  if (!prev) return true;
  if (prev.conditionKey !== conditionKey) return true;
  return nowMs - prev.lastNotifiedAtMs >= repeatMs;
}

function markNotified(slot: SlotName, conditionKey: string, nowMs: number): void {
  slots.set(slot, { conditionKey, lastNotifiedAtMs: nowMs });
}

async function evaluateBackup(
  opts: RunThresholdMonitorOptions,
  now: Date,
  repeatMs: number,
  publish: PublishSystemEventFn,
): Promise<void> {
  const status = await new BackupStatusService(opts.db).read();

  // `null` means the DB is unreachable — the `unknown` badge state.
  // Structurally un-notifiable: the publisher needs this same DB to
  // resolve rules and recipients, so there is no path to a push here.
  // Leave the slot untouched so the next reachable tick evaluates from
  // whatever the true state turns out to be.
  if (status === null) {
    opts.logger.error(
      { event: 'threshold_monitor_backup_status_unreachable' },
      'threshold-monitor: backup status unreadable — skipping backup check',
    );
    return;
  }

  const state = deriveBadgeState(status, now, BACKUP_THRESHOLDS);

  if (state.kind === 'green') {
    slots.delete('backup');
    return;
  }
  // Defensive: `deriveBadgeState` only returns `unknown` for an
  // undefined status, which the null-check above already excluded.
  if (state.kind === 'unknown') return;

  const conditionKey = `${state.kind}:${state.reason}`;
  const nowMs = now.getTime();
  if (!shouldNotify('backup', conditionKey, nowMs, repeatMs)) return;

  await publish({
    eventClass: 'backup.failed',
    payload: {
      kind: state.kind,
      reason: state.reason,
      lastBackupAt: state.lastBackupAt ?? null,
    },
  });
  markNotified('backup', conditionKey, nowMs);
  opts.logger.info(
    { event: 'threshold_monitor_backup_notified', kind: state.kind, reason: state.reason },
    'threshold-monitor: backup condition notified',
  );
}

async function evaluateStorage(
  opts: RunThresholdMonitorOptions,
  now: Date,
  repeatMs: number,
  publish: PublishSystemEventFn,
): Promise<void> {
  const quotaBytes = opts.quotaBytes;
  if (quotaBytes === null) return;

  const usage = await new StorageUsageService(opts.db).getGlobalUsage();

  // Ciphertext, not plaintext. The cap describes provisioned bucket
  // capacity, and what occupies the bucket is the encrypted object
  // (ADR-0024). Plaintext is the user-facing "how much data do I carry"
  // figure the badge and DatenView row show; ciphertext is the
  // operator / billing figure, which is exactly what a capacity warning
  // is about. Hidden rows count: their bytes still occupy the bucket
  // until the lifecycle rule reaps them.
  const usedBytes = usage.ready.ciphertext + usage.hidden.ciphertext;
  const percent = (usedBytes / quotaBytes) * 100;
  const warnPercent = THRESHOLD_MONITOR.storageWarnPercent;
  const clearPercent = warnPercent - THRESHOLD_MONITOR.storageClearMarginPoints;

  // Hysteresis. Clearing at the warn line itself would make usage
  // hovering around the band re-notify on every re-crossing: a reap
  // drops usage a hair under, the next upload pushes it back over, and
  // each crossing looks like a fresh condition that bypasses the repeat
  // window entirely. The band is exactly where a warned deployment
  // sits, so that is the steady state, not a corner case — and an owner
  // who gets a push every sweep mutes the channel, which disables the
  // feature. Below the clear line the condition is genuinely resolved;
  // between the two lines it is neither re-notified nor forgotten.
  if (percent < clearPercent) {
    slots.delete('storage');
    return;
  }
  if (percent < warnPercent) return;

  // The key is the crossing itself, not the percentage — keying on the
  // percent would re-notify on every byte uploaded past the line.
  const conditionKey = 'over';
  const nowMs = now.getTime();
  if (!shouldNotify('storage', conditionKey, nowMs, repeatMs)) return;

  await publish({
    eventClass: 'disk.threshold_reached',
    payload: {
      usedBytes,
      quotaBytes,
      percent: Math.round(percent),
    },
  });
  markNotified('storage', conditionKey, nowMs);
  opts.logger.info(
    { event: 'threshold_monitor_storage_notified', usedBytes, quotaBytes },
    'threshold-monitor: storage condition notified',
  );
}

/**
 * One sweep: evaluate both conditions and publish what is due.
 *
 * The two checks are independent — a failure in one must not suppress
 * the other, or a programmer error on the backup side would silently
 * disable storage warnings forever. Both run, then the first failure
 * (if any) is rethrown so the sweeper's failure counter and backoff
 * engage as they do for every other scheduler.
 */
export async function runThresholdMonitor(opts: RunThresholdMonitorOptions): Promise<void> {
  const now = opts.now ?? new Date();
  const publish = opts.publish ?? publishSystemEvent;
  const repeatMs = THRESHOLD_MONITOR.repeatMinutes * 60 * 1000;

  const results = await Promise.allSettled([
    evaluateBackup(opts, now, repeatMs, publish),
    evaluateStorage(opts, now, repeatMs, publish),
  ]);

  const failure = results.find((r) => r.status === 'rejected');
  if (failure && failure.status === 'rejected') {
    throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  }
}
