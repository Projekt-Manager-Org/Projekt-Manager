/**
 * Spawn hardening for the external processes a Layer 2 run starts:
 * a wall-clock bound (verification.md §15.22 AC-345) and a stdin writer
 * that survives the child dying mid-write (AC-346).
 *
 * Both exist for the same reason — a Layer 2 run must always end, and
 * always end by *reporting*. One hangs the tick; the other kills the
 * process before it can write the status row. Either way the operator
 * sees a backup surface still green on its last success.
 *
 * Shared by the three spawn wrappers in the backup surface —
 * `spawnCollect` (pg_dump, age encrypt), `ephemeralPg`'s `runSubprocess`
 * / `runSubprocessWithStdin` (initdb, pg_restore), and the drill's
 * `ageDecrypt`. Lives in its own module so the bound is one
 * implementation rather than four copies of a `setTimeout` dance.
 *
 * Why it exists: the scheduler runs one tick at a time (croner
 * `protect: true`), and `runBackup` awaits the dump inside an open
 * REPEATABLE READ transaction. An unbounded child therefore parks the
 * transaction `idle in transaction` — pinning the cluster xmin horizon
 * and holding ACCESS SHARE on every table — while suppressing every
 * later tick. No crash, no restart, no log line: the backup silently
 * stops happening with the status surface still green on its last
 * success. Failing is the cheap outcome; the run is recorded failed and
 * the next tick retries.
 *
 * The ephemeral verify *server* is deliberately not bounded here — it is
 * long-lived by contract and torn down by `stop()`.
 */

import type { ChildProcess } from 'node:child_process';

/**
 * Ceiling for any single backup subprocess.
 *
 * One value for all of them on purpose. The point is "does not hang
 * forever", and nothing downstream branches on *which* binary overran —
 * the label in `lastError` already says that. Per-binary ceilings would
 * be config surface bought with no operational gain.
 *
 * Sized to be unreachable in normal operation rather than tight: at this
 * dataset's size every one of these finishes in seconds, and the tick
 * interval is three hours, so even several chained timeouts land well
 * inside one cycle.
 */
export const SUBPROCESS_TIMEOUT_MS = 15 * 60_000;

/** Grace between SIGTERM and SIGKILL for a child that ignores the former. */
export const SUBPROCESS_SIGKILL_GRACE_MS = 5_000;

/**
 * Hand `bytes` to the child's stdin, tolerating the child going away
 * before it has read them (AC-346).
 *
 * A child that exits early — `age` on a malformed recipient,
 * `pg_restore` rejecting a corrupt archive — leaves the write queued in
 * the pipe, which then errors EPIPE. Nothing else consumes errors on
 * `stdin`, and an `'error'` event with no listener is an uncaught
 * exception. It is also asynchronous, so the `try`/`catch` around
 * `runBackup` never sees it, and `backup-runner.ts` is a separate
 * entrypoint that registers no `uncaughtException` handler (the one in
 * `start.ts` covers the app only). The process would exit before the
 * status row is written: no `lastBackupOk=false`, no `lastError`, and a
 * freshness badge still green on the previous success — the
 * misleading-state class ADR-0014 rules out.
 *
 * Swallowing the error is the right call rather than a shortcut: `close`
 * already carries the real outcome (exit code plus stderr), so the pipe
 * error is redundant detail about a failure the caller is about to
 * report anyway. Dropping it costs nothing; letting it escape costs the
 * whole run's reporting.
 */
export function writeStdin(child: ChildProcess, bytes?: Uint8Array): void {
  child.stdin?.on('error', () => {});
  if (bytes) {
    child.stdin?.end(bytes);
  } else {
    child.stdin?.end();
  }
}

export interface RuntimeBound {
  /** Clear both timers. Call from the child's `close` / `error` handler. */
  release(): void;
  /** True once the bound fired and the child was signalled. */
  expired(): boolean;
  /** The error to reject with when `expired()` — callers supply the label. */
  error(label: string): Error;
}

/**
 * Arm a wall-clock bound on `child`: SIGTERM at `timeoutMs`, SIGKILL
 * `graceMs` later if it is still alive.
 *
 * Does not itself reject — the caller owns the promise and already has a
 * `close` handler; it asks `expired()` there to tell "killed by us" from
 * "exited on its own with a signal".
 */
export function boundRuntime(
  child: ChildProcess,
  timeoutMs: number = SUBPROCESS_TIMEOUT_MS,
  graceMs: number = SUBPROCESS_SIGKILL_GRACE_MS,
): RuntimeBound {
  let timedOut = false;
  let hardKillTimer: NodeJS.Timeout | undefined;

  const softKillTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    // A child that traps or ignores SIGTERM would otherwise leave us in
    // exactly the hang this module exists to prevent.
    hardKillTimer = setTimeout(() => {
      child.kill('SIGKILL');
      // Killing the process is not enough on its own. Callers settle on
      // `close`, which waits for the stdio pipes to reach EOF as well as
      // for exit — and a grandchild that inherited those pipes keeps
      // them open after its parent dies. Dropping our own ends lets
      // `close` fire regardless of what is still holding the far end.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    }, graceMs);
  }, timeoutMs);

  return {
    release() {
      clearTimeout(softKillTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
    },
    expired() {
      return timedOut;
    },
    error(label: string) {
      return new Error(`${label} exceeded its ${timeoutMs}ms runtime bound and was terminated`);
    },
  };
}
