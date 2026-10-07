/**
 * Sweep orphans before and after the integration suite — per-PID test
 * databases (`projekt_manager_test_<pid>`), per-PID test bucket key
 * prefixes (`test-<pid>/`), per-PID takeout staging directories
 * (`projekt-manager-takeout-test-<pid>`) and per-PID binary `age`
 * identities (`projekt-manager-binary-identity-<pid>.txt`). "Orphan" =
 * the PID encoded in the name is no longer alive. Active runs from other
 * agents/worktrees survive.
 *
 * Runs in the main vitest process (forks/workers have not been spawned
 * yet at setup time and have already exited by teardown time), so it
 * cannot create the per-fork DB / prefix itself — those live in
 * `integration-setup.ts`. The teardown side is what reliably reaps this
 * run's forks: vitest's `forks` pool exits each worker via
 * `process.exit()`, which skips `beforeExit`, so a per-fork cleanup hook
 * is not viable.
 *
 * The main process does not get the `.env` values vitest hands the
 * workers via `test.env`, so every sweep reads its config from
 * `project.config.env` (loadEnv output, which already includes
 * `process.env`) — never from `process.env` directly.
 *
 * Bucket sweep uses DeleteObject without VersionId — Compliance Object
 * Lock allows that (it stacks a delete marker on top of the retained
 * version). The underlying bytes survive until the lifecycle rule
 * (`STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS`, default 2 days) reaps them.
 * For the pollution-check semantic (current-version `mc ls`), delete
 * markers are enough; disk reclamation is automatic.
 */

import pg from 'pg';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { TestProject } from 'vitest/node';

type SweepEnv = Partial<Record<string, string>>;

// What this sweeper matches on. Exported so
// `src/server/__tests__/test-harness-isolation.test.ts` can assert that what
// `integration-setup.ts` WRITES is what this file REAPS. The two run in
// separate processes and cannot share a value at runtime, so the names are
// duplicated literals — drift between them silently disables cleanup, with no
// failing test and no symptom beyond a temp dir that grows forever. Nothing
// but that test imports these.
export const TEST_DB_PREFIX = 'projekt_manager_test_';
export const TEST_KEY_PREFIX_PATTERN = /^test-(\d+)\/$/;
// Anchored, and the `-test-` infix is required — `projekt-manager-takeout`
// (the zero-config dev default, and what a developer's own server writes to)
// must never match. A prefix-only check would delete real dev exports.
export const TEST_TAKEOUT_DIR_PATTERN = /^projekt-manager-takeout-test-(\d+)$/;
// Anchored on both ends, and the PID group is mandatory — only files this
// suite creates in `integration-setup.ts` §2 can match. An operator-loaded
// production identity lives on tmpfs at a configured path, never here.
export const TEST_BINARY_IDENTITY_PATTERN = /^projekt-manager-binary-identity-(\d+)\.txt$/;

function adminConnectionString(env: SweepEnv): string {
  const baseUrl = env.DATABASE_URL ?? 'postgresql://pm:changeme@localhost:5432/projekt_manager';
  const u = new URL(baseUrl);
  u.pathname = '/postgres';
  return u.toString();
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but owned by another user — leave it alone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function sweepOrphanDatabases(env: SweepEnv): Promise<void> {
  const client = new pg.Client({ connectionString: adminConnectionString(env) });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${TEST_DB_PREFIX}%`],
    );
    for (const { datname } of rows) {
      const pid = Number.parseInt(datname.slice(TEST_DB_PREFIX.length), 10);
      if (isPidAlive(pid)) continue;
      try {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [datname],
        );
        await client.query(`DROP DATABASE IF EXISTS "${datname}"`);
      } catch {
        // Best-effort. Another concurrent sweeper may have raced us.
      }
    }
  } finally {
    await client.end();
  }
}

/**
 * Sweep dead-PID `test-<pid>/` prefixes in the integration-test bucket.
 *
 * Lists with `Delimiter: '/'` so we get the top-level prefixes
 * (`CommonPrefixes`) cheaply — listing each fork's full keyspace would
 * be O(objects) instead of O(forks). Then, per dead-PID prefix, paginate
 * through ListObjectsV2 + DeleteObject to delete-marker every key.
 *
 * Throws when storage is not configured: globalSetup runs only for the
 * integration project, which needs MinIO anyway, and a skipped sweep
 * strands dead prefixes silently (#481).
 */
export async function sweepOrphanStoragePrefixes(env: SweepEnv): Promise<void> {
  const endpoint = env.STORAGE_ENDPOINT;
  const accessKey = env.STORAGE_ACCESS_KEY;
  const secretKey = env.STORAGE_SECRET_KEY;
  const bucket = env.STORAGE_BUCKET_TEST ?? 'projekt-manager-test';
  const region = env.STORAGE_REGION ?? 'us-east-1';
  if (!endpoint || !accessKey || !secretKey) {
    throw new Error(
      'Integration globalSetup: STORAGE_ENDPOINT, STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY ' +
        'must be set to sweep dead-PID test-bucket prefixes.',
    );
  }

  const s3 = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });

  // Step 1: enumerate top-level prefixes via the delimiter trick.
  const deadPrefixes: string[] = [];
  let continuationToken: string | undefined;
  do {
    // No catch: a missing bucket, bad credentials or an unreachable
    // endpoint must surface, not skip — the suite needs the bucket anyway.
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Delimiter: '/',
        ContinuationToken: continuationToken,
      }),
    );
    for (const cp of response.CommonPrefixes ?? []) {
      if (typeof cp.Prefix !== 'string') continue;
      const match = TEST_KEY_PREFIX_PATTERN.exec(cp.Prefix);
      if (!match) continue;
      const pid = Number.parseInt(match[1] ?? '', 10);
      if (isPidAlive(pid)) continue;
      deadPrefixes.push(cp.Prefix);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  // Step 2: per dead-PID prefix, walk + delete-marker.
  for (const prefix of deadPrefixes) {
    let token: string | undefined;
    do {
      let page;
      try {
        page = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
      } catch {
        break; // Best-effort.
      }
      for (const obj of page.Contents ?? []) {
        if (typeof obj.Key !== 'string') continue;
        try {
          // DeleteObject without VersionId — Compliance-safe.
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
        } catch {
          // Best-effort per key; another sweeper may have raced.
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

/**
 * Sweep dead-PID per-fork artifacts under the OS temp root:
 *
 *   - `projekt-manager-takeout-test-<pid>/`      staging directories
 *   - `projekt-manager-binary-identity-<pid>.txt` binary `age` identities
 *
 * Unlike the bucket sweep there is no metadata to reconcile — each artifact
 * belongs wholly to one fork, so a dead PID means it is unreachable.
 *
 * Both need sweeping here for the same reason the database does: the `forks`
 * pool tears workers down by signal, so neither `beforeExit` nor the
 * `process.on('exit')` unlink in `integration-setup.ts` §2 reliably fires.
 * Measured: a full 179-file run leaked 105 identity files with that hook in
 * place. They are age private keys — test-only and mode 0600, but a keyfile
 * accumulating unbounded in a shared temp root is not something to leave to
 * a hook that demonstrably does not run.
 *
 * One `readdir` serves both patterns; scanning the temp root twice for two
 * regexes would be the same walk done twice.
 *
 * When an operator has pinned TAKEOUT_STAGING_DIR_TEST the per-PID naming
 * does not apply and nothing here matches — that directory is theirs to
 * manage, by the same logic as the STORAGE_BUCKET_TEST override.
 */
async function sweepOrphanTempArtifacts(): Promise<void> {
  const tmpRoot = os.tmpdir();
  let entries;
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch {
    // No temp root to read — nothing to sweep.
    return;
  }

  for (const entry of entries) {
    const pattern = entry.isDirectory()
      ? TEST_TAKEOUT_DIR_PATTERN
      : entry.isFile()
        ? TEST_BINARY_IDENTITY_PATTERN
        : null;
    if (!pattern) continue;
    const match = pattern.exec(entry.name);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? '', 10);
    if (isPidAlive(pid)) continue;
    try {
      await rm(path.join(tmpRoot, entry.name), { recursive: true, force: true });
    } catch {
      // Best-effort. Another concurrent sweeper may have raced us.
    }
  }
}

async function sweepOrphans(env: SweepEnv): Promise<void> {
  await Promise.all([
    sweepOrphanDatabases(env),
    sweepOrphanStoragePrefixes(env),
    sweepOrphanTempArtifacts(),
  ]);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const env = project.config.env;
  await sweepOrphans(env);
  return async () => {
    await sweepOrphans(env);
  };
}
