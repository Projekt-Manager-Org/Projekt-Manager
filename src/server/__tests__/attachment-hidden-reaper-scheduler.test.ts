/**
 * Unit tests for the attachment hidden reaper scheduler — closes the
 * scheduler-level clauses (graceful drain on stop, single-flight
 * sweep) that the reaper-service tests deliberately leave to this file.
 *
 * Pattern mirrors `audit-retention-scheduler.test.ts`: vitest fake
 * timers, `vi.mock` swaps `runAttachmentHiddenReaper` for a closure-
 * controllable spy so we exercise the scheduler's wiring without
 * standing up a real DB. The reaper service body itself is covered by
 * `attachments-hidden-reaper.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/connection.js';
import {
  EVENT_RECOVERED,
  EVENT_SUSTAINED_FAILURE,
  EVENT_SWEEP_FAILED,
  startAttachmentHiddenReaperScheduler,
} from '../attachment-hidden-reaper-scheduler.js';

// Mock the reaper service. The scheduler is a thin caller over
// `createPeriodicSweeper` whose `sweep` invokes `runAttachmentHiddenReaper`;
// faking the function lets each test drive scheduler behaviour with a
// controllable promise, no DB required.
const runHiddenReaper = vi.hoisted(() =>
  vi.fn<(opts: unknown) => Promise<void>>().mockResolvedValue(undefined),
);
vi.mock('../services/attachment-hidden-reaper.js', () => ({
  runAttachmentHiddenReaper: runHiddenReaper,
}));

function makeLogger() {
  return {
    info: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
    error: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
  };
}

const FAKE_DB = {} as Database;
const MINUTE_MS = 60 * 1000;

describe('startAttachmentHiddenReaperScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runHiddenReaper.mockReset();
    runHiddenReaper.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forwards db, ttlMinutes, and logger to the reaper service on each tick', async () => {
    const logger = makeLogger();
    const scheduler = startAttachmentHiddenReaperScheduler({
      db: FAKE_DB,
      intervalMinutes: 60,
      ttlMinutes: 2880,
      logger,
    });
    // Just under the interval — no sweep yet.
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS - 1);
    expect(runHiddenReaper).not.toHaveBeenCalled();
    // Crossing the boundary fires exactly once with the configured args.
    await vi.advanceTimersByTimeAsync(1);
    expect(runHiddenReaper).toHaveBeenCalledTimes(1);
    expect(runHiddenReaper).toHaveBeenCalledWith({
      db: FAKE_DB,
      logger,
      ttlMinutes: 2880,
    });
    await scheduler.stop();
  });

  // ---------------------------------------------------------------------
  // Graceful-shutdown drain. The first `it.todo` clause in
  // `attachments-hidden-reaper.test.ts` punts here; this is the assertion.
  // ---------------------------------------------------------------------
  it('stop() cancels further sweeps and awaits an in-flight one', async () => {
    const logger = makeLogger();
    let releaseSweep!: () => void;
    runHiddenReaper.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSweep = resolve;
        }),
    );
    const scheduler = startAttachmentHiddenReaperScheduler({
      db: FAKE_DB,
      intervalMinutes: 1,
      ttlMinutes: 2880,
      logger,
    });
    // Fire the interval so a sweep begins but never resolves.
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(runHiddenReaper).toHaveBeenCalledTimes(1);

    let stopSettled = false;
    const stopPromise = scheduler.stop().then(() => {
      stopSettled = true;
    });
    // Yield microtasks — if stop() didn't await the in-flight sweep,
    // it would already be settled here.
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseSweep();
    await stopPromise;
    expect(stopSettled).toBe(true);

    // Further ticks must not schedule another sweep.
    await vi.advanceTimersByTimeAsync(MINUTE_MS * 10);
    expect(runHiddenReaper).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // Single-flight invariant. The second `it.todo` clause in
  // `attachments-hidden-reaper.test.ts` punts here; this is the assertion.
  // ---------------------------------------------------------------------
  it('skips a tick that fires while a previous sweep is still in flight', async () => {
    const logger = makeLogger();
    // Each invocation of the mock returns a fresh never-resolving promise
    // whose resolver is queued so the test can release sweeps in order.
    const releasers: Array<() => void> = [];
    runHiddenReaper.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releasers.push(resolve);
        }),
    );
    const scheduler = startAttachmentHiddenReaperScheduler({
      db: FAKE_DB,
      intervalMinutes: 1,
      ttlMinutes: 2880,
      logger,
    });

    // Tick 1 fires a sweep that won't resolve.
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(runHiddenReaper).toHaveBeenCalledTimes(1);
    // Ticks 2 and 3 fire while sweep #1 is still in flight; they are
    // skipped by the periodic sweeper's currentSweep guard.
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(runHiddenReaper).toHaveBeenCalledTimes(1);

    // Release the in-flight sweep; the next tick fires sweep #2.
    releasers[0]!();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(runHiddenReaper).toHaveBeenCalledTimes(2);

    // Release sweep #2 so scheduler.stop()'s drain doesn't hang.
    releasers[1]!();
    await scheduler.stop();
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
    const scheduler = startAttachmentHiddenReaperScheduler({
      db: FAKE_DB,
      intervalMinutes: 1,
      ttlMinutes: 2880,
      logger: makeLogger(),
    });
    expect(unrefSpy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    void scheduler.stop();
  });

  // -------------------------------------------------------------------
  // Sustained-failure backoff — the ladder logic itself is exhaustively
  // covered by `audit-retention-scheduler.test.ts` (same factory). This
  // test exercises just the wiring: the hidden-reaper scheduler emits
  // its own caller-owned event names through the shared ladder.
  // -------------------------------------------------------------------
  it('emits hidden-reaper-flavoured sweep-failed and sustained-failure events through the shared backoff ladder', async () => {
    const logger = makeLogger();
    runHiddenReaper.mockRejectedValue(new Error('boom'));
    const scheduler = startAttachmentHiddenReaperScheduler({
      db: FAKE_DB,
      intervalMinutes: 1,
      ttlMinutes: 2880,
      logger,
    });
    // Three consecutive failed ticks — the third trips sustained-failure.
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(logger.error.mock.calls.filter((c) => c[1] === EVENT_SWEEP_FAILED)).toHaveLength(3);
    expect(logger.error.mock.calls.filter((c) => c[1] === EVENT_SUSTAINED_FAILURE)).toHaveLength(1);
    await scheduler.stop();
  });

  it('emits a recovered line when a sweep succeeds after sustained failure', async () => {
    const logger = makeLogger();
    let calls = 0;
    runHiddenReaper.mockImplementation(async () => {
      calls += 1;
      if (calls <= 3) throw new Error('boom');
    });
    const scheduler = startAttachmentHiddenReaperScheduler({
      db: FAKE_DB,
      intervalMinutes: 1,
      ttlMinutes: 2880,
      logger,
    });
    // Ticks 1–3 fail (last one trips sustained-failure). Ticks 4–5 are
    // skipped by the backoff (skip=2 after failure #3). Tick 6 succeeds
    // and emits `recovered` exactly once.
    await vi.advanceTimersByTimeAsync(MINUTE_MS * 6);
    expect(calls).toBe(4);
    expect(logger.info.mock.calls.filter((c) => c[1] === EVENT_RECOVERED)).toHaveLength(1);
    await scheduler.stop();
  });
});
