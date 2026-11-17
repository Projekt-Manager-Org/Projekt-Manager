#!/usr/bin/env node
/**
 * Keeps `local/no-direct-db-access` switched on where it belongs (#937, #939).
 *
 * WHY THIS EXISTS
 *   scripts/check-eslint-suppressions.sh keeps the baseline shrink-only, but
 *   the config can exempt a file instead: one more `ignores:` entry, then
 *   `eslint --prune-suppressions` drops the file's entries. Lint and the
 *   baseline check stay green, the diff reads as burn-down progress, and
 *   the file takes new queries unseen. This check pins the config's effect.
 *
 * WHAT IT ENFORCES
 *   For every source file under src/server/ (tests aside), from the config
 *   ESLint computes for it:
 *     - repositories/: the rule at `error` with REPOSITORY_OPTIONS;
 *     - an entry of EXEMPT: the rule off;
 *     - anything else: the rule at `error` with SERVICE_OPTIONS.
 *   An ignored file counts as off. Every file named in EXEMPT must exist and
 *   have the rule off, so a dead exemption cannot wait for a later file at
 *   its path.
 *
 *   EXEMPT and the options mirror eslint.config.js on purpose: widening an
 *   exemption takes a change here too, which names what it bypasses.
 *
 * EXIT CODES
 *   0  ok
 *   1  a file with the wrong setting
 *   2  usage error, or ESLint cannot compute the config
 *
 * Usage:
 *   node scripts/check-db-access-coverage.mjs [--config <eslint config file>]
 *
 * --config replaces eslint.config.js (tests).
 */

import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ESLint } from 'eslint';

const RULE = 'local/no-direct-db-access';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = 'src/server';
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

// Schema constants, not tables (eslint.config.js SCHEMA_CONSTANTS).
const ALLOW = ['AUDIT_ENTITY_TYPES', 'AUDIT_EXCLUDED_FIELDS'];
const SERVICE_OPTIONS = [2, { allow: ALLOW }];
const REPOSITORY_OPTIONS = [2, { allow: ALLOW, queries: false }];

// The named exemptions of eslint.config.js, with their reasons there.
// A trailing `/` exempts a directory.
const EXEMPT = [
  'src/server/db/auditLogRemoval.ts',
  'src/server/db/baseline-guard.ts',
  'src/server/db/connection.ts',
  'src/server/db/constraints.ts',
  'src/server/db/schema.ts',
  'src/server/db/migrations/',
  'src/server/db/baseline/',
  'src/server/seed/',
  'src/server/seed.ts',
  'src/server/health.ts',
  'src/server/services/ephemeralPg.ts',
];

const args = process.argv.slice(2);
let configFile;
if (args.length === 2 && args[0] === '--config') {
  configFile = path.resolve(args[1]);
  if (!existsSync(configFile)) {
    console.error(`ERROR: --config '${args[1]}' does not exist`);
    process.exit(2);
  }
} else if (args.length) {
  console.error('Usage: node scripts/check-db-access-coverage.mjs [--config <file>]');
  process.exit(2);
}

const isExempt = (file) => EXEMPT.some((e) => (e.endsWith('/') ? file.startsWith(e) : file === e));

const files = readdirSync(path.join(ROOT, SERVER), { recursive: true })
  .map((f) => path.posix.join(SERVER, f.split(path.sep).join('/')))
  .filter((f) => SOURCE.test(f) && !f.split('/').includes('__tests__'))
  .sort();

const eslint = new ESLint({ cwd: ROOT, ...(configFile && { overrideConfigFile: configFile }) });
const problems = [];

async function setting(file) {
  try {
    if (await eslint.isPathIgnored(file)) return undefined;
    const value = (await eslint.calculateConfigForFile(file))?.rules?.[RULE];
    return value && value[0] !== 0 ? value : undefined;
  } catch (err) {
    // Not exit 1: a broken config must not pass for a caught violation.
    console.error(`ERROR: cannot compute the ESLint config for ${file}: ${err.message}`);
    process.exit(2);
  }
}

for (const file of files) {
  const actual = await setting(file);
  const expected = isExempt(file)
    ? undefined
    : file.startsWith(`${SERVER}/repositories/`)
      ? REPOSITORY_OPTIONS
      : SERVICE_OPTIONS;
  if (!isDeepStrictEqual(actual, expected)) {
    problems.push(
      `${file}: ${RULE} is ${JSON.stringify(actual ?? 'off')}, expected ${JSON.stringify(expected ?? 'off')}.`,
    );
  }
}

for (const e of EXEMPT.filter((x) => !x.endsWith('/'))) {
  if (!files.includes(e)) problems.push(`${e}: exempt, but no such file. Drop the exemption.`);
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  console.error(
    'Move the queries into src/server/repositories/ instead of exempting a file. ' +
      'A real exemption goes into eslint.config.js and EXEMPT in this script, each with its reason. See #937.',
  );
  process.exit(1);
}
console.log(
  `${RULE}: on for ${files.length - files.filter(isExempt).length} of ${files.length} files under ${SERVER}/; ok`,
);
