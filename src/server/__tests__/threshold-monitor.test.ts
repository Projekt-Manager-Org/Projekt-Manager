/**
 * Unit tests for the threshold monitor (#122).
 *
 * The monitor is the producer that both `backup.failed` and
 * `disk.threshold_reached` lacked — the catalog classes, the seeded
 * owner rules, and the push templates all shipped without anything
 * publishing them.
 *
 * `BackupStatusService` and `StorageUsageService` are mocked so each
 * test drives a condition directly; the publisher is injected. No DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/connection.js';
import type { BackupStatus } from '../../domain/backupBadge.js';
import {
  runThresholdMonitor,
  __resetThresholdMonitorState,
  type PublishSystemEventFn,
} from '../services/threshold-monitor.js';

const readBackupStatus = vi.hoisted(() =>
  vi.fn<() => Promise<BackupStatus | null>>().mockResolvedValue(null),
);
vi.mock('../services/BackupStatusService.js', () => ({
  BackupStatusService: class {
    read = readBackupStatus;
  },
}));

const getGlobalUsage = vi.hoisted(() =>
  vi.fn<
    () => Promise<{
      ready: { plaintext: number; ciphertext: number };
      hidden: { plaintext: number; ciphertext: number };
    }>
  >(),
);
vi.mock('../services/StorageUsageService.js', () => ({
  StorageUsageService: class {
    getGlobalUsage = getGlobalUsage;
  },
}));

const FAKE_DB = {} as Database;
const NOW = new Date('2026-09-02T12:00:00.000Z');
const GB = 1024 * 1024 * 1024;

function makeLogger() {
  return {
    info: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
    error: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
  };
}

/** ISO string for `n` days before NOW. */
function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

/** A healthy status — fresh backup, fresh successful drill. */
function greenStatus(): BackupStatus {
  return {
    lastBackupOk: true,
    lastBackupAt: daysAgo(0),
    lastDrillAt: daysAgo(0),
    lastDrillOk: true,
    lastError: undefined,
    updatedAt: daysAgo(0),
  };
}

function usage(readyCipher: number, hiddenCipher = 0) {
  return {
    ready: { plaintext: 1, ciphertext: readyCipher },
    hidden: { plaintext: 1, ciphertext: hiddenCipher },
  };
}

interface RunOverrides {
  publish: PublishSystemEventFn;
  quotaBytes?: number | null;
  now?: Date;
  logger?: ReturnType<typeof makeLogger>;
}

function run(overrides: RunOverrides) {
  return runThresholdMonitor({
    db: FAKE_DB,
    logger: overrides.logger ?? makeLogger(),
    quotaBytes: overrides.quotaBytes ?? null,
    now: overrides.now ?? NOW,
    publish: overrides.publish,
  });
}

describe('threshold monitor — backup condition', () => {
  beforeEach(() => {
    __resetThresholdMonitorState();
    readBackupStatus.mockReset().mockResolvedValue(greenStatus());
    getGlobalUsage.mockReset().mockResolvedValue(usage(0));
  });
  afterEach(() => vi.restoreAllMocks());

  it('publishes nothing while the badge is green', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish });
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes backup.failed with the derived reason on a failed run', async () => {
    readBackupStatus.mockResolvedValue({ ...greenStatus(), lastBackupOk: false });
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      eventClass: 'backup.failed',
      payload: expect.objectContaining({ kind: 'red', reason: 'last-run-failed' }),
    });
  });

  it('publishes for an age-derived state that has no failure site at all', async () => {
    // The dead-runner case: nothing wrote a failure because nothing ran.
    // The row just ages. This is the coverage the badge alone could not
    // give — it required the owner to look.
    readBackupStatus.mockResolvedValue({
      ...greenStatus(),
      lastBackupAt: daysAgo(10),
      updatedAt: daysAgo(10),
    });
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish });
    expect(publish).toHaveBeenCalledWith({
      eventClass: 'backup.failed',
      payload: expect.objectContaining({ kind: 'red', reason: 'backup-stale' }),
    });
  });

  it('stays silent when the status row is unreadable', async () => {
    // DB unreachable → `unknown`. The publisher needs the same DB to
    // resolve rules and recipients, so there is no path to a push.
    readBackupStatus.mockResolvedValue(null);
    const publish = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    await run({ publish, logger });
    expect(publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'threshold_monitor_backup_status_unreachable' }),
      expect.any(String),
    );
  });
});

describe('threshold monitor — re-notify policy', () => {
  beforeEach(() => {
    __resetThresholdMonitorState();
    readBackupStatus.mockReset().mockResolvedValue({ ...greenStatus(), lastBackupOk: false });
    getGlobalUsage.mockReset().mockResolvedValue(usage(0));
  });
  afterEach(() => vi.restoreAllMocks());

  it('does not re-notify an unchanged condition within the repeat window', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish });
    // 15 minutes later — one sweep interval, far inside the 24h window.
    await run({ publish, now: new Date(NOW.getTime() + 15 * 60 * 1000) });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('re-notifies once the repeat window has elapsed', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish });
    await run({ publish, now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000) });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('re-notifies immediately when the condition changes', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish });
    // Same non-green condition, different reason — new information, so
    // the repeat window does not apply.
    readBackupStatus.mockResolvedValue({
      ...greenStatus(),
      lastBackupAt: daysAgo(10),
      updatedAt: daysAgo(10),
    });
    await run({ publish, now: new Date(NOW.getTime() + 60 * 1000) });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({
      eventClass: 'backup.failed',
      payload: expect.objectContaining({ reason: 'backup-stale' }),
    });
  });

  it('notifies again after the condition clears and returns', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish });
    readBackupStatus.mockResolvedValue(greenStatus());
    await run({ publish, now: new Date(NOW.getTime() + 60 * 1000) });
    expect(publish).toHaveBeenCalledTimes(1);
    // Condition returns well inside the original repeat window — a
    // recurrence is new information, not a repeat.
    readBackupStatus.mockResolvedValue({ ...greenStatus(), lastBackupOk: false });
    await run({ publish, now: new Date(NOW.getTime() + 120 * 1000) });
    expect(publish).toHaveBeenCalledTimes(2);
  });
});

describe('threshold monitor — storage condition', () => {
  beforeEach(() => {
    __resetThresholdMonitorState();
    readBackupStatus.mockReset().mockResolvedValue(greenStatus());
    getGlobalUsage.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('skips the storage check entirely when no quota is declared', async () => {
    getGlobalUsage.mockResolvedValue(usage(100 * GB));
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish, quotaBytes: null });
    expect(publish).not.toHaveBeenCalled();
    expect(getGlobalUsage).not.toHaveBeenCalled();
  });

  it('stays silent below the warn band', async () => {
    getGlobalUsage.mockResolvedValue(usage(79 * GB));
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish, quotaBytes: 100 * GB });
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes disk.threshold_reached at the warn band with the fill percentage', async () => {
    getGlobalUsage.mockResolvedValue(usage(80 * GB));
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish, quotaBytes: 100 * GB });
    expect(publish).toHaveBeenCalledWith({
      eventClass: 'disk.threshold_reached',
      payload: { usedBytes: 80 * GB, quotaBytes: 100 * GB, percent: 80 },
    });
  });

  it('counts hidden ciphertext — those bytes still occupy the bucket', async () => {
    // 60 ready + 25 hidden = 85% of the cap. Counting ready alone would
    // read 60% and stay silent while the bucket is nearly full.
    getGlobalUsage.mockResolvedValue(usage(60 * GB, 25 * GB));
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish, quotaBytes: 100 * GB });
    expect(publish).toHaveBeenCalledWith({
      eventClass: 'disk.threshold_reached',
      payload: expect.objectContaining({ percent: 85 }),
    });
  });

  it('does not re-notify a standing overage within the repeat window', async () => {
    getGlobalUsage.mockResolvedValue(usage(85 * GB));
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish, quotaBytes: 100 * GB });
    // More bytes land, still over — the condition key is the crossing,
    // not the percentage, so this must not re-notify.
    getGlobalUsage.mockResolvedValue(usage(86 * GB));
    await run({
      publish,
      quotaBytes: 100 * GB,
      now: new Date(NOW.getTime() + 15 * 60 * 1000),
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('threshold monitor — failure isolation', () => {
  beforeEach(() => {
    __resetThresholdMonitorState();
    readBackupStatus.mockReset().mockResolvedValue(greenStatus());
    getGlobalUsage.mockReset().mockResolvedValue(usage(0));
  });
  afterEach(() => vi.restoreAllMocks());

  it('still evaluates storage when the backup check throws, then rethrows', async () => {
    readBackupStatus.mockRejectedValue(new Error('boom'));
    getGlobalUsage.mockResolvedValue(usage(90 * GB));
    const publish = vi.fn().mockResolvedValue(undefined);
    await expect(run({ publish, quotaBytes: 100 * GB })).rejects.toThrow('boom');
    // The storage warning still went out — a programmer error on the
    // backup side must not silently disable storage warnings forever.
    expect(publish).toHaveBeenCalledWith({
      eventClass: 'disk.threshold_reached',
      payload: expect.objectContaining({ percent: 90 }),
    });
  });
});
