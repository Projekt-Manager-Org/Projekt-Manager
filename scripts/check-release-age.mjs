#!/usr/bin/env node
/**
 * Release-age gate: nothing younger than N days enters the lockfile.
 *
 * WHY THIS EXISTS
 *   The 3-day cooldown used to live in `.npmrc` as `min-release-age`,
 *   enforced during npm resolution. Three properties follow from that
 *   enforcement point, none of them from the policy itself:
 *
 *     - it cannot be overridden — npm < 11.17.0 has no exclusion list,
 *       and the key is `exclusive` with `--before`;
 *     - it cannot explain itself — `ETARGET` names a package, not a
 *       policy;
 *     - it fails by producing nothing, so `lockFileMaintenance` stalls
 *       instead of reporting. The stall re-arms on every direct-dep
 *       floor raise, and vulnerability PRs raise floors at any time
 *       against a daily branch (ADR-0027 § 2026-09-17).
 *
 *   Enforcing the same rule on the finished lockfile keeps the security
 *   property, cannot deadlock, names the offending package, and can be
 *   overruled on the record.
 *
 * WHAT IT ENFORCES
 *   Every (name, version) present in the head lockfile but absent from
 *   the baseline lockfile must have been published at least
 *   RELEASE_AGE_MIN_DAYS ago — unless an unexpired allowlist entry
 *   names that exact name+version.
 *
 *   Versions already in the baseline are never re-checked: they were
 *   aged once, tested and merged. Re-litigating them is what produced
 *   the deadlock this replaces.
 *
 * WHAT IT DOES NOT COVER
 *   A cooldown only filters versions WITHDRAWN from the registry inside
 *   the window — the malicious-publish case. It cannot skip a release
 *   that merely turns out to be broken: the cutoff advances a day per
 *   day, so at the moment a broken version becomes eligible its fix is
 *   younger than the cutoff. Known-broken releases are excluded by
 *   version instead — a narrowed range in package.json plus
 *   `allowedVersions` in renovate.json.
 *
 * FAILS CLOSED
 *   A registry lookup that does not resolve is a violation, not a skip.
 *   "Could not verify" and "verified safe" are different answers.
 *
 * ALLOWLIST
 *   `release-age-allowlist.json` at the repo root — a JSON array of
 *   { package, version, reason, ignoreUntil }. `reason` must start with
 *   `@<github-handle>:`; `ignoreUntil` is YYYY-MM-DD inside
 *   [today, today+90d] — same field name and window as
 *   `osv-scanner.toml`, deliberately, so one rule is learned once.
 *   Schema is validated here rather than in
 *   scripts/check-allowlist-schema.sh because that script exists to
 *   police files THIRD-PARTY scanners read and ignore extra fields in.
 *   This file has exactly one reader, so a second script would be
 *   machinery without a purpose.
 *
 * Exit codes:
 *   0 — every newly-introduced version is old enough or validly allowlisted.
 *   1 — at least one violation; one `<kind>: <detail>` line per finding.
 *   2 — the check could not run (missing/unreadable lockfile or baseline).
 *
 * Env:
 *   RELEASE_AGE_REPO_ROOT   repo root override (tests)
 *   RELEASE_AGE_BASELINE    baseline lockfile path; default `git show origin/main:package-lock.json`
 *   RELEASE_AGE_MIN_DAYS    cooldown in days (default 3)
 *   RELEASE_AGE_TIMES       JSON fixture {name: {version: iso}} instead of the registry (tests)
 *   RELEASE_AGE_NOW         ISO instant treated as "now" (tests)
 *   RELEASE_AGE_ADVISORY_BYPASS  `1` waives age findings — set by CI on `security`-labelled PRs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT =
  process.env.RELEASE_AGE_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RAW_MIN_DAYS = process.env.RELEASE_AGE_MIN_DAYS;
const MIN_DAYS = RAW_MIN_DAYS === undefined || RAW_MIN_DAYS === '' ? 3 : Number(RAW_MIN_DAYS);
const NOW = process.env.RELEASE_AGE_NOW ? new Date(process.env.RELEASE_AGE_NOW) : new Date();
const REGISTRY = 'https://registry.npmjs.org';
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 10_000;

const findings = [];
const finding = (kind, detail) => findings.push(`${kind}: ${detail}`);

/** Fatal: the check itself could not run. Distinct from a policy violation. */
function bail(message) {
  console.error(`::error::release-age gate could not run — ${message}`);
  process.exit(2);
}

// Misconfiguration must not read as "nothing to report". Number('') is 0
// and every comparison against NaN is false, so an unset or malformed
// value would otherwise disable the gate while still printing OK.
//
// Empty and unset both fall back to the 3-day default rather than
// bailing: a workflow expression that resolves to nothing is the common
// case, and quietly enforcing the secure default beats failing the build.
// A value that is present but not a positive number is a genuine typo
// and has no safe reading, so it stops the run.
if (!Number.isFinite(MIN_DAYS) || MIN_DAYS <= 0) {
  bail(`RELEASE_AGE_MIN_DAYS must be a positive number, got ${JSON.stringify(RAW_MIN_DAYS)}`);
}
if (Number.isNaN(NOW.getTime())) {
  bail(`RELEASE_AGE_NOW is not a valid date: ${JSON.stringify(process.env.RELEASE_AGE_NOW)}`);
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    bail(`${what} unreadable at ${path}: ${err.message}`);
  }
}

/**
 * Baseline lockfile. An explicit path wins (tests); otherwise read
 * `main` out of git. A repo with no `origin/main` yet — a fresh clone
 * at depth 1 that never fetched it — is a setup error, not an empty
 * baseline: treating it as empty would mark every package "new" and
 * fail the world.
 */
function loadBaseline() {
  const override = process.env.RELEASE_AGE_BASELINE;
  if (override) {
    if (!existsSync(override)) bail(`baseline lockfile not found at ${override}`);
    return readJson(override, 'baseline lockfile');
  }
  try {
    const raw = execFileSync('git', ['show', 'origin/main:package-lock.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch (err) {
    bail(
      `could not read origin/main:package-lock.json (${err.message.split('\n')[0]}). ` +
        'Fetch main before running: git fetch --depth=1 origin main',
    );
  }
}

/** `node_modules/a/node_modules/@s/b` → `@s/b` */
function nameFromPath(path) {
  const marker = 'node_modules/';
  const i = path.lastIndexOf(marker);
  return i === -1 ? null : path.slice(i + marker.length);
}

/**
 * name → Set(version) for everything resolved from the npm registry.
 * Workspace links, git/file/tarball sources and the root entry carry no
 * registry publish time, so they are outside this gate's reach.
 */
function collectVersions(lock) {
  const out = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || entry.link || !entry.version) continue;
    if (!entry.resolved?.startsWith(`${REGISTRY}/`)) continue;
    const name = entry.name ?? nameFromPath(path);
    if (!name) continue;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(entry.version);
  }
  return out;
}

function newlyIntroduced(head, baseline) {
  const added = [];
  for (const [name, versions] of head) {
    const known = baseline.get(name);
    for (const version of versions) {
      if (!known?.has(version)) added.push({ name, version });
    }
  }
  return added.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const HANDLE_RE = /^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}:/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Allowlist entries, keyed `name@version`. Schema violations are
 * findings in their own right — a malformed entry must not silently
 * grant an exemption, and must not silently fail to grant one either.
 */
function loadAllowlist() {
  const path = join(REPO_ROOT, 'release-age-allowlist.json');
  if (!existsSync(path)) return new Map();
  const entries = readJson(path, 'allowlist');
  if (!Array.isArray(entries)) bail('release-age-allowlist.json must contain a JSON array');

  const today = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));
  const maxDate = new Date(today.getTime() + 90 * 86400_000);
  const out = new Map();

  entries.forEach((entry, i) => {
    const at = `release-age-allowlist.json[${i}]`;
    const { package: pkg, version, reason, ignoreUntil } = entry ?? {};
    let ok = true;
    const bad = (field, msg) => {
      finding('allowlist', `${at}: ${field}: ${msg}`);
      ok = false;
    };

    if (typeof pkg !== 'string' || !pkg) bad('package', 'missing');
    if (typeof version !== 'string' || !version) bad('version', 'missing');
    if (typeof reason !== 'string' || !HANDLE_RE.test(reason)) {
      bad('reason', 'must start with `@<github-handle>:`');
    }
    if (typeof ignoreUntil !== 'string' || !DATE_RE.test(ignoreUntil)) {
      bad('ignoreUntil', 'must be YYYY-MM-DD');
    } else {
      const d = new Date(`${ignoreUntil}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) bad('ignoreUntil', `not a real date: ${ignoreUntil}`);
      else if (d < today) bad('ignoreUntil', `expired on ${ignoreUntil}`);
      else if (d > maxDate) bad('ignoreUntil', `more than 90 days out (${ignoreUntil})`);
    }

    if (ok) out.set(`${pkg}@${version}`, entry);
  });

  return out;
}

/** Full packument is the only response carrying `time`; the abbreviated one drops it. */
async function fetchTimes(name) {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A required check must not be able to park CI on a hung socket, and
    // an immediate retry buys nothing against a 429 — back off first.
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body.time) throw new Error('packument carries no `time`');
      return body.time;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function resolveTimes(names) {
  const fixture = process.env.RELEASE_AGE_TIMES;
  if (fixture) {
    if (!existsSync(fixture)) bail(`times fixture not found at ${fixture}`);
    const data = readJson(fixture, 'times fixture');
    // Absent from the fixture is the same answer as a registry that did
    // not respond: unknown. It must fail closed on both paths, or the
    // tests prove a property the real run does not have.
    return new Map(
      names.map((n) => {
        if (!(n in data)) {
          finding('lookup', `${n}: no entry in times fixture`);
          return [n, null];
        }
        return [n, data[n]];
      }),
    );
  }

  const out = new Map();
  const queue = [...names];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        try {
          out.set(name, await fetchTimes(name));
        } catch (err) {
          out.set(name, null);
          finding('lookup', `${name}: registry lookup failed — ${err.message}`);
        }
      }
    }),
  );
  return out;
}

async function main() {
  const headPath = join(REPO_ROOT, 'package-lock.json');
  if (!existsSync(headPath)) bail(`package-lock.json not found at ${headPath}`);

  const head = collectVersions(readJson(headPath, 'package-lock.json'));
  const added = newlyIntroduced(head, collectVersions(loadBaseline()));
  const allowlist = loadAllowlist();

  if (added.length === 0 && findings.length === 0) {
    console.log('OK: no newly-introduced package versions.');
    return 0;
  }

  const times = await resolveTimes([...new Set(added.map((a) => a.name))]);
  const cutoff = new Date(NOW.getTime() - MIN_DAYS * 86400_000);
  let checked = 0;

  for (const { name, version } of added) {
    const key = `${name}@${version}`;
    if (allowlist.has(key)) continue;

    const published = times.get(name)?.[version];
    if (!published) {
      // A null map entry already reported itself as a lookup failure.
      if (times.get(name) !== null) {
        finding('lookup', `${key}: no publish time in the registry packument`);
      }
      continue;
    }

    const at = new Date(published);
    if (Number.isNaN(at.getTime())) {
      finding('lookup', `${key}: unparseable publish time ${published}`);
      continue;
    }
    checked++;
    if (at > cutoff) {
      const ageDays = ((NOW - at) / 86400_000).toFixed(1);
      const eligible = new Date(at.getTime() + MIN_DAYS * 86400_000).toISOString();
      finding(
        'release-age',
        `${key} is ${ageDays}d old (published ${published}), below the ${MIN_DAYS}d minimum — eligible ${eligible}`,
      );
    }
  }

  // Advisory bypass. Renovate exempts vulnerability PRs from its own
  // cooldown by design; a CVE fix is worth more than the malicious-publish
  // window it skips (#422 landed one ~1 h after publish). Without this the
  // gate would be STRICTER than the policy it implements — ADR-0027 lists
  // the missing npm-side exemption as an accepted cost, not as the intent.
  //
  // It waives age findings only. "This version is young" is a judgement the
  // advisory overrides; "I could not verify this version" is not.
  const waived = [];
  if (process.env.RELEASE_AGE_ADVISORY_BYPASS === '1') {
    for (let i = findings.length - 1; i >= 0; i--) {
      if (findings[i].startsWith('release-age:')) waived.push(...findings.splice(i, 1));
    }
  }
  for (const w of waived) console.log(`::warning::waived under advisory bypass — ${w}`);

  if (findings.length > 0) {
    for (const f of findings) console.error(f);
    console.error(
      `::error::release-age gate: ${findings.length} finding(s). ` +
        'Wait for the cutoff, exclude a known-broken release by version, ' +
        'or add an expiring entry to release-age-allowlist.json.',
    );
    return 1;
  }

  if (waived.length > 0) {
    console.log(`OK: ${waived.length} finding(s) waived under advisory bypass.`);
    return 0;
  }

  console.log(`OK: ${checked} newly-introduced version(s), all at least ${MIN_DAYS} days old.`);
  return 0;
}

process.exit(await main());
