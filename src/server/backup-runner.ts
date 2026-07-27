/**
 * Layer 2 backup CLI entry point.
 *
 * Subcommands:
 *   node /app/dist/server/backup-runner.js schedule
 *     — Container entrypoint. Registers the cron schedule via croner
 *       (ADR-0020 §Decision) and runs forever as PID 1. Replaces the
 *       former `dcron` + `scripts/backup/run-*.sh` shell layer (#199).
 *   node /app/dist/server/backup-runner.js run
 *     — One-shot manual backup cycle (operator-invoked).
 *   node /app/dist/server/backup-runner.js drill
 *     — One-shot manual Tier 2 drill (operator-invoked).
 *
 * `schedule` does an R2 `HeadBucket` probe at startup so a stale
 * credential surfaces as a deploy-time failure (visible) rather than a
 * silently missed cron tick an hour later. The probe used to live in
 * `scripts/backup/probe-r2.mjs` invoked by the entrypoint shell; it is
 * folded in here so the container has a single Node boot path.
 *
 * Exit codes:
 *   0   ok; drill skipped (per AC-168 skip != failure)
 *   1   failed; env missing; unknown internal error; schedule startup probe failed
 *   2   usage error (unknown subcommand)
 *
 * `schedule` does not exit under normal operation — it runs until
 * SIGTERM/SIGINT, then drains in-flight ticks and exits 0.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { validateEnvRuntime, type Env } from './config/env.js';
import { createDatabase, type Database } from './db/connection.js';
import {
  runBackup,
  pgDumpSource,
  ageEncrypt,
  sanitizeErrorMessage,
  LOCK_WAIT_TIMEOUT_MS,
  type BackupUploader,
  type DumpSource,
  type Encryptor,
  type VerifyManifestFn,
} from './services/backup.js';
import { runDrill } from './services/backup-drill.js';
import { boundRuntime, writeStdin } from './services/subprocessBound.js';
import { ephemeralPgVerify } from './services/ephemeralPg.js';
import {
  createR2Uploader,
  createR2Downloader,
  probeR2HeadBucket,
  type BackupDownloader,
  type R2Config,
} from './services/r2Uploader.js';

/**
 * Re-exported so the shipped bundle exposes it.
 *
 * `build:server` esbuilds this file with `--bundle`, so the image holds
 * one `dist/server/backup-runner.js` and no per-module files — there is no
 * `services/ephemeralPg.js` to import inside the container. The Tier 1
 * container round-trip (`scripts/backup/verify-tier1-artifact.mjs`, #301)
 * drives the real `initdb` / `pg_restore` path, which exists only in that
 * image, so it needs a handle on this function from the bundle.
 *
 * Same reason `SCHEDULES` / `buildScheduleJobs` below are exported: this
 * file is the only entry point into the backup surface, so anything a test
 * must reach has to be reachable through it. Importing this module has no
 * side effects — `main()` runs only under the `import.meta.url` guard at
 * the bottom.
 */
export { ephemeralPgVerify };

const USAGE =
  'usage: backup-runner <run|drill|schedule|--help>\n' +
  '  run       — execute one Layer 2 backup cycle (pg_dump + Tier 1 verify + encrypt + upload)\n' +
  '  drill     — execute one Tier 2 drill (download + decrypt + verify against manifest)\n' +
  '  schedule  — register the cron schedule and run forever (container entrypoint)\n';

async function main(): Promise<number> {
  const subcommand = process.argv[2];

  if (subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  // Fail early on an unknown subcommand — a typo at the container entry
  // should be obvious, not silently tracked as "success".
  if (subcommand !== 'run' && subcommand !== 'drill' && subcommand !== 'schedule') {
    process.stderr.write(USAGE);
    return 2;
  }

  // Env validation — reuses the app's schema. The backup-specific keys
  // are declared there with the right defaults (AGE_IDENTITY_PATH etc.).
  const env = validateEnvRuntime();

  if (subcommand === 'run') return runSubcommand(env);
  if (subcommand === 'drill') return drillSubcommand(env);
  return scheduleSubcommand(env);
}

// ---------------------------------------------------------------
// `run` — full Layer 2 cycle (one-shot)
// ---------------------------------------------------------------

async function runSubcommand(env: Env): Promise<number> {
  const { db, pool } = createDatabase({ lockTimeoutMs: LOCK_WAIT_TIMEOUT_MS });
  try {
    const handler = createBackupHandler(buildBackupDeps(env, db));
    const exitCode = await handler();
    return exitCode;
  } finally {
    await shutdown(pool);
  }
}

// ---------------------------------------------------------------
// `drill` — Tier 2 verify-on-cycle (one-shot)
// ---------------------------------------------------------------

async function drillSubcommand(env: Env): Promise<number> {
  const { db, pool } = createDatabase({ lockTimeoutMs: LOCK_WAIT_TIMEOUT_MS });
  try {
    const handler = createDrillHandler(buildDrillDeps(env, db));
    const exitCode = await handler();
    return exitCode;
  } finally {
    await shutdown(pool);
  }
}

// ---------------------------------------------------------------
// `schedule` — register cron jobs and run until SIGTERM/SIGINT
// ---------------------------------------------------------------

/**
 * Cron expressions for the four registered jobs. Pulled out for tests
 * to assert pattern correctness against the canonical schedule in
 * ADR-0020 / the former `scripts/backup/crontab`.
 *
 * Times are Europe/Berlin local — croner reads `timezone:` and uses
 * the JS runtime's IANA `Intl` API. `node:22-alpine` bundles full ICU
 * + tzdata, so the OS-level `tzdata` apk package is no longer needed.
 * If the base image ever switches to a slim runtime without ICU,
 * croner will silently fall back to UTC and the schedule will drift
 * by an hour twice a year — see Dockerfile.backup for the guard.
 */
export const SCHEDULES = {
  backupWeekday: '0 9,12,15,18,21 * * 1-5',
  backupWeekend: '0 12 * * 6,0',
  drillWeekday: '2 9,12,15,18,21 * * 1-5',
  drillWeekend: '2 12 * * 6,0',
} as const;

export const SCHEDULE_TZ = 'Europe/Berlin';

export interface ScheduleHandlers {
  /** Resolves with the per-tick exit code (informational; not used by croner). */
  backupHandler: () => Promise<number>;
  drillHandler: () => Promise<number>;
}

/**
 * Build the four croner jobs the production schedule registers.
 * Exported so tests can assert pattern + TZ + dispatch wiring without
 * spinning up a real DB or R2.
 *
 * `protect: true` is croner's in-process equivalent of the former
 * `flock` in `run-backup.sh` — a tick that runs long blocks the next
 * tick from starting rather than queuing or racing. Pre-iteration-7
 * we used `flock -n` from bash; the semantics here are identical with
 * one fewer external dep.
 *
 * `mode: '5-part'` pins the parser to standard five-field cron format
 * (minute hour dom month dow). croner's default "auto" mode would also
 * accept it but pinning makes a stray space or typo fail loudly rather
 * than parse as a different layout.
 */
export function buildScheduleJobs(handlers: ScheduleHandlers): Cron[] {
  const common = { timezone: SCHEDULE_TZ, protect: true, mode: '5-part' as const };
  return [
    new Cron(
      SCHEDULES.backupWeekday,
      { ...common, name: 'backup-weekday' },
      // croner expects void | Promise<void>; the handlers return a
      // numeric exit code for the one-shot subcommands' sake. Throw
      // away the number here — the per-tick log line is the operator
      // signal in schedule mode.
      async () => {
        await handlers.backupHandler();
      },
    ),
    new Cron(SCHEDULES.backupWeekend, { ...common, name: 'backup-weekend' }, async () => {
      await handlers.backupHandler();
    }),
    new Cron(SCHEDULES.drillWeekday, { ...common, name: 'drill-weekday' }, async () => {
      await handlers.drillHandler();
    }),
    new Cron(SCHEDULES.drillWeekend, { ...common, name: 'drill-weekend' }, async () => {
      await handlers.drillHandler();
    }),
  ];
}

async function scheduleSubcommand(env: Env): Promise<number> {
  // Startup R2 probe — folds in former `scripts/backup/probe-r2.mjs`.
  // Run BEFORE opening the DB pool so the failure mode on a stale
  // credential is a fast container restart, not a "pool open then
  // schedule never ticks" silent partial-startup.
  const r2 = requireR2(env, 'schedule');
  try {
    await probeR2HeadBucket(r2);
  } catch (err) {
    process.stderr.write(`backup-runner: schedule: ${errorMessage(err)}\n`);
    return 1;
  }
  process.stdout.write(`backup-runner: schedule: R2 reachable bucket=${r2.bucket}\n`);

  const { db, pool } = createDatabase({ lockTimeoutMs: LOCK_WAIT_TIMEOUT_MS });

  const backupHandler = createBackupHandler(buildBackupDeps(env, db));
  const drillHandler = createDrillHandler(buildDrillDeps(env, db));
  const jobs = buildScheduleJobs({ backupHandler, drillHandler });

  // Per-job next-tick log line — mirrors the spirit of dcron's NOTICE
  // wakeup lines so operators tailing `docker compose logs backup` can
  // confirm the schedule is loaded.
  for (const job of jobs) {
    const next = job.nextRun();
    process.stdout.write(
      `backup-runner: schedule: registered ${job.name ?? '<unnamed>'} next=${
        next?.toISOString() ?? 'none'
      }\n`,
    );
  }

  // Graceful shutdown — SIGTERM arrives from `docker stop` with a
  // 10s grace period before SIGKILL. Stop scheduling new ticks, wait
  // for in-flight ticks to drain (capped so we don't get SIGKILL'd
  // mid-pool-end), close the pool, exit cleanly.
  let shuttingDown = false;
  const stopAndExit = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`backup-runner: schedule: ${signal} received, draining\n`);
    for (const job of jobs) job.stop();
    const drainDeadline = Date.now() + 9000;
    while (jobs.some((j) => j.isBusy()) && Date.now() < drainDeadline) {
      await sleep(100);
    }
    await shutdown(pool);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stopAndExit('SIGTERM'));
  process.on('SIGINT', () => void stopAndExit('SIGINT'));

  // croner's internal setTimeout keeps the event loop alive; this
  // Promise never resolves. Process exits via `stopAndExit` above.
  return new Promise<number>(() => {});
}

// ---------------------------------------------------------------
// Per-tick handlers — shared by one-shot subcommands and schedule
// ---------------------------------------------------------------

interface BackupHandlerDeps {
  db: Database;
  uploader: BackupUploader;
  dumpSource: DumpSource;
  verifyManifest: VerifyManifestFn;
  encrypt: Encryptor;
}

function buildBackupDeps(env: Env, db: Database): BackupHandlerDeps {
  const r2 = requireR2(env, 'run');
  const recipient = requireEnv(env.AGE_RECIPIENT, 'AGE_RECIPIENT', 'run');
  return {
    db,
    uploader: createR2Uploader(r2),
    dumpSource: pgDumpSource(env.DATABASE_URL),
    verifyManifest: ephemeralPgVerify(),
    encrypt: ageEncrypt(recipient),
  };
}

/**
 * Wraps `runBackup` with the log lines + exit-code mapping the bash
 * `run-backup.sh` and dcron pipeline used to provide. Shared by the
 * one-shot `run` subcommand AND each schedule tick.
 *
 * Errors are caught and logged — schedule mode must survive a single
 * crashed tick rather than tear the container down. The one-shot path
 * returns the resulting non-zero exit code so cron-like callers can
 * still see "did this run succeed?" via process exit.
 */
function createBackupHandler(deps: BackupHandlerDeps): () => Promise<number> {
  return async () => {
    try {
      const result = await runBackup({
        db: deps.db,
        uploader: deps.uploader,
        dumpSource: deps.dumpSource,
        verifyManifest: deps.verifyManifest,
        encrypt: deps.encrypt,
        now: new Date(),
      });
      if (result.ok) {
        process.stdout.write(
          `backup-runner: run ok dump=${result.uploadedKeys.dump} manifest=${result.uploadedKeys.manifest}\n`,
        );
        return 0;
      }
      process.stderr.write(
        `backup-runner: run failed reason=${JSON.stringify(result.error)}` +
          (result.failedTable ? ` failedTable=${result.failedTable}` : '') +
          '\n',
      );
      return 1;
    } catch (err) {
      process.stderr.write(`backup-runner: run unexpected error: ${errorMessage(err)}\n`);
      return 1;
    }
  };
}

interface DrillHandlerDeps {
  db: Database;
  downloader: BackupDownloader;
  verifyManifest: VerifyManifestFn;
  identityPath: string;
}

function buildDrillDeps(env: Env, db: Database): DrillHandlerDeps {
  const r2 = requireR2(env, 'drill');
  return {
    db,
    downloader: createR2Downloader(r2),
    verifyManifest: ephemeralPgVerify(),
    identityPath: env.AGE_IDENTITY_PATH,
  };
}

function createDrillHandler(deps: DrillHandlerDeps): () => Promise<number> {
  return async () => {
    try {
      // M5 audit finding: guard against an operator typo that would
      // point AGE_IDENTITY_PATH at a sensitive system file or escape
      // via `..` into the host FS. Refuse loudly rather than pass a
      // wild path through to `age -d -i`.
      assertIdentityPathUnderTmpfs(deps.identityPath);

      // AC-168 — the drill service needs `expectedManifest` up front,
      // but the downloader "must not be called when key is absent."
      // Check ourselves, short-circuit to the skip branch.
      const identityPresent = await isIdentityPresentAndNonEmpty(deps.identityPath);
      let dumpCipher: Uint8Array | null = null;
      let manifestPlain: Uint8Array | null = null;
      if (identityPresent) {
        const downloaded = await deps.downloader.downloadLatestDumpAndManifest();
        dumpCipher = downloaded.dump;
        manifestPlain = await ageDecrypt(downloaded.manifest, deps.identityPath);
      }
      const expectedManifest =
        manifestPlain !== null
          ? (JSON.parse(Buffer.from(manifestPlain).toString('utf-8')) as Record<
              string,
              { rowCount: number; checksum: string }
            >)
          : undefined;

      const result = await runDrill({
        db: deps.db,
        identityPath: deps.identityPath,
        downloadLatestDump: async () => {
          if (dumpCipher === null) {
            throw new Error('dump not downloaded — drill key was absent');
          }
          return dumpCipher;
        },
        decrypt: async (ciphertext, idPath) => ageDecrypt(ciphertext, idPath),
        verifyManifest: deps.verifyManifest,
        expectedManifest,
        now: new Date(),
      });

      if (result.outcome === 'ok') {
        process.stdout.write('backup-runner: drill ok\n');
        return 0;
      }
      if (result.outcome === 'skipped') {
        process.stdout.write(`backup-runner: drill skipped reason=${result.reason ?? 'unknown'}\n`);
        return 0;
      }
      process.stderr.write(
        `backup-runner: drill failed reason=${result.reason ?? 'unknown'}` +
          (result.mismatchedTable ? ` mismatchedTable=${result.mismatchedTable}` : '') +
          '\n',
      );
      return 1;
    } catch (err) {
      // `age -d` today does not echo the identity path, but a future
      // age release might. Scrub credential-shaped strings (via
      // sanitizeErrorMessage) AND any literal substring matching the
      // tmpfs identity prefix before logging. Defense in depth.
      const raw = errorMessage(err);
      const scrubbed = sanitizeErrorMessage(raw).replace(
        /\/run\/drill-key\/[^\s"'`]*/g,
        '<redacted-identity-path>',
      );
      process.stderr.write(`backup-runner: drill unexpected error: ${scrubbed}\n`);
      return 1;
    }
  };
}

// ---------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------

function requireR2(env: Env, subcommand: string): R2Config {
  return {
    endpoint: requireEnv(env.R2_ENDPOINT, 'R2_ENDPOINT', subcommand),
    bucket: requireEnv(env.R2_BUCKET, 'R2_BUCKET', subcommand),
    accessKeyId: requireEnv(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID', subcommand),
    secretAccessKey: requireEnv(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY', subcommand),
    region: env.R2_REGION,
  };
}

function requireEnv(value: string | undefined, name: string, subcommand: string): string {
  if (!value) {
    throw new Error(`backup-runner ${subcommand}: ${name} is required but not set`);
  }
  return value;
}

/** Prefix that AGE_IDENTITY_PATH must resolve under (M5 audit). */
const DRILL_TMPFS_PREFIX = '/run/drill-key/';

function assertIdentityPathUnderTmpfs(identityPath: string): void {
  const resolved = path.resolve(identityPath);
  const underPrefix =
    resolved === DRILL_TMPFS_PREFIX.slice(0, -1) || resolved.startsWith(DRILL_TMPFS_PREFIX);
  if (!underPrefix) {
    throw new Error(
      `AGE_IDENTITY_PATH must resolve under ${DRILL_TMPFS_PREFIX} ` +
        `(got ${JSON.stringify(resolved)})`,
    );
  }
}

async function isIdentityPresentAndNonEmpty(identityPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(identityPath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// age decrypt (spawns `age -d -i <identityPath>` on stdin)
// ---------------------------------------------------------------

function ageDecrypt(ciphertext: Uint8Array, identityPath: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn('age', ['-d', '-i', identityPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const bound = boundRuntime(child);
    const stdout: Uint8Array[] = [];
    const stderr: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(new Uint8Array(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf-8'));
    });
    child.once('error', (err) => {
      bound.release();
      reject(new Error(`age -d failed to spawn: ${err.message}`));
    });
    child.once('close', (code) => {
      bound.release();
      // AC-345: a hung decrypt must fail the drill, not park the tick.
      if (bound.expired()) {
        reject(bound.error('age -d'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`age -d exited ${code}: ${stderr.join('').trim()}`));
        return;
      }
      const total = stdout.reduce((acc, c) => acc + c.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of stdout) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(out);
    });
    writeStdin(child, ciphertext);
  });
}

// ---------------------------------------------------------------
// Common
// ---------------------------------------------------------------

async function shutdown(pool: { end(): Promise<void> }): Promise<void> {
  try {
    await pool.end();
  } catch {
    // Best-effort cleanup. If we got here the runner is already exiting.
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only execute the CLI when invoked directly (`node backup-runner.js …`).
// Importing this file for unit tests must NOT kick off env validation
// or process.exit, otherwise the test runner dies on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`backup-runner: fatal: ${errorMessage(err)}\n`);
      process.exit(1);
    });
}
