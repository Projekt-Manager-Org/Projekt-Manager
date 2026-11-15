/**
 * Unit tests for the audit-retention scheduler — AC-633 forwarding
 * plus the sustained-failure backoff state machine.
 *
 * Uses vitest fake timers (end-to-end wall-clock tests would be flaky).
 * The per-run log-line field set is covered by `audit-retention.test.ts`;
 * this file asserts the scheduler forwards that call through and adds
 * the right failure / recovery lines around it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/connection.js';
import {
  EVENT_RECOVERED,
  EVENT_SUSTAINED_FAILURE,
  EVENT_SWEEP_FAILED,
  startAuditRetentionScheduler,
} from '../audit-retention-scheduler.js';
import { EVENT_RETENTION_CLEANUP } from '../services/audit-retention.js';

function makeLogger() {
  return {
    info: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
    error: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
  };
}

/** Fake DB mimicking `db.delete(...).where(...).returning(...)`. */
function fakeDb(rows: unknown[] | (() => Promise<unknown[]> | unknown[])): Database {
  const returning = () => (typeof rows === 'function' ? Promise.resolve(rows()) : rows);
  return { delete: () => ({ where: () => ({ returning }) }) } as unknown as Database;
}

const MINUTE_MS = 60 * 1000;

describe('startAuditRetentionScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forwards exactly one AC-633 cleanup info line per successful tick', async () => {
    const logger = makeLogger();
    const scheduler = startAuditRetentionScheduler({
      db: fakeDb([{ id: 'd1' }]),
      intervalMinutes: 60,
      windowDays: 90,
      logger,
    });
    // Just under the interval — no sweep.
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS - 1);
    expect(logger.info).not.toHaveBeenCalled();
    // Crossing the boundary fires exactly once with the AC-633 field set.
    await vi.advanceTimersByTimeAsync(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [ctx, event] = logger.info.mock.calls[0]!;
    expect(event).toBe(EVENT_RETENTION_CLEANUP);
    expect(ctx.event).toBe(EVENT_RETENTION_CLEANUP);
    expect(ctx.window_days).toBe(90);
    expect(ctx.removed_count).toBe(1);
    expect(typeof ctx.ran_at).toBe('string');
    // Second interval fires again.
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(logger.info).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('stop() cancels further sweeps and awaits an in-flight one', async () => {
    const logger = makeLogger();
    let releaseSweep!: () => void;
    const blocker = new Promise<unknown[]>((resolve) => {
      releaseSweep = () => resolve([{ id: 'drained' }]);
    });
    const scheduler = startAuditRetentionScheduler({
      db: fakeDb(() => blocker),
      intervalMinutes: 1,
      windowDays: 90,
      logger,
    });
    // Fire the interval so a sweep begins but never resolves yet.
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(logger.info).not.toHaveBeenCalled();

    let stopSettled = false;
    const stopPromise = scheduler.stop().then(() => {
      stopSettled = true;
    });
    // Yield microtasks — if stop() didn't await, this would already be true.
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseSweep();
    await stopPromise;
    expect(stopSettled).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);

    // Further ticks must not schedule another sweep.
    await vi.advanceTimersByTimeAsync(MINUTE_MS * 10);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("unref's the interval so it doesn't hold the event loop open", () => {
    const unrefSpy = vi.fn();
    const realSetInterval = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      ...args: Parameters<typeof realSetInterval>
    ) => {
      const handle = realSetInterval(...args);
      (handle as unknown as { unref: () => void }).unref = unrefSpy;
      return handle;
    }) as unknown as typeof globalThis.setInterval);
    const scheduler = startAuditRetentionScheduler({
      db: fakeDb([]),
      intervalMinutes: 1,
      windowDays: 90,
      logger: makeLogger(),
    });
    expect(unrefSpy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    void scheduler.stop();
  });

  describe('sustained-failure backoff', () => {
    it('emits sweep-failed on every failure and sustained-failure exactly once at the ceiling', async () => {
      const logger = makeLogger();
      let calls = 0;
      const scheduler = startAuditRetentionScheduler({
        db: fakeDb(() => {
          calls++;
          throw new Error('boom');
        }),
        intervalMinutes: 1,
        windowDays: 90,
        logger,
      });
      // Ticks 1–3 — three consecutive failures. Tick 3 emits sweep-failed
      // AND sustained-failure. Ticks 4–5 are skipped by the backoff ladder
      // (skip=2 after failure #3). Tick 6 fires failure #4.
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      expect(calls).toBe(3);
      expect(logger.error.mock.calls.filter((c) => c[1] === EVENT_SWEEP_FAILED)).toHaveLength(3);
      expect(logger.error.mock.calls.filter((c) => c[1] === EVENT_SUSTAINED_FAILURE)).toHaveLength(
        1,
      );

      // Ticks 4–5: skipped.
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      expect(calls).toBe(3);
      // Tick 6: failure #4 fires; sustained stays at one.
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      expect(calls).toBe(4);
      expect(logger.error.mock.calls.filter((c) => c[1] === EVENT_SUSTAINED_FAILURE)).toHaveLength(
        1,
      );
      // After failure #4: skip 4 ticks. Tick 11 fires failure #5.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
      }
      expect(calls).toBe(4);
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      expect(calls).toBe(5);

      await scheduler.stop();
    });

    it('emits recovered exactly once when a sweep succeeds after sustained failure', async () => {
      const logger = makeLogger();
      let calls = 0;
      const scheduler = startAuditRetentionScheduler({
        db: fakeDb(() => {
          calls++;
          if (calls <= 3) throw new Error('boom');
          return [{ id: 'row' }];
        }),
        intervalMinutes: 1,
        windowDays: 90,
        logger,
      });
      // Ticks 1–3: three failures. Ticks 4–5: skipped. Tick 6: first success.
      await vi.advanceTimersByTimeAsync(MINUTE_MS * 6);
      expect(calls).toBe(4);
      expect(logger.info.mock.calls.filter((c) => c[1] === EVENT_RECOVERED)).toHaveLength(1);
      // Service's own cleanup line also fires on the recovery tick.
      expect(logger.info.mock.calls.filter((c) => c[1] === EVENT_RETENTION_CLEANUP)).toHaveLength(
        1,
      );
      await scheduler.stop();
    });

    it('does not emit recovered when failures stayed below the ceiling', async () => {
      const logger = makeLogger();
      let calls = 0;
      const scheduler = startAuditRetentionScheduler({
        db: fakeDb(() => {
          calls++;
          if (calls <= 2) throw new Error('boom');
          return [];
        }),
        intervalMinutes: 1,
        windowDays: 90,
        logger,
      });
      // 3 ticks: fail, fail, succeed. No sustained line; no recovered line.
      await vi.advanceTimersByTimeAsync(MINUTE_MS * 3);
      expect(calls).toBe(3);
      expect(logger.error.mock.calls.filter((c) => c[1] === EVENT_SUSTAINED_FAILURE)).toHaveLength(
        0,
      );
      expect(logger.info.mock.calls.filter((c) => c[1] === EVENT_RECOVERED)).toHaveLength(0);
      await scheduler.stop();
    });
  });
});
