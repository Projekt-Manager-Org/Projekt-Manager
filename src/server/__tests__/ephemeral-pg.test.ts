/**
 * Ephemeral-Postgres verify path — the surfaces testable without the
 * Postgres server binaries.
 *
 * Covers verification.md §15.22:
 *   - AC-165 / AC-166 [crit], implementation side: the Tier 1 verdict is
 *     produced by `ephemeralPgVerify`, whose correctness rests on the
 *     argv it hands `initdb` / `postgres` and on every subprocess
 *     failure becoming a typed rejection rather than a hang or a
 *     silent pass.
 *   - AC-345 [crit], teardown side: the verify server is exempt from the
 *     wall-clock bound (long-lived by contract), so `terminateChild` is
 *     the only thing guaranteeing a run outlives it.
 *
 * WHY ARGV RATHER THAN THE BINARIES: `initdb` and `postgres` ship in the
 * backup image only (Dockerfile.backup, `postgresql17`), never on a dev
 * host or a CI runner, and Alpine-musl builds are what production runs —
 * a host-installed PGDG glibc build would exercise different packaging.
 * The round-trip against the real binaries therefore has to run as the
 * shipped image, which is `scripts/backup/verify-roundtrip.sh` (CI's
 * `docker` job; `npm run test:backup-roundtrip` locally). Everything
 * below is what the host suite can pin without a new toolchain
 * requirement, and it does not substitute for that round-trip: nothing
 * here executes `initdb`, `pg_dump` or `pg_restore`.
 *
 * The two invariants in the first block are load-bearing and were
 * previously unpinned in either place: both have already broken in
 * production once (#199, and the TimeZone drift that produced a false
 * Tier 1 mismatch), and a regression in either is silent — every
 * DB-level backup test stays green because none of them reach this file.
 *
 * Driven against coreutils (`sh`, `grep`, `sleep`) rather than the
 * Postgres binaries: the subprocess properties are "a failing child is
 * reported, a hung child is killed", which is independent of which
 * binary fails. Same rationale as `subprocess-bound.test.ts`, which
 * covers `boundRuntime` / `writeStdin` directly; this file covers the
 * two wrappers built on them.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

import { buildInitdbCommand, buildPostgresArgv } from '../services/ephemeralPg.js';
import {
  runSubprocess,
  runSubprocessWithStdin,
  terminateChild,
} from '../services/subprocessBound.js';

const DATA_DIR = '/tmp/pg-verify-test/data';
const SOCKET_DIR = '/tmp/pg-verify-test/sock';
const PORT = 54321;

/** `-c key=value` reads as two argv elements; pull the value of one. */
function settingValue(args: ReadonlyArray<string>, key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    const next = args[i + 1];
    if (args[i] === '-c' && next?.startsWith(`${key}=`)) return next.slice(key.length + 1);
  }
  return undefined;
}

/** Value of a flag passed as a separate argv element (`-D <dir>`). */
function flagValue(args: ReadonlyArray<string>, flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('ephemeral Postgres argv (§15.22 AC-165, AC-166)', () => {
  const postgres = buildPostgresArgv(DATA_DIR, SOCKET_DIR, PORT);
  const initdb = buildInitdbCommand(DATA_DIR);

  it('disables the TCP listener with a bare empty value, not a quoted one', () => {
    // In a shell you would write `-c listen_addresses=''` and the shell
    // would strip the quotes before exec. `spawn()` calls execve()
    // directly, so quotes survive as literal characters, postgres tries
    // to resolve a host named `''`, and the instance aborts on "could
    // not create any TCP/IP sockets" before the socket is ready. The
    // failure is a readiness timeout 30s later with no obvious cause.
    expect(settingValue(postgres.args, 'listen_addresses')).toBe('');
    expect(postgres.args).not.toContain("listen_addresses=''");
  });

  it('pins the ephemeral cluster to UTC', () => {
    // The manifest checksum is `md5(row(t.*)::text)`, which serializes
    // `timestamptz` through the session TimeZone. The backup container
    // sets TZ=Europe/Berlin for readable cron logs, so without this
    // override initdb inherits it and the restore-side manifest renders
    // `+02` against a source that rendered `+00` — a false Tier 1
    // mismatch on any populated timestamptz column, which fails the run
    // and uploads nothing.
    expect(settingValue(postgres.args, 'TimeZone')).toBe('UTC');
  });

  it('serves only over the unix socket it was given', () => {
    expect(flagValue(postgres.args, '-k')).toBe(SOCKET_DIR);
    expect(flagValue(postgres.args, '-p')).toBe(String(PORT));
    expect(flagValue(postgres.args, '-D')).toBe(DATA_DIR);
  });

  it('pairs trust auth with a disabled TCP listener', () => {
    // `--auth=trust` gives any connecting client a superuser session. It
    // is acceptable ONLY because the instance is unreachable over
    // loopback — the two settings are one decision, and a future edit
    // that re-enables TCP without revisiting auth reopens a free
    // superuser shell to anything inside the container. Asserted as a
    // pair so removing either half fails here.
    expect(initdb.args).toContain('--auth=trust');
    expect(settingValue(postgres.args, 'listen_addresses')).toBe('');
  });

  it('creates the one role every later connection pins by name', () => {
    // `pg_restore --dbname postgresql://postgres@/…` and both pool
    // clients name `postgres` explicitly rather than relying on libpq's
    // process-uid fallback. Drop this flag and initdb names the role
    // after the invoking OS user instead, turning every connection into
    // `role "postgres" does not exist` — surfacing as a 30s readiness
    // timeout, not as the missing flag.
    expect(initdb.args).toContain('--username=postgres');
    expect(flagValue(initdb.args, '-D')).toBe(DATA_DIR);
  });
});

describe('ephemeral Postgres subprocess wrappers (§15.22 AC-165)', () => {
  // `runSubprocess` and `runSubprocessWithStdin` share one
  // implementation; the cases below split on the properties that
  // differ, not on the two entry points.

  it('resolves when the child exits 0', async () => {
    await expect(
      runSubprocess({ cmd: 'sh', args: ['-c', 'exit 0'] }, 'initdb'),
    ).resolves.toBeUndefined();
  });

  it('rejects with the label and the stderr cue on a non-zero exit', async () => {
    // This rejection is what `runBackup` turns into
    // `lastError = "verify: initdb exited 1: …"`. Without the stderr
    // tail the operator gets an exit code and no reason.
    await expect(
      runSubprocess(
        { cmd: 'sh', args: ['-c', 'echo "initdb: directory not empty" >&2; exit 1'] },
        'initdb',
      ),
    ).rejects.toThrow(/initdb exited 1:.*directory not empty/s);
  });

  it('rejects with the label when the binary is not on PATH', async () => {
    // The shape of "the base image dropped postgresql17-contrib" and
    // similar packaging regressions. Node emits `error`, not `close`,
    // so this is a distinct code path from the case above.
    await expect(
      runSubprocess({ cmd: 'pm-no-such-binary-2f9c', args: [] }, 'initdb'),
    ).rejects.toThrow(/initdb failed to spawn/);
  });

  it('delivers stdin to the child', async () => {
    // `pg_restore` reads the entire dump from stdin. If the bytes never
    // arrive it restores an empty database, the recomputed manifest is
    // all-zero rows, and Tier 1 fails on the first table — reported as a
    // mismatch, which sends the operator hunting a data problem that
    // does not exist. `grep -q` exits 0 only if the pattern was in what
    // it actually read.
    // NUL as an escape, never as a literal byte: a single raw NUL in the
    // source makes git classify this whole file as binary, so it renders
    // as `Bin 0 -> N bytes` in every diff and never gets reviewed.
    const marker = new TextEncoder().encode('PGDMP\u0000payload');
    await expect(
      runSubprocessWithStdin({ cmd: 'grep', args: ['-qa', 'PGDMP'] }, marker, 'pg_restore'),
    ).resolves.toBeUndefined();
    await expect(
      runSubprocessWithStdin(
        { cmd: 'grep', args: ['-qa', 'PGDMP'] },
        new Uint8Array(16),
        'pg_restore',
      ),
    ).rejects.toThrow(/pg_restore exited 1/);
  });

  it('reports a child that dies while the dump is still being written', async () => {
    // The real corrupt-artifact path: `pg_restore` rejects the archive
    // header after a few KB and exits, leaving megabytes queued in the
    // pipe. Settling on `close` with the child's own stderr — rather
    // than hanging on the outstanding write, or dying on an unhandled
    // EPIPE — is what makes AC-165's failure branch reachable at all.
    const payload = new Uint8Array(2 * 1024 * 1024);
    await expect(
      runSubprocessWithStdin(
        {
          cmd: 'sh',
          args: [
            '-c',
            'head -c 16 >/dev/null; echo "pg_restore: error: did not find magic string" >&2; exit 1',
          ],
        },
        payload,
        'pg_restore',
      ),
    ).rejects.toThrow(/pg_restore exited 1:.*magic string/s);
  });
});

describe('ephemeral Postgres teardown (§15.22 AC-345)', () => {
  /**
   * Resolve once the child has printed `ready` on stdout.
   *
   * `spawn` fires when the process exists, not when the shell has run
   * its first command — so a test that signals on `spawn` can beat
   * `trap '' TERM` into place and kill a child that was supposed to
   * ignore SIGTERM. That reads as a 5s timeout in whichever assertion
   * came next, roughly one run in four.
   */
  function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
    return new Promise((resolve) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf-8').includes('ready')) resolve();
      });
    });
  }

  it('stops a running instance with SIGTERM', async () => {
    const child = spawn('sh', ['-c', 'echo ready; sleep 30'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForReady(child);

    await terminateChild(child, 2000);

    expect(child.signalCode).toBe('SIGTERM');
  });

  it('escalates to SIGKILL when the instance ignores SIGTERM', async () => {
    // Postgres traps SIGTERM to run a smart shutdown; one wedged on a
    // stuck checkpoint never completes it. Without the backstop the
    // backup runner waits on a process that is never going to leave.
    const child = spawn('sh', ['-c', "trap '' TERM; echo ready; sleep 30"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForReady(child);

    await terminateChild(child, 250);
    // `terminateChild` resolves as soon as SIGKILL is sent; the exit
    // itself lands a moment later.
    const signal = await new Promise((resolve) => child.once('exit', (_c, s) => resolve(s)));

    expect(signal).toBe('SIGKILL');
  });

  it('returns immediately for an instance that already died by signal', async () => {
    // A postgres that crashed (SIGSEGV, or an OOM kill) reports
    // `exitCode === null` with `signalCode` set. Checking only the exit
    // code read that as "still running", so teardown fell through to
    // the wait and parked for the full grace period waiting on an
    // `exit` event that had already fired — a fixed delay added to
    // every run on exactly the path that is already failing.
    const child = spawn('sh', ['-c', 'echo ready; sleep 30'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForReady(child);
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const started = performance.now();
    await terminateChild(child, 5000);

    expect(performance.now() - started).toBeLessThan(1000);
  });
});
