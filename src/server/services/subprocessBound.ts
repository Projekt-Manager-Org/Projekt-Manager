/**
 * Spawn hardening for the external processes a Layer 2 run starts:
 * a wall-clock bound (verification.md §15.22 AC-345), a stdin writer
 * that survives the child dying mid-write (AC-346), and the two
 * run-to-completion wrappers built on both.
 *
 * The bound and the stdin writer exist for the same reason — a Layer 2
 * run must always end, and always end by *reporting*. One hangs the
 * tick; the other kills the process before it can write the status row.
 * Either way the operator sees a backup surface still green on its last
 * success.
 *
 * Shared by every spawn site in the backup surface — `spawnCollect`
 * (pg_dump, age encrypt), `ephemeralPg`'s initdb / pg_restore calls via
 * `runSubprocess` / `runSubprocessWithStdin` below, and the drill's
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
 * The ephemeral verify *server* is deliberately not bounded by
 * `boundRuntime` — it is long-lived by contract. Its teardown is
 * `terminateChild` below, which carries the same SIGTERM → SIGKILL
 * escalation without the wall-clock trigger.
 */

import { spawn, type ChildProcess } from 'node:child_process';

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

// ---------------------------------------------------------------
// Run-to-completion wrappers
// ---------------------------------------------------------------

export interface SubprocessCommand {
  cmd: string;
  args: ReadonlyArray<string>;
}

/**
 * Run a subprocess to completion, discarding its stdout. Resolves on
 * exit code 0; rejects with a typed Error carrying the stderr tail on
 * any other exit code, on a spawn failure, or when the runtime bound
 * fired.
 *
 * `label` — not `command.cmd` — names the failure, because the operator
 * reads it off `meta_backup_status.lastError` where "initdb" is the
 * useful word and the full argv is noise.
 *
 * Use `spawnCollect` in `backup.ts` instead when the child's stdout IS
 * the result (pg_dump, age). This one exists for the children whose
 * only outputs are an exit code and a diagnostic.
 */
export function runSubprocess(command: SubprocessCommand, label: string): Promise<void> {
  return runToCompletion(command, label, undefined);
}

/**
 * Like `runSubprocess` but pipes a byte buffer into the child's stdin.
 * Used for `pg_restore`, where the dump bytes are streamed in.
 */
export function runSubprocessWithStdin(
  command: SubprocessCommand,
  stdin: Uint8Array,
  label: string,
): Promise<void> {
  return runToCompletion(command, label, stdin);
}

function runToCompletion(
  command: SubprocessCommand,
  label: string,
  stdin: Uint8Array | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command.cmd, [...command.args], {
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const bound = boundRuntime(child);
    const stderr: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf-8'));
    });
    child.stdout?.on('data', () => {
      /* drain — a full pipe would deadlock the child */
    });
    child.once('error', (err) => {
      bound.release();
      reject(new Error(`${label} failed to spawn: ${err.message}`));
    });
    child.once('close', (code) => {
      bound.release();
      // AC-345: a hung binary must fail the run, not park the scheduler.
      if (bound.expired()) return reject(bound.error(label));
      if (code === 0) return resolve();
      reject(new Error(`${label} exited ${code}: ${stderr.join('').trim()}`));
    });
    if (stdin) writeStdin(child, stdin);
  });
}

/**
 * Stop a long-lived child: SIGTERM, then SIGKILL after `graceMs` if it
 * is still alive. Resolves once the child is gone, or once the grace
 * has elapsed — never blocks indefinitely on a process that ignores
 * both signals and never closes its pipes.
 *
 * Separate from `boundRuntime` because the trigger is different: this
 * one is called deliberately at teardown, not fired by a wall clock.
 * The ephemeral verify Postgres is the only caller — it is exempt from
 * the runtime bound (long-lived by contract), so without this it would
 * be the one child a Layer 2 run cannot guarantee it outlives.
 */
export function terminateChild(
  child: ChildProcess,
  graceMs: number = SUBPROCESS_SIGKILL_GRACE_MS,
): Promise<void> {
  // `exitCode` alone is not "has it ended": a child killed by a signal
  // reports `exitCode === null` with `signalCode` set. Checking only the
  // former made a crashed instance (postgres dying on SIGSEGV, or on an
  // earlier SIGKILL from here) fall through to the wait below, where the
  // `exit` event had already fired — so teardown parked for the full
  // grace period on exactly the path that is already going badly.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  child.kill('SIGTERM');
  return new Promise<void>((resolve) => {
    const onExit = (): void => {
      clearTimeout(hardKillTimer);
      resolve();
    };
    child.once('exit', onExit);
    const hardKillTimer = setTimeout(() => {
      child.off('exit', onExit);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, graceMs);
    // Do not hold the event loop open for the backstop — the caller is
    // already awaiting this promise, and a lingering timer would keep a
    // one-shot `backup-runner run` alive past its own exit.
    hardKillTimer.unref();
  });
}
