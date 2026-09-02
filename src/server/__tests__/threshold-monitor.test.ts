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

// Mocked so the default (production) publisher branch is assertable —
// see the "production publisher path" describe.
const publishSystemEventMock = vi.hoisted(() =>
  vi.fn<(event: unknown) => Promise<void>>().mockResolvedValue(undefined),
);
vi.mock('../services/notification-publisher.js', () => ({
  publishSystemEvent: publishSystemEventMock,
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

  // AC-355 says "anything other than green", so every non-green state
  // has to reach `publish` — not just the red ones. Driven as a table
  // because the amber rows are the ones that would otherwise go
  // untested: with only red cases, disabling amber warnings entirely
  // (`kind === 'green' || kind === 'amber'` → return) keeps the suite
  // green, and the `drill-stale` / `backup-aging` split this feature
  // rests on would be unproven end to end.
  //
  // Ages are chosen against the REAL `BACKUP_THRESHOLDS` (amber 2 / red
  // 4 days backup, amber 14 / red 30 drill), which the monitor imports
  // directly rather than taking by injection.
  const NON_GREEN_CASES: ReadonlyArray<[string, BackupStatus, string, string]> = [
    ['failed run', { ...greenStatus(), lastBackupOk: false }, 'red', 'last-run-failed'],
    [
      'never run',
      { ...greenStatus(), lastBackupOk: false, lastBackupAt: undefined },
      'red',
      'backup-never-run',
    ],
    ['drill never run', { ...greenStatus(), lastDrillOk: null }, 'red', 'drill-never-run'],
    // The dead-runner case: nothing wrote a failure because nothing ran,
    // the row just ages. This is the coverage the badge alone could not
    // give — it required the owner to look.
    ['stale backup', { ...greenStatus(), lastBackupAt: daysAgo(10) }, 'red', 'backup-stale'],
    ['aging backup', { ...greenStatus(), lastBackupAt: daysAgo(3) }, 'amber', 'backup-aging'],
    ['stale drill', { ...greenStatus(), lastDrillAt: daysAgo(20) }, 'amber', 'drill-stale'],
    // The drill's red line, with the backup fresh. Distinct from
    // 'backup-stale': this is the reason the owner reads in the push, and
    // it must name the drill, not the backup.
    ['expired drill', { ...greenStatus(), lastDrillAt: daysAgo(35) }, 'red', 'drill-expired'],
  ];

  it.each(NON_GREEN_CASES)(
    'publishes backup.failed for a %s state',
    async (_label, status, kind, reason) => {
      readBackupStatus.mockResolvedValue(status);
      const publish = vi.fn().mockResolvedValue(undefined);
      await run({ publish });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith({
        eventClass: 'backup.failed',
        payload: expect.objectContaining({ kind, reason }),
      });
    },
  );

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

  it('does not re-notify when usage dips inside the hysteresis band and returns', async () => {
    // The flapping case. Warn 80, clear 78. A reap drops usage to 79 and
    // the next upload puts it back over. Without hysteresis the dip
    // forgets the condition and the return reads as a fresh crossing,
    // bypassing the repeat window — one push per sweep for a bucket
    // that never left "about 80% full".
    getGlobalUsage.mockResolvedValue(usage(85 * GB));
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish, quotaBytes: 100 * GB });

    getGlobalUsage.mockResolvedValue(usage(79 * GB));
    await run({ publish, quotaBytes: 100 * GB, now: new Date(NOW.getTime() + 15 * 60 * 1000) });

    getGlobalUsage.mockResolvedValue(usage(81 * GB));
    await run({ publish, quotaBytes: 100 * GB, now: new Date(NOW.getTime() + 30 * 60 * 1000) });

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('re-notifies once usage genuinely clears below the hysteresis band and returns', async () => {
    getGlobalUsage.mockResolvedValue(usage(85 * GB));
    const publish = vi.fn().mockResolvedValue(undefined);
    await run({ publish, quotaBytes: 100 * GB });

    // Below the clear line — the owner acted, or the cap was raised.
    getGlobalUsage.mockResolvedValue(usage(70 * GB));
    await run({ publish, quotaBytes: 100 * GB, now: new Date(NOW.getTime() + 15 * 60 * 1000) });

    getGlobalUsage.mockResolvedValue(usage(85 * GB));
    await run({ publish, quotaBytes: 100 * GB, now: new Date(NOW.getTime() + 30 * 60 * 1000) });

    expect(publish).toHaveBeenCalledTimes(2);
  });
});

describe('threshold monitor — production publisher path', () => {
  beforeEach(() => {
    __resetThresholdMonitorState();
    readBackupStatus.mockReset().mockResolvedValue({ ...greenStatus(), lastBackupOk: false });
    getGlobalUsage.mockReset().mockResolvedValue(usage(0));
    publishSystemEventMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('falls back to publishSystemEvent when no publisher is injected', async () => {
    // Every other test injects `publish`, so none of them touches the
    // default. The scheduler does NOT pass one — production runs
    // entirely on this branch, and the premise of the whole feature is
    // that a producer exists. Without this test the suite proves the
    // mock works, not that anything is published.
    await runThresholdMonitor({
      db: FAKE_DB,
      logger: makeLogger(),
      quotaBytes: null,
      now: NOW,
    });
    expect(publishSystemEventMock).toHaveBeenCalledWith({
      eventClass: 'backup.failed',
      payload: expect.objectContaining({ reason: 'last-run-failed' }),
    });
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
