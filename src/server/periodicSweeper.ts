/**
 * Shared periodic-sweeper factory.
 *
 * Extracted from the audit-retention and attachment-orphan reapers,
 * which carried identical timer drive and sustained-failure backoff
 * plumbing (a third caller has since been deleted):
 *   - setInterval + handle.unref() so the timer does not hold the
 *     Node event loop open;
 *   - a `currentSweep` guard so overlapping ticks never race;
 *   - a per-scheduler failure counter that emits `sweep-failed` on
 *     every failure and `sustained-failure` exactly once at the third
 *     consecutive failure, then skips `2^(n - ceiling + 1)` ticks
 *     (capped at 24) until the next attempt;
 *   - a `recovered` line emitted exactly once when a sweep succeeds
 *     after crossing the ceiling;
 *   - `stop()` that cancels the interval and awaits any in-flight
 *     sweep so graceful shutdown doesn't tear down the pg pool or
 *     storage client mid-call.
 *
 * The single-process invariant (ADR-0021) lives on the callers, not
 * here — this factory is deliberately topology-agnostic. A future
 * multi-replica deployment would need a lease/lock at the caller
 * site; nothing in this file would change.
 */

import type { ServiceLogger } from './services/Logger.js';

/**
 * Event-name triple emitted by a sweeper. Kept caller-owned so each
 * scheduler's op-log stream stays distinguishable — operators grep for
 * these strings and renaming them silently would break alerting.
 */
export interface SweeperEvents {
  /** Emitted on every sweep failure with `error_message`. */
  sweepFailed: string;
  /** Emitted exactly once when failures reach the ceiling. */
  sustainedFailure: string;
  /** Emitted exactly once when a sweep succeeds after the ceiling. */
  recovered: string;
}

export interface CreatePeriodicSweeperOptions {
  /** Scheduler-specific sweep body. Must resolve or reject per tick. */
  sweep: () => Promise<void>;
  /** Tick cadence. Callers convert minutes → ms at the boundary. */
  intervalMs: number;
  /** Structured logger used for failure and recovery lines. */
  logger: ServiceLogger;
  /** Op-log event names — caller-owned, see `SweeperEvents`. */
  events: SweeperEvents;
}

export interface PeriodicSweeperHandle {
  /** Cancel the interval and await any sweep already in flight. */
  stop: () => Promise<void>;
}

const SUSTAINED_FAILURE_CEILING = 3;
const MAX_BACKOFF_TICKS = 24;

interface SweepState {
  consecutiveFailures: number;
  ticksToSkip: number;
}

export function createPeriodicSweeper(opts: CreatePeriodicSweeperOptions): PeriodicSweeperHandle {
  let currentSweep: Promise<void> | null = null;
  const state: SweepState = { consecutiveFailures: 0, ticksToSkip: 0 };

  const handle = setInterval(() => {
    if (currentSweep) return;
    if (state.ticksToSkip > 0) {
      state.ticksToSkip -= 1;
      return;
    }
    currentSweep = runSweep(opts, state).finally(() => {
      currentSweep = null;
    });
  }, opts.intervalMs);
  // Don't keep the Node event loop alive just for this timer.
  handle.unref();

  return {
    stop: async () => {
      clearInterval(handle);
      if (currentSweep) await currentSweep;
    },
  };
}

async function runSweep(opts: CreatePeriodicSweeperOptions, state: SweepState): Promise<void> {
  try {
    await opts.sweep();
    if (state.consecutiveFailures >= SUSTAINED_FAILURE_CEILING) {
      opts.logger.info({ event: opts.events.recovered }, opts.events.recovered);
    }
    state.consecutiveFailures = 0;
    state.ticksToSkip = 0;
  } catch (err) {
    state.consecutiveFailures += 1;
    const errorMessage = err instanceof Error ? err.message : String(err);
    opts.logger.error(
      { event: opts.events.sweepFailed, error_message: errorMessage },
      opts.events.sweepFailed,
    );
    if (state.consecutiveFailures === SUSTAINED_FAILURE_CEILING) {
      opts.logger.error(
        { event: opts.events.sustainedFailure, error_message: errorMessage },
        opts.events.sustainedFailure,
      );
    }
    if (state.consecutiveFailures >= SUSTAINED_FAILURE_CEILING) {
      const exponent = state.consecutiveFailures - SUSTAINED_FAILURE_CEILING + 1;
      state.ticksToSkip = Math.min(2 ** exponent, MAX_BACKOFF_TICKS);
    }
  }
}
