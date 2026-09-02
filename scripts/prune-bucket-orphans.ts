/**
 * Operator-run bucket/DB reconciliation (issue #169 item A).
 *
 * Lists the configured attachment bucket, diffs it against the keys
 * referenced by the `attachments` table, and reports — or, with
 * `--apply`, hides — the difference. The diff logic lives in
 * `src/server/storage/pruneBucketOrphans.ts`; this file is only the
 * env/db/storage bootstrap and the CLI surface.
 *
 * Why an operator command and not a scheduled sweeper: orphans arise
 * from two narrow paths (the takeout import runner and the invoice
 * renderer, both of which PUT bytes before inserting their row), not
 * continuously. A cron sweeper would add a scheduler, a cadence, sanity
 * caps and alerting to catch an event that a human already knows the
 * timing of. The permanent fix is to reorder those two writes — #169
 * item B — after which this command is a backstop, not a dependency.
 *
 * Usage:
 *   npm run storage:prune              # dry run — report only, no writes
 *   npm run storage:prune -- --apply   # hide the reported orphans
 *
 * Exit codes: 0 on success, 2 on an unknown argument.
 *
 * Safety: dry run is the default, and it issues no mutating call at all.
 * `--apply` hides orphans via `storage.hide()` — a delete marker, not a
 * destroy: the app key cannot destroy versions (ADR-0022), so a hidden
 * object stays recoverable for the bucket's R-day Object Lock window.
 */

import {
  validateEnvRuntime,
  assertAppServerEnv,
  type AppServerEnv,
} from '../src/server/config/env.js';
import { createDatabase } from '../src/server/db/connection.js';
import { createStorageClient } from '../src/server/storage/client.js';
import {
  pruneBucketOrphans,
  createBucketKeyLister,
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
          '  npm run storage:prune              dry run — report only, no writes',
          '  npm run storage:prune -- --apply   hide the reported orphans',
          '',
          'Orphans are hidden (delete marker), never destroyed: the app key',
          'lacks the destroy capability (ADR-0022), so the bucket lifecycle',
          'reaps them after the configured window and the un-hide flow can',
          'lift a marker until then.',
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
  const result = await pruneBucketOrphans(
    db,
    createStorageClient({ ...listerConfig, publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT }),
    createBucketKeyLister(listerConfig),
    { info: (m) => console.log(m), warn: (m) => console.warn(m) },
    env.STORAGE_BUCKET,
    apply,
  );

  // The keys are the reviewable part of a dry run — a count alone tells
  // the operator nothing about whether the diff is trustworthy.
  for (const key of result.orphanKeys) {
    console.log(`  ${apply ? 'hidden' : 'orphan'}: ${key}`);
  }
} finally {
  await pool.end();
}
