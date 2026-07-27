/**
 * Ephemeral Postgres for Tier 1 / Tier 2 verify.
 *
 * Spawns a throwaway Postgres instance in `/tmp`, pipes a `pg_dump -Fc`
 * artifact through `pg_restore --single-transaction`, computes the
 * per-table manifest against the restored DB, tears everything down.
 *
 * Binary requirements (must be on PATH in the backup container):
 *   - initdb       (postgresql17 alpine package)
 *   - postgres
 *   - pg_isready
 *   - pg_restore
 *
 * The container runs as the `postgres` system user (UID 70, set by
 * `USER postgres` in Dockerfile.backup — #199). initdb / postgres run
 * directly under that UID; no `su-exec` / `gosu` demotion needed. The
 * historical root-then-demote path was removed when the container went
 * non-root; if a test environment ever invokes this as root, initdb
 * will refuse and the rejection surfaces immediately.
 *
 * This file is intentionally kept separate from `backup.ts` because the
 * subprocess choreography is substantial and has very different risk
 * profile (external binaries, timeouts, cleanup) from the "orchestrate
 * run + upload" logic in the main service.
 *
 * All subprocess invocations: exit code is checked; a non-zero exit
 * maps to a typed rejection carrying the stderr cue. Callers turn that
 * into a typed `BackupRunResult.error` — errors never escape as
 * untyped `Error` into routes.
 */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { computeManifest, type Manifest, type VerifyManifestFn } from './backup.js';
import { boundRuntime, writeStdin } from './subprocessBound.js';
import { attachPoolErrorHandler } from '../db/connection.js';
import * as schema from '../db/schema.js';

const { Pool } = pg;

// Upper bound for waiting on `pg_isready` after spawning postgres. If
// initdb / postgres binaries themselves are missing the spawn errors
// surface immediately; this timeout exists for the "binary present but
// slow to accept connections" case. 30s is generous for our dataset sizes.
const PG_READY_TIMEOUT_MS = 30_000;
const PG_READY_POLL_INTERVAL_MS = 250;

interface EphemeralInstance {
  /** Directory initdb was pointed at (PGDATA). Removed on teardown. */
  dataDir: string;
  /** Unix-socket directory passed to postgres via `-k`. */
  socketDir: string;
  /**
   * Port number set via `-p`. Postgres does NOT listen on TCP for this
   * port (listen_addresses=''); the value is still needed so the unix
   * socket file (`.s.PGSQL.<port>`) has a stable name that clients
   * connect to via the libpq `host=<socketDir>&port=<port>` conn-string
   * form.
   */
  port: number;
  /** The postgres subprocess. `stop()` awaits its exit. */
  stop: () => Promise<void>;
}

/**
 * Produce a production `VerifyManifestFn` that spawns an ephemeral
 * Postgres for every call. Intended to be constructed once by the CLI
 * entry point and passed into `runBackup`.
 *
 * The function does NOT cache / reuse the instance across calls —
 * correctness > latency here. A fresh instance means the restore-side
 * manifest is never contaminated by residue from a prior verify.
 */
export function ephemeralPgVerify(): VerifyManifestFn {
  return async (dump: Uint8Array): Promise<Manifest> => {
    const instance = await startEphemeralPostgres();
    try {
      await restoreDumpIntoInstance(dump, instance);
      return await computeManifestInInstance(instance);
    } finally {
      await instance.stop();
      await cleanupDir(instance.dataDir);
      await cleanupDir(instance.socketDir);
    }
  };
}

// ---------------------------------------------------------------
// Ephemeral instance lifecycle
// ---------------------------------------------------------------

async function startEphemeralPostgres(): Promise<EphemeralInstance> {
  const tag = `pg-verify-${process.pid}-${Date.now()}`;
  const dataDir = path.join(os.tmpdir(), tag, 'data');
  const socketDir = path.join(os.tmpdir(), tag, 'sock');

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(socketDir, { recursive: true });

  // Container runs as the `postgres` system user (UID 70 — see file
  // header). initdb / postgres run as that UID directly; no demotion
  // step. The dirs we just mkdir'd are owned by the current process
  // user, which is also `postgres`, so initdb can write into them.
  await runSubprocess(buildInitdbCommand(dataDir), 'initdb');

  const port = await pickFreePort();
  const postgresCmd = buildPostgresArgv(dataDir, socketDir, port);
  const postgres = spawn(postgresCmd.cmd, postgresCmd.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Drain stdout/stderr so the subprocess doesn't deadlock on a full
  // pipe. We don't log the lines — a verbose postgres log would swamp
  // the backup log with noise — but we collect the tail for error cues.
  const stderrTail: string[] = [];
  postgres.stderr?.on('data', (chunk: Buffer) => {
    stderrTail.push(chunk.toString('utf-8'));
    // Keep only the last ~8KB so long-running idle pg doesn't leak.
    while (stderrTail.join('').length > 8192) stderrTail.shift();
  });
  postgres.stdout?.on('data', () => {
    /* drain */
  });

  // If postgres exits before we ever connect, surface the error.
  let earlyExitError: Error | null = null;
  postgres.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      earlyExitError = new Error(
        `postgres subprocess exited early (code=${code}, signal=${signal ?? 'none'}): ${stderrTail.join('').trim()}`,
      );
    }
  });

  // Poll readiness via a unix-socket SELECT 1. Cannot use TCP — the
  // instance is configured with `listen_addresses=''`. Also probe TCP
  // once after readiness and refuse to continue if it answers: that
  // would mean the listen_addresses override didn't take effect (e.g.
  // a future compose edit that injected a pg conf file) and the
  // --auth=trust setup is suddenly reachable over loopback.
  await waitForPostgresReady(socketDir, port, PG_READY_TIMEOUT_MS, () => earlyExitError);
  await assertTcpDisabled(port);

  return {
    dataDir,
    socketDir,
    port,
    stop: async () => {
      if (postgres.exitCode !== null) return;
      postgres.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        postgres.once('exit', done);
        // Worst-case backstop so a hung postgres cannot keep the
        // backup runner alive past the lock's natural expiry.
        setTimeout(() => {
          if (postgres.exitCode === null) {
            postgres.kill('SIGKILL');
          }
          resolve();
        }, 5000).unref();
      });
    },
  };
}

/**
 * Pipe the compressed `pg_dump -Fc` output into `pg_restore` against the
 * ephemeral instance. `--single-transaction` makes the restore atomic;
 * a corrupted dump produces one failure, not a half-restored schema.
 */
async function restoreDumpIntoInstance(
  dump: Uint8Array,
  instance: EphemeralInstance,
): Promise<void> {
  await runSubprocessWithStdin(
    {
      cmd: 'pg_restore',
      args: [
        '--dbname',
        // `postgres@` pins the role explicitly. initdb ran with
        // `--username=postgres`, so `postgres` is the only role that
        // exists in the ephemeral cluster. Pinning here keeps the
        // restore independent of libpq's process-uid → username
        // fallback (which today resolves to `postgres` since the
        // container runs as UID 70 — but explicit is cheaper than
        // relying on that coincidence).
        `postgresql://postgres@/postgres?host=${instance.socketDir}&port=${instance.port}`,
        '--no-owner',
        '--no-privileges',
        '--single-transaction',
      ],
    },
    dump,
    'pg_restore',
  );
}

async function computeManifestInInstance(instance: EphemeralInstance): Promise<Manifest> {
  // Use the unix socket to avoid the "listen_addresses" dance. Drizzle
  // is the same handle shape `computeManifest` already takes, so the
  // manifest logic is shared across source and ephemeral.
  const pool = new Pool({
    host: instance.socketDir,
    port: instance.port,
    // Same reason as probeSocket(): pin the role explicitly so we
    // don't rely on pg's process-uid → username fallback. initdb
    // created only `postgres`.
    user: 'postgres',
    database: 'postgres',
  });
  attachPoolErrorHandler(pool);
  // UTC is pinned server-side by the ephemeral cluster's `-c TimeZone=UTC`
  // (buildPostgresArgv), the default for every session on this throwaway
  // instance. The manifest needs it: `md5(row(t.*)::text)` in
  // computeManifest serializes `timestamptz` through the session TimeZone,
  // and any drift from the UTC-pinned source manifest is a false Tier 1
  // mismatch. Do NOT add a `pool.on('connect', …SET TIME ZONE…)` hook —
  // fire-and-forget races the first query on the same client (pg "already
  // executing a query" deprecation), and an awaited variant just
  // serializes every checkout for no gain over the cluster arg.
  try {
    const db = drizzle(pool, { schema });
    return await computeManifest(db);
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------
// Subprocess builders (run as the current uid — postgres in the container)
// ---------------------------------------------------------------

function buildInitdbCommand(dataDir: string): SubprocessCommand {
  return {
    cmd: 'initdb',
    args: ['-D', dataDir, '--auth=trust', '--username=postgres'],
  };
}

function buildPostgresArgv(dataDir: string, socketDir: string, port: number): SubprocessCommand {
  // TCP listener disabled; only local socket accepts connections. The
  // combination of `initdb --auth=trust` and a TCP listener was an open
  // security hole — anything that could reach 127.0.0.1:<port> inside
  // the container had a free superuser shell on the verify DB. With
  // listen_addresses set to the empty string postgres binds only the
  // unix socket in `socketDir`, and the peer-auth OS-user boundary is
  // the only gate. `-k <dir>` sets the socket directory.
  //
  // The value below has NO single quotes. In shell, you'd write
  // `-c listen_addresses=''` and the shell strips the quotes before
  // exec. Here we go through Node's `spawn()` which invokes execve()
  // directly — no shell, so the quotes would be passed through as
  // literal characters and postgres would try to resolve the hostname
  // `''`, fail with "could not translate host name", and abort on
  // "could not create any TCP/IP sockets" before the socket is ready.
  return {
    cmd: 'postgres',
    args: [
      '-D',
      dataDir,
      '-k',
      socketDir,
      '-p',
      String(port),
      '-c',
      'listen_addresses=',
      '-c',
      'fsync=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'synchronous_commit=off',
      // Force the ephemeral cluster's session TimeZone to UTC regardless
      // of the parent process env (the backup container sets
      // TZ=Europe/Berlin so cron log wakeups render in local time; initdb
      // would otherwise pick that up and the ephemeral session would
      // serialize `timestamptz` via `row(t.*)::text` as `+02` while the
      // live `db` container — which runs TimeZone=UTC — renders `+00`,
      // producing a false Tier 1 mismatch on any populated `timestamptz`
      // column). This server-side default is the single source of UTC
      // for every session on the ephemeral cluster — see the note in
      // computeManifestInInstance on why no per-connection hook is used.
      '-c',
      'TimeZone=UTC',
    ],
  };
}

// ---------------------------------------------------------------
// Port picking + readiness probe
// ---------------------------------------------------------------

/**
 * Bind :0 on loopback to get an OS-assigned free port, close the
 * listener, and return the port number. Postgres then binds to the same
 * port — a classic race but acceptable here because the ephemeral
 * instance is the only listener in the container at this point.
 */
async function pickFreePort(): Promise<number> {
  // Lazy import — avoid paying the cost when the function is not called.
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === 'object' && typeof addr.port === 'number') {
          resolve(addr.port);
        } else {
          reject(new Error('could not acquire a free loopback port'));
        }
      });
    });
  });
}

/**
 * Poll a unix-socket SELECT 1 until it succeeds, the timeout elapses,
 * or postgres exits early. A TCP probe is unusable here because the
 * instance is configured with `listen_addresses=''` (AC: C2 finding).
 */
async function waitForPostgresReady(
  socketDir: string,
  port: number,
  timeoutMs: number,
  earlyExit: () => Error | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const err = earlyExit();
    if (err) throw err;
    if (await probeSocket(socketDir, port)) return;
    await sleep(PG_READY_POLL_INTERVAL_MS);
  }
  const exitErr = earlyExit();
  if (exitErr) throw exitErr;
  throw new Error(`ephemeral postgres did not become ready within ${timeoutMs}ms`);
}

async function probeSocket(socketDir: string, port: number): Promise<boolean> {
  const pool = new Pool({
    host: socketDir,
    port,
    // initdb ran with `--username=postgres`, so `postgres` is the only
    // role that exists in the ephemeral cluster. Pin the role here
    // rather than rely on pg's `os.userInfo().username` fallback —
    // even though that fallback today resolves to `postgres` (the
    // container's USER), a future change to who runs the verify path
    // would silently flip every probe to "role 'X' does not exist"
    // and readiness would time out without a clear reason.
    user: 'postgres',
    database: 'postgres',
    // Short connection timeout so a single failed probe does not
    // consume the whole poll budget.
    connectionTimeoutMillis: 500,
  });
  attachPoolErrorHandler(pool);
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {
      /* best effort */
    });
  }
}

/**
 * Belt-and-suspenders: after readiness, confirm the TCP port is NOT
 * accepting connections. If it is, something overrode `listen_addresses`
 * and the --auth=trust instance is reachable over loopback — refuse to
 * continue rather than let the verify run on a misconfigured instance.
 */
async function assertTcpDisabled(port: number): Promise<void> {
  const reachable = await new Promise<boolean>((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
  if (reachable) {
    throw new Error(
      'ephemeral postgres is accepting TCP on 127.0.0.1:' +
        String(port) +
        " — listen_addresses='' was overridden; refusing to continue (C2 invariant)",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------

interface SubprocessCommand {
  cmd: string;
  args: ReadonlyArray<string>;
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort; a leftover tmp dir is noisy but not fatal.
  }
}

/**
 * Run a subprocess to completion. Resolves with `undefined` on exit
 * code 0; rejects with a typed Error carrying the stderr tail on any
 * other exit code or spawn error.
 */
function runSubprocess(command: SubprocessCommand, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command.cmd, [...command.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bound = boundRuntime(child);
    const stderr: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf-8'));
    });
    child.stdout?.on('data', () => {
      /* drain */
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
  });
}

/**
 * Like `runSubprocess` but pipes a byte buffer into the child's stdin.
 * Used for `pg_restore` where we stream the dump bytes in.
 */
function runSubprocessWithStdin(
  command: SubprocessCommand,
  stdin: Uint8Array,
  label: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command.cmd, [...command.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const bound = boundRuntime(child);
    const stderr: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf-8'));
    });
    child.stdout?.on('data', () => {
      /* drain */
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
    writeStdin(child, stdin);
  });
}
