/**
 * Unit tests for the threshold monitor scheduler (#122).
 *
 * Pattern mirrors `attachment-hidden-reaper-scheduler.test.ts`: vitest
 * fake timers, `vi.mock` swaps the monitor service for a spy so the
 * scheduler's wiring is exercised without a DB. The monitor body itself
 * is covered by `threshold-monitor.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/connection.js';
import { startThresholdMonitorScheduler } from '../threshold-monitor-scheduler.js';

const runMonitor = vi.hoisted(() =>
  vi.fn<(opts: unknown) => Promise<void>>().mockResolvedValue(undefined),
);
vi.mock('../services/threshold-monitor.js', () => ({
  runThresholdMonitor: runMonitor,
}));

function makeLogger() {
  return {
    info: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
    error: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
  };
}

const FAKE_DB = {} as Database;
const MINUTE_MS = 60 * 1000;

describe('startThresholdMonitorScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runMonitor.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forwards db, quotaBytes, and logger to the monitor on each tick', async () => {
    const logger = makeLogger();
    const scheduler = startThresholdMonitorScheduler({
      db: FAKE_DB,
      intervalMinutes: 15,
      quotaBytes: 1024,
      logger,
    });

    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);
    expect(runMonitor).toHaveBeenCalledTimes(1);
    expect(runMonitor).toHaveBeenCalledWith({
      db: FAKE_DB,
      logger,
      quotaBytes: 1024,
    });

    await scheduler.stop();
  });

  it('ticks on the configured interval, not faster', async () => {
    const scheduler = startThresholdMonitorScheduler({
      db: FAKE_DB,
      intervalMinutes: 15,
      quotaBytes: null,
      logger: makeLogger(),
    });

    await vi.advanceTimersByTimeAsync(14 * MINUTE_MS);
    expect(runMonitor).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 * MINUTE_MS);
    expect(runMonitor).toHaveBeenCalledTimes(1);

    await scheduler.stop();
  });

  it('carries a null quota through — the monitor decides to skip', async () => {
    const scheduler = startThresholdMonitorScheduler({
      db: FAKE_DB,
      intervalMinutes: 15,
      quotaBytes: null,
      logger: makeLogger(),
    });

    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);
    expect(runMonitor).toHaveBeenCalledWith(expect.objectContaining({ quotaBytes: null }));

    await scheduler.stop();
  });

  it('stops ticking after stop()', async () => {
    const scheduler = startThresholdMonitorScheduler({
      db: FAKE_DB,
      intervalMinutes: 15,
      quotaBytes: null,
      logger: makeLogger(),
    });

    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);
    expect(runMonitor).toHaveBeenCalledTimes(1);

    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(runMonitor).toHaveBeenCalledTimes(1);
  });
});
