/**
 * On-demand bucket/DB reconciliation (issue #169 item A).
 *
 * Lists the configured attachment bucket, diffs it against the keys
 * referenced by the `attachments` table, and reports — or, with
 * `--apply`, hides — the difference. The diff logic and both safety
 * guards live in `src/server/storage/pruneBucketOrphans.ts`; this file
 * is only the env/db/storage bootstrap and the CLI surface.
 *
 * The scheduled sweep in the app process
 * (`src/server/bucket-orphan-prune-scheduler.ts`) is the production
 * surface — it runs unattended against the bucket and database that
 * process already owns. This command is for looking at the diff on
 * demand, or forcing a pass off-cadence, from a repo checkout. The
 * deployed image ships neither `scripts/` nor `tsx`, so it does not run
 * there; use the scheduler's log lines instead.
 *
 * Because a checkout is told which bucket and which database to pair,
 * and can be told wrong, `requireReferencedRows` is on: a run that
 * would preserve nothing out of a non-empty bucket refuses before the
 * first hide. `STORAGE_PRUNE_MIN_AGE_MINUTES` applies here too.
 *
 * Usage:
 *   npm run storage:prune              # report only, no writes
 *   npm run storage:prune -- --apply   # hide the reported orphans
 *
 * Exit codes: 0 on success, 1 on a refusal or fault, 2 on an unknown
 * argument.
 */

import { STORAGE_CONFIG } from '../src/server/config/index.js';
import {
  validateEnvRuntime,
  assertAppServerEnv,
  type AppServerEnv,
} from '../src/server/config/env.js';
import { createDatabase } from '../src/server/db/connection.js';
import { createStorageClient } from '../src/server/storage/client.js';
import {
  pruneBucketOrphans,
  createBucketObjectLister,
} from '../src/server/storage/pruneBucketOrphans.js';

const args = process.argv.slice(2);
let apply = false;

for (const arg of args) {
  switch (arg) {
    case '--apply':
      apply = true;
      break;
    case '-h':
    case '--help':
      console.log(
        [
          'Reconcile the attachment bucket against the attachments table.',
          '',
          '  npm run storage:prune              report only, no writes',
          '  npm run storage:prune -- --apply   hide the reported orphans',
          '',
          'Objects younger than STORAGE_PRUNE_MIN_AGE_MINUTES are left alone —',
          'two writers PUT bytes before inserting their row, so a fresh object',
          'with no row may simply be mid-write.',
          '',
          'Refuses to apply when no listed object is referenced at all: that is',
          'a bucket/database mismatch, not a dirty bucket.',
          '',
          'Orphans are hidden (delete marker), never destroyed: the app key',
          'lacks the destroy capability (ADR-0022), so the bucket lifecycle',
          'reaps them after the configured window.',
        ].join('\n'),
      );
      process.exit(0);
    // eslint-disable-next-line no-fallthrough -- process.exit above is terminal
    default:
      console.error(`ERROR: unknown argument: ${arg}`);
      console.error('Run with --help for usage.');
      process.exit(2);
  }
}

const env: AppServerEnv = (() => {
  const parsed = validateEnvRuntime();
  // Narrows STORAGE_* to non-nullable, exactly as start.ts does before
  // building the storage client. A missing credential fails here with
  // the shared message rather than as a confusing SDK error mid-listing.
  assertAppServerEnv(parsed);
  return parsed;
})();

const listerConfig = {
  endpoint: env.STORAGE_ENDPOINT,
  bucket: env.STORAGE_BUCKET,
  accessKey: env.STORAGE_ACCESS_KEY,
  secretKey: env.STORAGE_SECRET_KEY,
  region: env.STORAGE_REGION,
  keyPrefix: env.STORAGE_KEY_PREFIX,
};

const { db, pool } = createDatabase();

try {
  const result = await pruneBucketOrphans({
    db,
    storage: createStorageClient({ ...listerConfig, publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT }),
    listBucketObjects: createBucketObjectLister(listerConfig),
    logger: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
    bucketLabel: env.STORAGE_BUCKET,
    apply,
    minAgeMinutes: env.STORAGE_PRUNE_MIN_AGE_MINUTES ?? STORAGE_CONFIG.pruneMinAgeMinutes,
    requireReferencedRows: true,
  });

  // On an apply run the prune already logged each key as it hid it.
  // A report run has printed nothing per-key, and the keys are the
  // reviewable part — a bare count says nothing about whether the diff
  // is trustworthy.
  if (!apply) {
    for (const key of result.orphanKeys) {
      console.log(`  orphan: ${key}`);
    }
  }
} finally {
  await pool.end();
}
