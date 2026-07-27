/**
 * Layer 2 backup service — Tier 1 verify-on-create + upload.
 *
 * Implements verification.md §15.22 AC-165..AC-167, AC-169, AC-174
 * and ADR-0020. This service:
 *
 *   1. Computes the per-table manifest (row count + deterministic content
 *      checksum) inside a REPEATABLE READ read-only transaction. The
 *      checksum formula follows ADR-0020 §Decision verbatim so two runs
 *      on the same DB produce byte-equal manifests (AC-174).
 *   2. Exports that transaction's snapshot and runs `pg_dump -Fc
 *      --snapshot=<id>` inside it, so the dump and the manifest observe
 *      one DB state and an ordinary concurrent write cannot fake a
 *      Tier 1 mismatch (AC-344).
 *   3. Restores the dump into an ephemeral Postgres (spawned in-process
 *      via `initdb` + `postgres -k /tmp`) and recomputes the manifest to
 *      verify Tier 1 — mismatch fails the run, no upload (AC-165).
 *   4. Applies an optional test hook `manifestPerturb` to the restore-side
 *      manifest so integration tests can force a mismatch without having
 *      to stub pg_dump / initdb.
 *   5. Encrypts the dump + the manifest JSON via an injected `encrypt`
 *      function (production wires `age -r $AGE_RECIPIENT`; tests inject
 *      a fake). An encryption failure fails the run (AC-167).
 *   6. Uploads `daily/<iso>.dump.age` and `daily/<iso>.manifest.json.age`.
 *   7. Writes a status-mirror object carrying the same field values as
 *      the `meta_backup_status` row (AC-169). If the mirror write throws
 *      after the artifacts uploaded, the artifacts remain in place (R2
 *      immutability window) and the failure is recorded in `lastError`.
 *
 * Architecture layering (architecture.md §11.2): this service orchestrates
 * the repository (`backupStatus`) and the external-subprocess surface
 * (pg_dump, age, initdb). Routes never call the subprocesses directly.
 */

import { sql } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import type { Database, TransactionalDatabase } from '../db/connection.js';
import {
  getBackupStatus,
  updateBackupStatus,
  ensureBackupStatusRow,
  type BackupStatus,
} from '../repositories/backupStatus.js';

// ---------------------------------------------------------------
// Public contract types
// ---------------------------------------------------------------

/** Per-table manifest keyed by table name. See ADR-0020 §Decision. */
export type Manifest = Record<string, { rowCount: number; checksum: string }>;

/**
 * Normalized shape written to the status-mirror object. Unlike
 * `BackupStatus` which uses `undefined` for absent timestamps, the
 * mirror uses explicit `null` so the JSON-on-disk has stable keys and
 * can be round-tripped without ambiguity.
 */
export interface BackupStatusMirror {
  lastBackupAt: string | null;
  lastBackupOk: boolean;
  lastDrillAt: string | null;
  lastDrillOk: boolean | null;
  lastError: string | null;
  updatedAt: string;
}

/**
 * Upload surface consumed by the service. The production wiring is R2;
 * tests pass `makeStubUploader()` from the shared test harness.
 *
 * The `status` parameter of `putStatusMirror` is intentionally typed as
 * `unknown` to match the shared test harness's `BackupUploader` contract
 * (see `src/test/backupTestHarness.ts`) — this accommodates the storage
 * layer serializing an arbitrary payload shape. The runtime value is
 * always a `BackupStatusMirror`.
 */
export interface BackupUploader {
  upload(key: string, data: Uint8Array, contentType: string): Promise<void>;
  putStatusMirror(status: unknown): Promise<void>;
}

/**
 * Encryption surface. Async function that maps plaintext bytes to
 * ciphertext bytes. Production: spawn `age -r $AGE_RECIPIENT`. Tests:
 * `fakeEncrypt` from `src/test/backupTestHarness.ts`.
 */
export type Encryptor = (plaintext: Uint8Array) => Promise<Uint8Array>;

/**
 * Dump source. Production spawns `pg_dump -Fc` on the DATABASE_URL;
 * tests omit this and fall back to the manifest-bytes stand-in described
 * in `defaultDumpSource`. Exposed as an injection point so tests or
 * alternative implementations can substitute without pulling a process.
 *
 * `snapshotId` comes from `pg_export_snapshot()` on the still-open
 * manifest transaction. An implementation reading the DB MUST import it
 * so its view matches the source manifest (AC-344); one that fabricates
 * bytes may ignore it.
 *
 * Called while that transaction holds a pooled client, so an
 * implementation that checks out several clients of its own from the
 * same pool is a starvation risk. The production one is a subprocess
 * with its own connection.
 */
export type DumpSource = (snapshotId: string) => Promise<Uint8Array>;

/**
 * Ephemeral-DB verify surface. Production: restore the dump into a
 * freshly-`initdb`'d Postgres and recompute the manifest there. Tests:
 * omit this; the default uses the source-side DB so tests don't have to
 * stub subprocess orchestration.
 */
export type VerifyManifestFn = (dump: Uint8Array) => Promise<Manifest>;

export interface RunBackupOptions {
  db: Database;
  uploader: BackupUploader;
  encrypt: Encryptor;
  /** Run timestamp. Defaults to `new Date()`. */
  now?: Date;
  /**
   * Test hook. Applied to the restore-side manifest before comparing
   * to source. Defaults to identity (no perturbation). The tests use
   * this to force a mismatch without stubbing the ephemeral DB.
   */
  manifestPerturb?: (m: Manifest) => Manifest;
  /**
   * Injectable dump source, invoked with the manifest transaction's
   * exported snapshot id. When omitted, the service re-serializes the
   * manifest bytes as the "dump" — enough for integration tests that
   * only assert the upload surface. Production wiring passes
   * `pgDumpSource(databaseUrl)`.
   */
  dumpSource?: DumpSource;
  /**
   * Injectable verify. When omitted, the service re-reads the manifest
   * from the same DB connection used for source computation — the
   * integration-test default. Production wiring passes
   * `ephemeralPgVerify()` which runs real initdb + pg_restore.
   */
  verifyManifest?: VerifyManifestFn;
}

export type BackupRunResult =
  | { ok: true; manifest: Manifest; uploadedKeys: { dump: string; manifest: string } }
  | { ok: false; error: string; failedTable?: string };

// ---------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------

/**
 * Every public table covered by the manifest. The PK spec is load-bearing
 * for AC-174 — row ordering inside the checksum is driven by the primary
 * key, and composite PKs (`project_workers`, `invoice_sequence`) carry
 * their full PK column list. The order of `pkColumns` is stable so the
 * `ORDER BY` is deterministic.
 *
 * The set is exported so a structural-guard test (backup-manifest-
 * coverage.test.ts) can assert it matches the `public` schema's full
 * BASE TABLE list at runtime — a new table added to `schema.ts` without
 * a matching entry here fails CI rather than silently weakening the
 * Layer 2 integrity claim. Originally only six tables rode the
 * manifest; issue #230 expanded coverage to every public table now that
 * Layer 1 round-trips the full business-data set.
 */
export const MANIFEST_TABLES: ReadonlyArray<{
  name: string;
  pkColumns: ReadonlyArray<string>;
}> = [
  { name: 'attachments', pkColumns: ['id'] },
  { name: 'audit_log', pkColumns: ['id'] },
  { name: 'company_profile', pkColumns: ['id'] },
  { name: 'customers', pkColumns: ['id'] },
  { name: 'data_exchange_job', pkColumns: ['id'] },
  { name: 'invoice_sequence', pkColumns: ['year', 'kind'] },
  { name: 'invoices', pkColumns: ['id'] },
  { name: 'meta_backup_status', pkColumns: ['singleton'] },
  { name: 'notification_rule', pkColumns: ['id'] },
  { name: 'project_storage_usage', pkColumns: ['project_id'] },
  { name: 'project_workers', pkColumns: ['project_id', 'user_id'] },
  { name: 'projects', pkColumns: ['id'] },
  { name: 'push_subscriptions', pkColumns: ['id'] },
  { name: 'sessions', pkColumns: ['id'] },
  { name: 'users', pkColumns: ['id'] },
];

/**
 * Compute the per-table manifest in a single REPEATABLE READ transaction
 * so every table is observed in the same snapshot. The checksum formula
 * is the ADR-0020 canonical one:
 *
 *   md5(string_agg(md5(row(t.*)::text), '' ORDER BY <pk>))
 *
 * `row(t.*)::text` serializes the row in a deterministic column order so
 * two runs on the same data yield byte-equal md5 inputs (AC-174). Null
 * `string_agg` (empty table) becomes the empty string before outer md5.
 */
export async function computeManifest(db: TransactionalDatabase): Promise<Manifest> {
  const manifest: Manifest = {};
  for (const table of MANIFEST_TABLES) {
    const rowCountResult = await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS c FROM "${table.name}"`),
    );
    const rowCountRow = rowCountResult.rows[0] as { c: number } | undefined;
    const rowCount = rowCountRow?.c ?? 0;

    const orderBy = table.pkColumns.map((c) => `"${c}"`).join(', ');
    const checksumResult = await db.execute(
      sql.raw(
        `SELECT md5(COALESCE(string_agg(md5(row(t.*)::text), '' ORDER BY ${orderBy}), '')) AS checksum ` +
          `FROM "${table.name}" t`,
      ),
    );
    const checksumRow = checksumResult.rows[0] as { checksum: string } | undefined;
    const checksum = checksumRow?.checksum ?? '';

    manifest[table.name] = { rowCount, checksum };
  }
  return manifest;
}

/**
 * Execute a full Tier 1 backup run. See module header.
 */
export async function runBackup(opts: RunBackupOptions): Promise<BackupRunResult> {
  const now = opts.now ?? new Date();
  const perturb = opts.manifestPerturb ?? ((m: Manifest) => m);

  // Safety net: if the migration hasn't pre-seeded the row on this DB,
  // ensure it exists before the upsert path runs. Idempotent.
  await ensureBackupStatusRow(opts.db);

  // ---------------------------------------------------------------
  // Source manifest + dump — one REPEATABLE READ snapshot, exported to
  // the dump so both observe the same DB state (AC-344). The
  // transaction has to outlive the dump: an exported snapshot is
  // importable only until the transaction that exported it ends.
  // ---------------------------------------------------------------
  let sourceManifest: Manifest;
  let dump: Uint8Array;
  try {
    ({ manifest: sourceManifest, dump } = await opts.db.transaction(
      async (tx) => {
        // Pin the transaction's session TimeZone to UTC. The manifest
        // checksum is `md5(row(t.*)::text)`, which serializes
        // `timestamptz` values through the session's TimeZone setting
        // — if the live `db` container's default ever drifts from UTC
        // (or if this function is ever invoked from a process whose
        // libpq client picked up a non-UTC default), the source
        // manifest would silently diverge from the ephemeral verify
        // side (which is pinned to UTC in `ephemeralPg.ts`). `SET
        // LOCAL` scopes the change to this transaction so we never
        // leak a TimeZone mutation back to the pooled connection.
        await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);

        // A REPEATABLE READ transaction keeps one snapshot for its whole
        // lifetime, so what is exported here and what `computeManifest`
        // reads below are the same view by construction — the order of
        // the two is free.
        const exported = await tx.execute(sql`SELECT pg_export_snapshot() AS id`);
        const snapshotId = (exported.rows[0] as { id: string } | undefined)?.id;
        if (!snapshotId) {
          throw new Error('pg_export_snapshot() returned no snapshot id');
        }

        const manifest = await computeManifest(tx);
        const dumpSource = opts.dumpSource ?? (async () => defaultDumpSource(manifest));

        // Awaited inside the transaction on purpose. Committing once the
        // dump is merely spawned would race its `SET TRANSACTION
        // SNAPSHOT`, and there is no clean signal for "the dump has
        // attached" short of polling `pg_stat_activity`.
        //
        // Cost: this holds the cluster's xmin horizon back until the
        // dump finishes. `pg_dump` pins it for its own duration either
        // way; the fix only extends that pin backwards across the
        // manifest scan.
        return { manifest, dump: await dumpSource(snapshotId) };
      },
      {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      },
    ));
  } catch (err) {
    const message = errorMessage(err);
    await updateBackupStatus(opts.db, {
      lastBackupAt: now.toISOString(),
      lastBackupOk: false,
      lastError: `source-capture: ${message}`,
    });
    return { ok: false, error: `source-capture: ${message}` };
  }

  // ---------------------------------------------------------------
  // Tier 1 verify. `verifyManifest` runs the dump through the ephemeral
  // DB in production; the integration-test default reads the source DB
  // a second time so the perturbation hook can simulate drift.
  // ---------------------------------------------------------------
  let restoreManifest: Manifest;
  try {
    const verify = opts.verifyManifest ?? (async () => computeManifest(opts.db));
    restoreManifest = await verify(dump);
  } catch (err) {
    const message = errorMessage(err);
    await updateBackupStatus(opts.db, {
      lastBackupAt: now.toISOString(),
      lastBackupOk: false,
      lastError: `verify: ${message}`,
    });
    return { ok: false, error: `verify: ${message}` };
  }

  const perturbed = perturb(restoreManifest);
  const mismatch = firstDivergingTable(sourceManifest, perturbed);
  if (mismatch) {
    await updateBackupStatus(opts.db, {
      lastBackupAt: now.toISOString(),
      lastBackupOk: false,
      lastError: `tier-1-mismatch on ${mismatch}`,
    });
    // AC-165: no upload, no mirror write. Status row carries the cue.
    return { ok: false, error: `tier-1-mismatch on ${mismatch}`, failedTable: mismatch };
  }

  // ---------------------------------------------------------------
  // Encrypt + upload. Encryption failure = no upload at all (AC-167).
  // ---------------------------------------------------------------
  let dumpCipher: Uint8Array;
  let manifestCipher: Uint8Array;
  try {
    dumpCipher = await opts.encrypt(dump);
    manifestCipher = await opts.encrypt(new TextEncoder().encode(JSON.stringify(sourceManifest)));
  } catch (err) {
    const message = errorMessage(err);
    await updateBackupStatus(opts.db, {
      lastBackupAt: now.toISOString(),
      lastBackupOk: false,
      lastError: `encrypt: ${message}`,
    });
    return { ok: false, error: `encrypt: ${message}` };
  }

  const iso = now.toISOString();
  const dumpKey = `daily/${iso}.dump.age`;
  const manifestKey = `daily/${iso}.manifest.json.age`;

  try {
    await opts.uploader.upload(dumpKey, dumpCipher, 'application/octet-stream');
    await opts.uploader.upload(manifestKey, manifestCipher, 'application/octet-stream');
  } catch (err) {
    const message = errorMessage(err);
    await updateBackupStatus(opts.db, {
      lastBackupAt: now.toISOString(),
      lastBackupOk: false,
      lastError: `upload: ${message}`,
    });
    return { ok: false, error: `upload: ${message}` };
  }

  // ---------------------------------------------------------------
  // Dual-write: primary DB row AND status mirror (AC-169). If the
  // mirror write fails after artifacts landed, artifacts remain and
  // `lastError` records the mirror failure (orphan-artifact semantics).
  // ---------------------------------------------------------------
  await updateBackupStatus(opts.db, {
    lastBackupAt: now.toISOString(),
    lastBackupOk: true,
    lastError: null,
  });
  const postUpsertStatus = await getBackupStatus(opts.db);

  try {
    await opts.uploader.putStatusMirror(toMirror(postUpsertStatus));
  } catch (err) {
    const message = errorMessage(err);
    await updateBackupStatus(opts.db, {
      lastError: `mirror: ${message}`,
    });
    // The backup artifacts uploaded successfully; only the mirror
    // failed. Report success with a populated `lastError` via the
    // status row, mirroring AC-169.
    return {
      ok: true,
      manifest: sourceManifest,
      uploadedKeys: { dump: dumpKey, manifest: manifestKey },
    };
  }

  return {
    ok: true,
    manifest: sourceManifest,
    uploadedKeys: { dump: dumpKey, manifest: manifestKey },
  };
}

// ---------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------

/**
 * Integration-test default: serialize the manifest as the "dump". This
 * is sufficient for AC-165/166/167 — tests only inspect the upload
 * surface, not the dump's Postgres-binary structure. Production replaces
 * this via `opts.dumpSource = pgDumpSource(databaseUrl)`.
 */
function defaultDumpSource(manifest: Manifest): Uint8Array {
  // Prefix with a stable marker so future log-side inspection can tell
  // this synthetic dump apart from a real pg_dump artifact.
  const payload = `MANIFEST-DUMP\n${JSON.stringify(manifest)}`;
  return new TextEncoder().encode(payload);
}

/**
 * Compare source vs restore manifest table-by-table. Returns the first
 * table name whose row count or checksum diverges — the cue piped into
 * `lastError` so operators can triage without parsing the manifest.
 */
function firstDivergingTable(source: Manifest, restore: Manifest): string | null {
  const allTables = new Set([...Object.keys(source), ...Object.keys(restore)]);
  // Iterate in a stable order so the "first diverging" table is
  // deterministic across runs.
  const sorted = [...allTables].sort();
  for (const table of sorted) {
    const s = source[table];
    const r = restore[table];
    if (!s || !r) return table;
    if (s.rowCount !== r.rowCount) return table;
    if (s.checksum !== r.checksum) return table;
  }
  return null;
}

/**
 * Extract a string message from an unknown throwable and scrub any
 * credential-shaped substrings. Every call site that writes to
 * `meta_backup_status.lastError` (which is returned to the owner via
 * the `backupStatus` field on `GET /api/auth/me`) goes through this —
 * defense in depth against a future throw path that includes a
 * connection string or similar.
 */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown';
  return sanitizeErrorMessage(raw);
}

/**
 * Convert a `BackupStatus` into the explicit-null mirror shape. Keeps
 * the mirror object's JSON stable across runs — same keys always
 * present, never a mix of missing / null.
 */
function toMirror(status: BackupStatus): BackupStatusMirror {
  return {
    lastBackupAt: status.lastBackupAt ?? null,
    lastBackupOk: status.lastBackupOk,
    lastDrillAt: status.lastDrillAt ?? null,
    lastDrillOk: status.lastDrillOk,
    lastError: status.lastError ?? null,
    updatedAt: status.updatedAt,
  };
}

// ---------------------------------------------------------------
// Production wiring for pg_dump + age + ephemeral Postgres.
//
// These are exported so the production entry point (a small bin/backup
// CLI owned by the infra stream) can wire them. Tests do not exercise
// these paths directly — they're thin wrappers over the platform
// binaries and offer no behavior worth unit-testing. The contract is:
// "a non-zero exit code maps to a typed failure, never an untyped throw".
// ---------------------------------------------------------------

/**
 * How long `pg_dump` may wait for a table lock before it gives up and
 * fails the run. Milliseconds — the one format every server version
 * accepts for `--lock-wait-timeout`.
 *
 * Bounded on purpose, and load-bearing. The manifest transaction holds
 * ACCESS SHARE on every table while it waits for the dump, so an ACCESS
 * EXCLUSIVE request arriving in that window (deploy migration, VACUUM
 * FULL, REINDEX, TRUNCATE) queues behind it — and pg_dump's own ACCESS
 * SHARE then queues behind that. Postgres documents this exact shape as
 * "a classic deadlock situation", but the cycle closes through this
 * process rather than the DB, so the deadlock detector never sees it.
 * Unbounded, pg_dump waits forever, the transaction never commits, and
 * croner's `protect: true` suppresses every later tick — a silent,
 * permanent backup outage. Failing is the cheap outcome: the run is
 * recorded failed and the next tick retries.
 */
const PG_DUMP_LOCK_WAIT_TIMEOUT_MS = 30_000;

/**
 * argv for the production dump. `--snapshot` makes pg_dump read the
 * manifest transaction's snapshot instead of taking its own (AC-344);
 * the id is an opaque token from `pg_export_snapshot()`, passed as an
 * argv element — no shell, so no interpolation surface.
 *
 * Split out of `pgDumpSource` so a test can pin both flags without
 * spawning the binary: drop either one and the failure is silent, with
 * every DB-level test still green.
 */
export function pgDumpArgs(snapshotId: string): string[] {
  return ['-Fc', `--snapshot=${snapshotId}`, `--lock-wait-timeout=${PG_DUMP_LOCK_WAIT_TIMEOUT_MS}`];
}

/**
 * Production dump source: spawn `pg_dump` with discrete libpq env
 * vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE) parsed from
 * DATABASE_URL. Never shell-interpolates the connection string — args
 * stay empty of credentials AND we deliberately do NOT forward
 * DATABASE_URL itself into the subprocess env. Rationale: when libpq
 * hits a connection error it echoes the full conninfo it tried; if the
 * conninfo came from DATABASE_URL the password appears in that echo,
 * which bubbles up through stderr into `lastError` on the status row —
 * a string that is returned by a public status endpoint. Discrete vars
 * are read natively by libpq and their values do not appear in the
 * error surface.
 */
export function pgDumpSource(databaseUrl: string): DumpSource {
  return async (snapshotId: string) => {
    const pg = parsePgEnv(databaseUrl);
    // Start from a clean env that strips DATABASE_URL and legacy PG*
    // values (which might hold a previous password). Only forward
    // PATH-like basics the child needs.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.DATABASE_URL;
    Object.assign(childEnv, pg);
    return spawnCollect('pg_dump', pgDumpArgs(snapshotId), {
      env: childEnv,
      sanitizeSubstrings: [pg.PGPASSWORD].filter(
        (s): s is string => typeof s === 'string' && s.length > 0,
      ),
    });
  };
}

/**
 * Parse a `postgresql://user:password@host:port/dbname` URL into discrete
 * libpq env vars. Throws on a malformed URL — the caller should catch
 * and route the failure into a typed `BackupRunResult.error`.
 *
 * Only the libpq-relevant subset is extracted; additional query-string
 * parameters (sslmode, options) are ignored here because the current
 * deployment topology does not use them. If that changes, expand this
 * parser rather than plumbing DATABASE_URL through.
 */
export function parsePgEnv(databaseUrl: string): {
  PGHOST: string;
  PGPORT: string;
  PGUSER: string;
  PGPASSWORD: string;
  PGDATABASE: string;
} {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use postgresql:// scheme');
  }
  const database = url.pathname.replace(/^\//, '');
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
  };
}

/**
 * Strip credential-like substrings from an error message before it is
 * persisted to `meta_backup_status.lastError` or returned from a public
 * endpoint. Applied defensively on every path that writes `lastError`.
 *
 * Patterns covered:
 *   - `postgresql://user:password@host` — replaces with
 *     `postgresql://<redacted>@host`
 *   - query-string `password=...` — replaces the value with `<redacted>`
 *   - literal substrings supplied via `knownSecrets` — replaces with
 *     `<redacted>` (used to scrub PGPASSWORD and similar)
 *
 * Returns a safe fallback when the raw message is empty/missing.
 */
export function sanitizeErrorMessage(
  raw: string,
  knownSecrets: ReadonlyArray<string> = [],
): string {
  if (!raw) return '<no error message>';
  let out = raw;
  // postgresql://user:password@host → postgresql://<redacted>@host
  out = out.replace(/\b(postgres(?:ql)?:\/\/)[^\s:@/]*:[^\s@/]*@/gi, '$1<redacted>@');
  // libpq conninfo form `password=X` (whitespace-delimited) and URL
  // query form `?password=X` / `&password=X`. Both appear in real
  // error surfaces.
  out = out.replace(/\b(password|pwd)=([^&\s]*)/gi, '$1=<redacted>');
  // Literal known-secret substitution — strips any accidental appearance
  // of the current password even outside a URL/query context. Sorted
  // longest-first so a shorter secret that is a substring of a longer
  // one does not partially mask it.
  const secrets = [...knownSecrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    // Escape regex metacharacters in the literal secret.
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '<redacted>');
  }
  return out;
}

/**
 * Production encryption: `age -r <recipient>` over stdin. The recipient
 * is a public key — safe to embed in container env. Identity material
 * (private) is NEVER read here; decryption lives in `backup-drill.ts`.
 */
export function ageEncrypt(recipient: string): Encryptor {
  if (!recipient) {
    // Fail fast — do NOT fall back to plaintext. Refuse-to-serve semantics
    // per CLAUDE.md "Data integrity, security and quality defaults are
    // the baseline, not open questions".
    throw new Error('AGE_RECIPIENT is empty — refusing to produce plaintext artifacts');
  }
  return async (plaintext: Uint8Array) => {
    return spawnCollect('age', ['-r', recipient], { stdin: plaintext });
  };
}

interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: Uint8Array;
  /**
   * Literal substrings to strip from captured stderr before it lands in
   * the rejection Error. Used by the pg_dump path to defensively scrub
   * PGPASSWORD in case a future libpq build decides to echo it.
   */
  sanitizeSubstrings?: ReadonlyArray<string>;
}

/**
 * Run a subprocess, pipe plaintext into stdin (if provided), collect
 * stdout, and resolve to the stdout bytes. Non-zero exit or spawn error
 * rejects with an Error carrying the exit code and a stderr cue —
 * callers turn this into a typed `BackupRunResult.error`.
 */
function spawnCollect(
  cmd: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions = {},
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(new Uint8Array(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(new Uint8Array(chunk));
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        const rawErrText = Buffer.concat(stderr).toString('utf-8').trim();
        const errText = sanitizeErrorMessage(rawErrText, options.sanitizeSubstrings ?? []);
        // `cmd` is safe to include; stdin is NEVER echoed — critical for
        // the encrypt path where the plaintext is the dump.
        reject(new Error(`${cmd} exited with code ${code}: ${errText}`));
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

    if (options.stdin) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}
