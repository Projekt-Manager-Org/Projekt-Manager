/**
 * Unit tests for the periodic session reaper.
 *
 * Uses vitest fake timers. We do not exercise the real DB here —
 * integration/end-to-end timer behavior is impractical to test against
 * real wall-clock intervals without flakiness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/connection.js';
import { startSessionReaper } from '../session-reaper.js';

function makeLogger() {
  return {
    info: vi.fn<(msg: string) => void>(),
    error: vi.fn<(err: unknown, msg: string) => void>(),
  };
}

/**
 * Fake DB — the reaper calls `deleteExpiredSessions(db)` which runs
 * `db.delete(...).where(...).returning(...)`. This stub mimics that chain
 * and lets the test control the "deleted count".
 */
function fakeDb(deletedRows: unknown[] | (() => Promise<unknown[]> | unknown[])): Database {
  const returning = () =>
    typeof deletedRows === 'function' ? Promise.resolve(deletedRows()) : deletedRows;
  return {
    delete: () => ({ where: () => ({ returning }) }),
  } as unknown as Database;
}

describe('startSessionReaper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes the configured intervalMinutes through to the scheduler', async () => {
    const logger = makeLogger();
    const reaper = startSessionReaper({
      db: fakeDb([{ id: 'one' }]),
      intervalMinutes: 5,
      logger,
    });

    // Nothing should have run yet.
    expect(logger.info).not.toHaveBeenCalled();

    // Advance just under the interval — still no sweep.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(logger.info).not.toHaveBeenCalled();

    // Crossing the boundary fires exactly once.
    await vi.advanceTimersByTimeAsync(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]![0]).toContain('1 expired sessions');

    // Second interval fires again.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(logger.info).toHaveBeenCalledTimes(2);

    await reaper.stop();
  });

  it('suppresses the log line when zero rows were deleted', async () => {
    const logger = makeLogger();
    const reaper = startSessionReaper({
      db: fakeDb([]),
      intervalMinutes: 1,
      logger,
    });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(logger.info).not.toHaveBeenCalled();
    await reaper.stop();
  });

  it('swallows sweep errors and keeps firing on the next interval', async () => {
    const logger = makeLogger();
    let calls = 0;
    const reaper = startSessionReaper({
      db: fakeDb(() => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return [{ id: 'ok' }];
      }),
      intervalMinutes: 1,
      logger,
    });

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![1]).toBe('session_reaper_sweep_failed');
    expect(logger.info).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(logger.info).toHaveBeenCalledTimes(1);

    await reaper.stop();
  });

  it('stop() cancels further sweeps', async () => {
    const logger = makeLogger();
    const reaper = startSessionReaper({
      db: fakeDb([{ id: 'x' }]),
      intervalMinutes: 1,
      logger,
    });
    await reaper.stop();
    await vi.advanceTimersByTimeAsync(60 * 1000 * 10);
    expect(logger.info).not.toHaveBeenCalled();
  });

  // The graceful-shutdown path in start.ts awaits stop() before pool.end().
  // This test uses a controlled-defer mock: the sweep hangs on a pending
  // promise until we call `release()`. We trigger the interval, call stop(),
  // then observe that `stop()` does NOT resolve until the sweep resolves.
  it('stop() awaits an in-flight sweep before resolving', async () => {
    const logger = makeLogger();
    let releaseSweep!: () => void;
    const sweepBlocker = new Promise<unknown[]>((resolve) => {
      releaseSweep = () => resolve([{ id: 'drained' }]);
    });
    const reaper = startSessionReaper({
      db: fakeDb(() => sweepBlocker),
      intervalMinutes: 1,
      logger,
    });

    // Fire the interval so a sweep begins but never resolves yet.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(logger.info).not.toHaveBeenCalled();

    let stopSettled = false;
    const stopPromise = reaper.stop().then(() => {
      stopSettled = true;
    });
    // Yield the microtask queue — if stop() were sync or not awaiting the
    // sweep, `stopSettled` would already be true here.
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseSweep();
    await stopPromise;
    expect(stopSettled).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  describe('sustained failure backoff', () => {
    const intervalMs = 60 * 1000;

    it('logs sustained_failure exactly once at the 3rd consecutive failure', async () => {
      const logger = makeLogger();
      let calls = 0;
      const reaper = startSessionReaper({
        db: fakeDb(() => {
          calls++;
          throw new Error('boom');
        }),
        intervalMinutes: 1,
        logger,
      });

      // Tick 1 — failure #1.
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(1);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0]![1]).toBe('session_reaper_sweep_failed');

      // Tick 2 — failure #2. Still no sustained log.
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(2);
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error.mock.calls[1]![1]).toBe('session_reaper_sweep_failed');

      // Tick 3 — failure #3. sweep_failed + sustained_failure fire on this tick.
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(3);
      expect(logger.error).toHaveBeenCalledTimes(4);
      const msgsOnTick3 = [logger.error.mock.calls[2]![1], logger.error.mock.calls[3]![1]];
      expect(msgsOnTick3).toContain('session_reaper_sweep_failed');
      expect(msgsOnTick3).toContain('session_reaper_sustained_failure');

      // Sustained log must not fire again on subsequent failures.
      // Tick 4 and 5 are skipped (backoff after failure #3 skips 2 ticks);
      // the next sweep attempt is tick 6 → failure #4.
      await vi.advanceTimersByTimeAsync(intervalMs * 3);
      const sustainedCount = logger.error.mock.calls.filter(
        (c) => c[1] === 'session_reaper_sustained_failure',
      ).length;
      expect(sustainedCount).toBe(1);

      await reaper.stop();
    });

    it('backs off exponentially after the 3rd consecutive failure', async () => {
      const logger = makeLogger();
      let calls = 0;
      const reaper = startSessionReaper({
        db: fakeDb(() => {
          calls++;
          throw new Error('boom');
        }),
        intervalMinutes: 1,
        logger,
      });

      // Ticks 1, 2, 3 — three consecutive failures.
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(3);

      // After failure #3: skip 2 ticks. Ticks 4 and 5 must NOT invoke sweep.
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(3);

      // Tick 6 — sweep attempt #4 fires and fails.
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(4);

      // After failure #4: skip 4 ticks (7, 8, 9, 10).
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(intervalMs);
        expect(calls).toBe(4);
      }

      // Tick 11 — sweep attempt #5 fires and fails.
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(5);

      await reaper.stop();
    });

    it('caps backoff at 24 ticks', async () => {
      const logger = makeLogger();
      let calls = 0;
      const reaper = startSessionReaper({
        db: fakeDb(() => {
          calls++;
          throw new Error('boom');
        }),
        intervalMinutes: 1,
        logger,
      });

      // Drive consecutiveFailures up to 8 by advancing through the backoff
      // schedule. Skip counts per failure: #3→2, #4→4, #5→8, #6→16, #7→24,
      // #8→24. Between attempt k and attempt k+1 we must advance:
      //   1 tick to fire attempt k + skip(k) ticks to bridge backoff.
      // For attempts 4..8 that's: 1+2, 1+4, 1+8, 1+16, 1+24 ticks after
      // the attempt-3 tick.
      // Attempts 1..3 are back-to-back ticks (no backoff yet).
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(3);

      // Bridge to attempt #4 (skip 2, then fire).
      await vi.advanceTimersByTimeAsync(intervalMs * 3);
      expect(calls).toBe(4);

      // Bridge to attempt #5 (skip 4, then fire).
      await vi.advanceTimersByTimeAsync(intervalMs * 5);
      expect(calls).toBe(5);

      // Bridge to attempt #6 (skip 8, then fire).
      await vi.advanceTimersByTimeAsync(intervalMs * 9);
      expect(calls).toBe(6);

      // Bridge to attempt #7 (skip 16, then fire).
      await vi.advanceTimersByTimeAsync(intervalMs * 17);
      expect(calls).toBe(7);

      // Bridge to attempt #8 (skip 24 — cap from min(2^5, 24), then fire).
      await vi.advanceTimersByTimeAsync(intervalMs * 25);
      expect(calls).toBe(8);

      // Now consecutiveFailures = 8. min(2^6, 24) = 24 — cap holds.
      // Advance 24 ticks — no new sweep (all 24 skipped).
      for (let i = 0; i < 24; i++) {
        await vi.advanceTimersByTimeAsync(intervalMs);
        expect(calls).toBe(8);
      }
      // 25th tick — sweep #9 fires (same "skip N → N+1 intervals" pattern
      // used by the earlier attempt bridges in this test).
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(9);

      await reaper.stop();
    });

    it('logs reaper_recovered once when a sweep succeeds after sustained failure', async () => {
      const logger = makeLogger();
      let calls = 0;
      const reaper = startSessionReaper({
        db: fakeDb(() => {
          calls++;
          if (calls <= 3) throw new Error('boom');
          return [{ id: 'row' }];
        }),
        intervalMinutes: 1,
        logger,
      });

      // Ticks 1, 2, 3 — three failures.
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(3);
      expect(logger.info).not.toHaveBeenCalled();

      // After failure #3, skip ticks 4 and 5. Tick 6 — first successful sweep.
      await vi.advanceTimersByTimeAsync(intervalMs * 3);
      expect(calls).toBe(4);

      const recoveredCalls = logger.info.mock.calls.filter(
        (c) => c[0] === 'session_reaper_recovered',
      );
      expect(recoveredCalls).toHaveLength(1);

      // The "cleaned up 1 expired sessions" line also fires (separate call).
      const cleanedCalls = logger.info.mock.calls.filter((c) =>
        String(c[0]).includes('1 expired sessions'),
      );
      expect(cleanedCalls).toHaveLength(1);

      await reaper.stop();
    });

    it('does not log recovered when consecutiveFailures was below the ceiling', async () => {
      const logger = makeLogger();
      let calls = 0;
      const reaper = startSessionReaper({
        db: fakeDb(() => {
          calls++;
          if (calls <= 2) throw new Error('boom');
          return [{ id: 'row' }];
        }),
        intervalMinutes: 1,
        logger,
      });

      // Two failures, then a success — never hit the sustained threshold.
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(3);

      const recoveredCalls = logger.info.mock.calls.filter(
        (c) => c[0] === 'session_reaper_recovered',
      );
      expect(recoveredCalls).toHaveLength(0);

      await reaper.stop();
    });

    it('resets failure counter on success', async () => {
      const logger = makeLogger();
      let calls = 0;
      const reaper = startSessionReaper({
        db: fakeDb(() => {
          calls++;
          // Sequence: fail, fail, success, fail, fail (then one more tick).
          if (calls === 1 || calls === 2 || calls === 4 || calls === 5) {
            throw new Error('boom');
          }
          return [];
        }),
        intervalMinutes: 1,
        logger,
      });

      // 5 ticks: 2 fails, 1 success (resets counter), 2 fails.
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(calls).toBe(5);

      // Sustained log must never fire — consecutive count never reached 3.
      const sustainedCalls = logger.error.mock.calls.filter(
        (c) => c[1] === 'session_reaper_sustained_failure',
      );
      expect(sustainedCalls).toHaveLength(0);

      await reaper.stop();
    });
  });
});
