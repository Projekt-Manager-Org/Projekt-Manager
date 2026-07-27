/**
 * Drive the production `ephemeralPgVerify()` against a real pg_dump
 * artifact — inside the shipped backup image, where `initdb`, `postgres`
 * and `pg_restore` actually exist.
 *
 * Covers verification.md §15.22 AC-165 / AC-166 [crit] on the production
 * path. The host suite (`src/server/__tests__/ephemeral-pg.test.ts`) can
 * only pin the argv and the subprocess seams: the Postgres server
 * binaries ship in Dockerfile.backup and nowhere else, and they are
 * Alpine-musl builds, so a PGDG glibc install on a runner would exercise
 * different packaging. This file is the other half — the one that runs
 * them. Invoked by `scripts/backup/verify-roundtrip.sh`, not by vitest;
 * see #301 for why it is not a `npm run test` case.
 *
 *   node verify-tier1-artifact.mjs <dump-path> <expected-manifest-path>
 *
 * `<dump-path>` is a decrypted `pg_dump -Fc` artifact and
 * `<expected-manifest-path>` its decrypted manifest sidecar — i.e. the
 * SOURCE manifest that `runBackup` computed and uploaded. Comparing the
 * two closes the loop that `runBackup` closes internally, except here the
 * comparison is visible and its failure is attributable.
 *
 * Two arms, both required:
 *
 *   1. The artifact restores and the recomputed manifest equals the
 *      source manifest. Asserted table by table so a divergence names the
 *      table, and gated on the fixture rows actually being present —
 *      every checksum on an empty database is md5(''), which makes
 *      equality hold for a restore that produced nothing.
 *   2. A corrupted artifact is REJECTED, with `pg_restore`'s own reason.
 *      This is AC-165's failure branch reached through the real binary
 *      rather than through `manifestPerturb`. Without it arm 1 alone
 *      cannot distinguish "verify works" from "verify always agrees".
 *
 * Exit 0 = both arms held. Non-zero = the failure, on stderr.
 */

import { readFile } from 'node:fs/promises';

// The SHIPPED BUNDLE, not a source module. `build:server` esbuilds
// backup-runner.ts with `--bundle`, so the image holds exactly one
// `dist/server/backup-runner.js` — `services/ephemeralPg.js` does not
// exist in there. backup-runner.ts re-exports `ephemeralPgVerify` for this
// caller; importing the bundle has no side effects (its `main()` is behind
// an `import.meta.url` guard).
//
// Importing the bundle rather than the source is the stronger test anyway:
// it covers the wiring the container actually runs, not just the module.
//
// Absolute path because this file is bind-mounted in from the repo, so a
// relative specifier would resolve against the mount point.
const { ephemeralPgVerify } = await import('/app/dist/server/backup-runner.js');

const [dumpPath, manifestPath] = process.argv.slice(2);
if (!dumpPath || !manifestPath) {
  process.stderr.write('usage: verify-tier1-artifact.mjs <dump-path> <expected-manifest-path>\n');
  process.exit(2);
}

function fail(message) {
  process.stderr.write(`verify-tier1-artifact: ${message}\n`);
  process.exit(1);
}

const dump = new Uint8Array(await readFile(dumpPath));
const expected = JSON.parse(await readFile(manifestPath, 'utf-8'));

// `pg_dump -Fc` custom-format archives start with the literal `PGDMP`.
// Checked here as well as in the shell caller because everything below
// depends on this being an archive at all: a truncated download or a
// failed decrypt would otherwise surface as an opaque pg_restore error.
if (Buffer.from(dump.subarray(0, 5)).toString('latin1') !== 'PGDMP') {
  fail(`${dumpPath} does not start with the PGDMP archive magic`);
}

// ---------------------------------------------------------------
// Arm 1 — the artifact restores, and the manifest agrees
// ---------------------------------------------------------------

// A fresh `ephemeralPgVerify()` per call, matching production: the
// returned function spawns its own instance and tears it down, so the two
// arms below cannot contaminate each other.
const restored = await ephemeralPgVerify()(dump);

const expectedTables = Object.keys(expected).sort();
const restoredTables = Object.keys(restored).sort();
if (expectedTables.join(',') !== restoredTables.join(',')) {
  fail(
    `manifest table sets differ\n  source:  ${expectedTables.join(', ')}\n  restored: ${restoredTables.join(', ')}`,
  );
}

for (const table of expectedTables) {
  const want = expected[table];
  const got = restored[table];
  if (want.rowCount !== got.rowCount || want.checksum !== got.checksum) {
    fail(
      `manifest diverges on "${table}"\n` +
        `  source:   rowCount=${want.rowCount} checksum=${want.checksum}\n` +
        `  restored: rowCount=${got.rowCount} checksum=${got.checksum}`,
    );
  }
}

// Non-vacuity gate. Every checksum on an empty table is md5(''), so a
// restore that produced nothing satisfies the loop above for every table.
// The seed (verify-roundtrip-seed.sql) populates these four; if the rows
// are missing here, the comparison proved nothing and the run is a
// failure, not a pass.
const SEEDED_TABLES = ['audit_log', 'customers', 'invoice_sequence', 'projects', 'users'];
const empty = SEEDED_TABLES.filter((t) => (restored[t]?.rowCount ?? 0) === 0);
if (empty.length > 0) {
  fail(
    `restored manifest has no rows in ${empty.join(', ')} — ` +
      'the fixture seed did not reach the artifact, so manifest equality is vacuous',
  );
}

process.stdout.write(
  `verify-tier1-artifact: restore matches the source manifest across ${expectedTables.length} tables ` +
    `(users=${restored.users.rowCount}, audit_log=${restored.audit_log.rowCount})\n`,
);

// ---------------------------------------------------------------
// Arm 2 — a corrupted artifact is rejected (AC-165 failure branch)
// ---------------------------------------------------------------

// Corrupt the archive header rather than appending garbage: pg_dump's
// custom format is a container of compressed blocks, and trailing junk in
// a block can be silently ignored. Flipping the magic guarantees
// pg_restore refuses at the point it validates the archive, which is the
// real "the bytes in the bucket are not a backup" shape.
const corrupt = new Uint8Array(dump);
corrupt[0] ^= 0xff;

let rejection = null;
try {
  await ephemeralPgVerify()(corrupt);
} catch (err) {
  rejection = err;
}

if (rejection === null) {
  fail('a corrupted artifact was ACCEPTED — Tier 1 cannot detect a bad backup');
}

const reason = rejection instanceof Error ? rejection.message : String(rejection);
// The label is what `runBackup` prefixes into
// `meta_backup_status.lastError` as `verify: pg_restore exited 1: …`. A
// rejection that does not carry it means the run failed for some other
// reason — a missing binary, a readiness timeout — and this arm would
// pass without ever testing the corruption path.
if (!/pg_restore (exited|failed to spawn)/.test(reason)) {
  fail(`corrupted artifact was rejected, but not by pg_restore: ${reason}`);
}

process.stdout.write(`verify-tier1-artifact: corrupted artifact rejected — ${reason}\n`);
