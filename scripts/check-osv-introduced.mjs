#!/usr/bin/env node
/**
 * PR gate over OSV-Scanner: fail on vulnerabilities the change introduces.
 *
 * WHY (#668)
 *   The gate used to fail on ANY advisory in the lockfile. An advisory
 *   published against what `main` already ships then turned every PR red,
 *   including the ones carrying fixes, and stopped `promote` on `main`
 *   (it needs `lint`). Blocking those merges removes no exposure: the code
 *   is already on `main`. The nightly `Security (scheduled)` run scans
 *   `main` absolutely and owns pre-existing findings (ci-red issue → triage).
 *
 * WHAT IT ENFORCES
 *   Scans the head lockfile and, with `--base-lockfile`, the base's, both
 *   with the head's osv-scanner.toml. Fails on every head finding whose
 *   (advisory id, ecosystem, package name) the base does not have. Version
 *   and location are not part of the key: any new instance (a bump that
 *   stays vulnerable, a second copy) of a package the base already has
 *   affected by the same advisory introduces nothing. No worse than the
 *   allowlist, which is per id; every instance is printed.
 *   Without `--base-lockfile` every finding fails.
 *
 * WHY NOT osv-reporter
 *   Google's diff (`osv-reporter --old --new`, internal/ci) keys findings on
 *   the source path and the package version. A base lockfile at another
 *   path reads as all-new, and a bump that stays vulnerable reads as new.
 *
 * FAIL-CLOSED
 *   The CLI exits 0 (clean) or 1 (findings) with a results file, 127 on
 *   error and 128 when it finds no packages, with none (measured, v2.3.8).
 *   Anything but 0/1 with a readable `results` array exits 2: a base that
 *   cannot be scanned makes the comparison impossible, in either direction.
 *   So does a results file of another shape, or one that disagrees with the
 *   exit code: the verdict is read from the results, and a renamed field
 *   after a CLI bump must not read as clean.
 *
 * EXIT CODES
 *   0  no finding introduced
 *   1  a finding introduced (or any finding, without a base)
 *   2  structural problem — scan error, unreadable results, bad arguments
 *
 * Usage:
 *   node scripts/check-osv-introduced.mjs [--base-lockfile <path>]
 *
 * PROJECT_ROOT is overridable so the self-test
 * (scripts/__tests__/check-osv-introduced.test.sh) can stage a tree and a
 * stub `osv-scanner` on PATH.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = process.env.PROJECT_ROOT ? path.resolve(process.env.PROJECT_ROOT) : repoRoot;

function fail(message, code) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

const argv = process.argv.slice(2);
let baseLockfile = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== '--base-lockfile') fail(`unknown argument: ${argv[i]}`, 2);
  baseLockfile = argv[i + 1];
  if (!baseLockfile) fail('--base-lockfile needs a path', 2);
  i += 1;
}
// The CLI exits 127 on a missing file too, but name the cause here.
if (baseLockfile && !existsSync(baseLockfile)) {
  fail(`base lockfile ${baseLockfile} does not exist`, 2);
}

const workDir = mkdtempSync(path.join(tmpdir(), 'osv-introduced-'));
process.on('exit', () => rmSync(workDir, { recursive: true, force: true }));

/** Findings in `lockfile` as Map<key, {id, name, version}>. */
function scan(label, lockfile) {
  const output = path.join(workDir, `${label}.json`);
  console.log(`--- ${label}: ${lockfile}`);
  const res = spawnSync(
    'osv-scanner',
    [
      'scan',
      'source',
      `--lockfile=${lockfile}`,
      `--config=${path.join(projectRoot, 'osv-scanner.toml')}`,
      '--format=json',
      `--output-file=${output}`,
    ],
    { stdio: 'inherit' },
  );
  if (res.error) fail(`could not run osv-scanner on the ${label}: ${res.error.message}`, 2);
  if (res.status !== 0 && res.status !== 1) {
    fail(`osv-scanner exited ${res.status} on the ${label} (127: error, 128: no packages)`, 2);
  }

  let results;
  try {
    ({ results } = JSON.parse(readFileSync(output, 'utf8')));
  } catch (err) {
    fail(`cannot read the ${label} scan's results: ${err.message}`, 2);
  }
  if (!Array.isArray(results)) fail(`the ${label} scan's results are not a list`, 2);

  // The verdict comes from the parsed results, so their shape is checked, not
  // assumed: a renamed field after a CLI bump must not read as "clean", nor
  // collapse every key to `undefined|…` and make head findings match the base.
  const isName = (s) => typeof s === 'string' && s.length > 0;
  const shapeError = `the ${label} scan's results are not in the expected shape`;
  const findings = new Map();
  for (const source of results) {
    if (!Array.isArray(source?.packages)) fail(`${shapeError} (packages)`, 2);
    for (const p of source.packages) {
      const { name, ecosystem, version } = p?.package ?? {};
      if (!isName(name) || !isName(ecosystem) || !Array.isArray(p.vulnerabilities)) {
        fail(`${shapeError} (package)`, 2);
      }
      for (const v of p.vulnerabilities) {
        if (!isName(v?.id)) fail(`${shapeError} (vulnerability id)`, 2);
        const key = `${v.id}|${ecosystem}|${name}`;
        if (!findings.has(key)) findings.set(key, { id: v.id, name, versions: new Set() });
        findings.get(key).versions.add(version);
      }
    }
  }
  // The CLI's own verdict must agree with what was read.
  if ((res.status === 1) !== findings.size > 0) {
    fail(
      `osv-scanner exited ${res.status} but the ${label} results hold ${findings.size} findings`,
      2,
    );
  }
  return findings;
}

const show = (f) => `${f.id}  ${[...f.versions].map((v) => `${f.name}@${v}`).join(', ')}`;

const head = scan('head', path.join(projectRoot, 'package-lock.json'));
const base = baseLockfile ? scan('base', baseLockfile) : new Map();

const introduced = [...head].filter(([key]) => !base.has(key)).map(([, f]) => f);
const preExisting = [...head].filter(([key]) => base.has(key)).map(([, f]) => f);

if (preExisting.length > 0) {
  console.log(
    `already on the base, not introduced by this change (${preExisting.length}); ` +
      'Security (scheduled) owns these:',
  );
  for (const f of preExisting) console.log(`  ${show(f)}`);
}

if (introduced.length === 0) {
  console.log(
    baseLockfile
      ? 'OK: this change introduces no OSV finding'
      : 'OK: no OSV finding in the lockfile',
  );
  process.exit(0);
}

console.error(
  baseLockfile
    ? '\nERROR: this change introduces OSV findings:'
    : '\nERROR: OSV findings in the lockfile (no base to judge against):',
);
for (const f of introduced) {
  console.error(`  ${show(f)}  https://osv.dev/${f.id}`);
}
console.error('\nFix by bumping the package past the patched version.');
console.error('If there is no fix yet, add the id to osv-scanner.toml with');
console.error('owner + reason + ignoreUntil (<=90d) — see docs/ops/dep-management.md');
console.error('§ Allowlist. Do not weaken this check to get past it.');
process.exit(1);
