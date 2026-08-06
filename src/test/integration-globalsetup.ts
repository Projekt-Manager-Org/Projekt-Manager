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

const TEST_DB_PREFIX = 'projekt_manager_test_';
const TEST_KEY_PREFIX_PATTERN = /^test-(\d+)\/$/;
// Anchored, and the `-test-` infix is required — `projekt-manager-takeout`
// (the zero-config dev default, and what a developer's own server writes to)
// must never match. A prefix-only check would delete real dev exports.
const TEST_TAKEOUT_DIR_PATTERN = /^projekt-manager-takeout-test-(\d+)$/;
// Anchored on both ends, and the PID group is mandatory — only files this
// suite creates in `integration-setup.ts` §2 can match. An operator-loaded
// production identity lives on tmpfs at a configured path, never here.
const TEST_BINARY_IDENTITY_PATTERN = /^projekt-manager-binary-identity-(\d+)\.txt$/;

function adminConnectionString(): string {
  const baseUrl =
    process.env.DATABASE_URL ?? 'postgresql://pm:changeme@localhost:5432/projekt_manager';
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

async function sweepOrphanDatabases(): Promise<void> {
  const client = new pg.Client({ connectionString: adminConnectionString() });
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
 * No-ops cleanly when the env doesn't have storage configured (the
 * unit-test slice of vitest doesn't need MinIO) — no STORAGE_ENDPOINT,
 * no sweep.
 */
async function sweepOrphanStoragePrefixes(): Promise<void> {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const accessKey = process.env.STORAGE_ACCESS_KEY;
  const secretKey = process.env.STORAGE_SECRET_KEY;
  const bucket = process.env.STORAGE_BUCKET_TEST ?? 'projekt-manager-test';
  const region = process.env.STORAGE_REGION ?? 'us-east-1';
  if (!endpoint || !accessKey || !secretKey) return;

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
    let response;
    try {
      response = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Delimiter: '/',
          ContinuationToken: continuationToken,
        }),
      );
    } catch {
      // Bucket may not exist yet (first-time fresh MinIO). Nothing to
      // sweep — the configure step in init-storage.sh will provision it
      // when the dev compose stack comes up.
      return;
    }
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

async function sweepOrphans(): Promise<void> {
  await Promise.all([
    sweepOrphanDatabases(),
    sweepOrphanStoragePrefixes(),
    sweepOrphanTempArtifacts(),
  ]);
}

export default async function setup(): Promise<() => Promise<void>> {
  await sweepOrphans();
  return async () => {
    await sweepOrphans();
  };
}
