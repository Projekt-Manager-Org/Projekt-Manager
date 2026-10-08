/**
 * Binary recovery tool — CLI (AC-373 / AC-374). Runs on the operator
 * workstation; needs no database.
 *
 *   npx tsx scripts/binary-key/recover-objects.ts \
 *     --identity <path> --since <ISO 8601> --out <dir> [--key <object key>]
 *
 * Storage comes from env: STORAGE_ENDPOINT, STORAGE_BUCKET,
 * STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY (the read-only recovery key),
 * optional STORAGE_REGION / STORAGE_KEY_PREFIX.
 *
 * `--since` must carry an explicit offset (`Z` or `±hh:mm`) — an
 * offset-less time would be read as workstation-local and shift the
 * cutoff.
 *
 * Writes `<out>/index.json` plus one plaintext per recovered version.
 * Exit 0: every version recovered. Exit 1: at least one failed (see the
 * index). Exit 2: usage error. Exit 3: the run aborted (listing denied,
 * network, identity unreadable) — no index written.
 *
 * Runbooks: docs/ops/binary-key/drills.md, docs/ops/backup/recovery.md.
 */

import { parseArgs } from 'node:util';
import { recoverObjects } from '../../src/server/storage/recoverObjects.js';

const EXIT_FAILED_VERSIONS = 1;
const EXIT_USAGE = 2;
const EXIT_ABORTED = 3;
const EXPLICIT_OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;

function usage(message: string): never {
  console.error(`recover-objects: ${message}`);
  console.error(
    'usage: recover-objects --identity <path> --since <ISO 8601> --out <dir> [--key <key>]',
  );
  process.exit(EXIT_USAGE);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) usage(`${name} is not set`);
  return value;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      identity: { type: 'string' },
      since: { type: 'string' },
      out: { type: 'string' },
      key: { type: 'string' },
    },
  });
  if (!values.identity || !values.since || !values.out) {
    usage('--identity, --since and --out are required');
  }
  if (!EXPLICIT_OFFSET.test(values.since)) {
    usage(`--since needs an explicit offset (Z or ±hh:mm): ${values.since}`);
  }
  const since = new Date(values.since);
  if (Number.isNaN(since.getTime())) usage(`--since is not a date: ${values.since}`);

  const result = await recoverObjects({
    storage: {
      endpoint: requireEnv('STORAGE_ENDPOINT'),
      bucket: requireEnv('STORAGE_BUCKET'),
      accessKey: requireEnv('STORAGE_ACCESS_KEY'),
      secretKey: requireEnv('STORAGE_SECRET_KEY'),
      region: process.env.STORAGE_REGION || undefined,
      keyPrefix: process.env.STORAGE_KEY_PREFIX || undefined,
    },
    identityPath: values.identity,
    since,
    ...(values.key ? { key: values.key } : {}),
    outDir: values.out,
  });

  for (const entry of result.entries.filter((e) => e.outcome === 'failed')) {
    console.error(`FAILED ${entry.key} @ ${entry.versionId}: ${entry.error}`);
  }
  console.error(
    `recover-objects: ${result.entries.length - result.failedCount} recovered, ` +
      `${result.failedCount} failed — index: ${values.out}/index.json`,
  );
  return result.failedCount > 0 ? EXIT_FAILED_VERSIONS : 0;
}

process.exitCode = await main().catch((err: unknown) => {
  console.error(`recover-objects: aborted — ${err instanceof Error ? err.message : String(err)}`);
  return EXIT_ABORTED;
});
