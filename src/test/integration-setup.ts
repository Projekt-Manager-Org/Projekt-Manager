/**
 * Per-fork test environment isolation for the vitest `integration` project.
 *
 * Four concerns share this file because all must run BEFORE any test
 * imports — the per-fork DB, the per-fork binary `age` identity (ADR-0024
 * / AC-239), the per-fork storage namespace and the per-fork takeout
 * staging directory are all consumed by the route layer via `process.env`,
 * and the route layer is reached on the first `startApp()` call which
 * re-parses env each time.
 *
 * 1. Per-fork DATABASE_URL
 *    Without this, every fork connects to whatever DATABASE_URL points at
 *    — typically the developer's `projekt_manager`. Each test's `startApp()`
 *    then calls `seed(force: true)` which `TRUNCATE CASCADE`s users /
 *    sessions / customers / projects. Two parallel runs (different
 *    worktrees, different agents, dev session in another window) race each
 *    other's TRUNCATE: one's reseed lands while the other is mid-test, so
 *    `ownerToken` gets invalidated and subsequent requests return 401.
 *
 *    The fix: each fork gets its own database, named after its PID.
 *
 *    Cleanup of dropped DBs lives in `integration-globalsetup.ts` — the
 *    vitest `forks` pool exits workers via `process.exit()`, which skips
 *    `beforeExit`, so a per-fork drop hook would unreliably leak.
 *
 *    Symmetric with the e2e fix in `a24ef66` (`projekt_manager_e2e`), but
 *    one-DB-per-process so multiple agents don't collide either.
 *
 * 2. Per-fork binary `age` identity (ADR-0024 / AC-239)
 *    The route's `download-url` and `bulk-fetch` paths unwrap each row's
 *    `wrapped_dek` against an operator-loaded binary `age` identity at
 *    `BINARY_AGE_IDENTITY_PATH`; the configured `BINARY_AGE_RECIPIENT`
 *    must match the identity's public half. Tests that drive these
 *    paths need a real, unwrappable envelope — synthetic 192-byte
 *    placeholders fail at the AEAD step under any real implementation.
 *
 *    Each fork generates its own keypair, writes the identity (private
 *    half) to a per-PID tmpfs path, and exports both env vars before any
 *    test import runs. Test seeds wrap a fresh DEK against this same
 *    keypair via `KeyEnvelopeService.wrap()` so the route's per-request
 *    unwrap succeeds for happy-path arms (B1 in the failing-tests
 *    review).
 *
 *    `age-keygen` is required on the dev box per CONTRIBUTING.md
 *    §Testing — same posture as MinIO.
 *
 * 3. Per-fork storage namespace (STORAGE_BUCKET + STORAGE_KEY_PREFIX)
 *    Without this, every integration fork shares `STORAGE_BUCKET=
 *    projekt-manager` (the dev bucket) and writes attachment / invoice
 *    binaries against it. Each fork drops its per-PID DB at end-of-run,
 *    but the bucket objects survive (no FK from bucket to DB) — and the
 *    next `scripts/sync-dev-to-vps.sh` either trips its pollution guard
 *    or, worse, mirrors the test debris onto B2 under Compliance Object
 *    Lock retention. That's how 9000+ orphan invoice binaries accumulated
 *    in the dev bucket prior to this fix (see fix/deploy-2026-05-16
 *    branch history).
 *
 *    Fix: route the suite at the isolated `projekt-manager-test` bucket
 *    (provisioned by docker/init-storage.sh alongside the e2e bucket),
 *    and namespace each fork's writes under `test-<pid>/` so parallel
 *    forks don't share a keyspace. Storage client + `pruneBucketOrphans`
 *    honour the prefix transparently — callers continue to read/write
 *    bare logical keys.
 *
 *    Dead-PID prefix cleanup lives in `integration-globalsetup.ts` for
 *    the same `process.exit()` reason as the DB cleanup. Live forks are
 *    untouched.
 *
 * 4. Per-fork takeout staging directory (TAKEOUT_STAGING_DIR)
 *    Without this, every fork stages export/import archives in the shared
 *    default (`os.tmpdir()/projekt-manager-takeout`) — the same directory a
 *    zero-config dev boot uses.
 *
 *    Nothing sweeps the leftovers. Every delete on this path is keyed off a
 *    `data_exchange_job` row: the create-time pre-sweep, the TTL reaper and
 *    the boot reaper all rebuild the filename from (kind, id) and unlink
 *    that one file (`takeout-staging.ts`). When the fork's per-PID database
 *    is dropped at end-of-run, any artifact still `ready` loses the only row
 *    that referenced it and becomes unreachable garbage. 756 orphaned zips
 *    had accumulated locally before this fix — the same failure the storage
 *    namespace above was written to close, on the one resource that did not
 *    get the treatment.
 *
 *    Fix: give each fork `projekt-manager-takeout-test-<pid>`. The `-test-`
 *    infix is load-bearing — it keeps the sweep's pattern from ever matching
 *    the bare `projekt-manager-takeout` a developer's own dev server uses.
 *    No mkdir here: `probeStagingDurability` and the export builder both
 *    `mkdir -p` before first write.
 *
 *    Dead-PID directory cleanup lives in `integration-globalsetup.ts`,
 *    same `process.exit()` reason as the two above.
 */

import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------
// 1. Per-fork DATABASE_URL
// ---------------------------------------------------------------------

const TEST_DB_PREFIX = 'projekt_manager_test_';

const baseUrl =
  process.env.DATABASE_URL ?? 'postgresql://pm:changeme@localhost:5432/projekt_manager';
const adminUrl = (() => {
  const u = new URL(baseUrl);
  u.pathname = '/postgres';
  return u.toString();
})();
const dbName = `${TEST_DB_PREFIX}${process.pid}`;
const perProcessUrl = (() => {
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  try {
    await client.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    // 42P04 = duplicate_database. A stale PID-recycled DB is fine —
    // seed(force: true) in api-helpers wipes it on first startApp().
    if ((err as NodeJS.ErrnoException).code !== '42P04') throw err;
  }
} finally {
  await client.end();
}

process.env.DATABASE_URL = perProcessUrl;

// ---------------------------------------------------------------------
// 2. Per-fork binary `age` identity
// ---------------------------------------------------------------------

const binaryIdentityPath = path.join(
  os.tmpdir(),
  `projekt-manager-binary-identity-${process.pid}.txt`,
);

// Generate the keypair — `age-keygen` writes the private half to stdout
// and emits a `Public key: …` line on stderr; we ignore the stderr noise
// (per-fork log spam during test runs) and re-derive the public half
// cleanly via `age-keygen -y`.
const binaryIdentity = execFileSync('age-keygen', {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
const binaryRecipient = execFileSync('age-keygen', ['-y'], {
  input: binaryIdentity,
  encoding: 'utf-8',
  stdio: ['pipe', 'pipe', 'ignore'],
}).trim();

// Mode 0600 — the boot probe (`assertBinaryIdentityLoaded`) will read
// it back; production tmpfs uses 0400 with a privileged loader, but
// the test fork is its own loader so the writable bit on the owner is
// fine. Per-PID filename keeps parallel forks from trampling each other.
writeFileSync(binaryIdentityPath, binaryIdentity + '\n', { mode: 0o600 });

process.env.BINARY_AGE_RECIPIENT = binaryRecipient;
process.env.BINARY_AGE_IDENTITY_PATH = binaryIdentityPath;

// Best-effort cleanup. The `forks` pool exits workers via `process.exit()`
// (mirrors the DB-cleanup rationale above), so `process.on('exit', ...)`
// is the most reliable hook. Tmpfs eviction is the fallback when the
// hook is skipped. PID-suffix filenames make per-fork collisions unlikely.
process.on('exit', () => {
  try {
    unlinkSync(binaryIdentityPath);
  } catch {
    // Already gone or never written — nothing to clean.
  }
});

// ---------------------------------------------------------------------
// 3. Per-fork storage namespace
// ---------------------------------------------------------------------

// Honour the operator override when set — `.env` may already pin this to
// a different bucket name. Default to `projekt-manager-test` to match
// docker/init-storage.sh and docker-compose.minio.yml.
process.env.STORAGE_BUCKET = process.env.STORAGE_BUCKET_TEST ?? 'projekt-manager-test';
// `test-<pid>/` is the per-fork namespace inside the shared test bucket.
// Shape matches the STORAGE_KEY_PREFIX schema in `config/env.ts`
// (`^[a-z0-9][a-z0-9_-]*\/$`).
process.env.STORAGE_KEY_PREFIX = `test-${process.pid}/`;

// ---------------------------------------------------------------------
// 4. Per-fork takeout staging directory
// ---------------------------------------------------------------------

// Honour an operator override when set — `.env` may already pin this
// somewhere other than the OS temp dir. Otherwise namespace per PID so
// forks never share a staging keyspace and the sweep can tell a dead
// fork's directory from a live one's.
process.env.TAKEOUT_STAGING_DIR =
  process.env.TAKEOUT_STAGING_DIR_TEST ??
  path.join(os.tmpdir(), `projekt-manager-takeout-test-${process.pid}`);
