#!/usr/bin/env node
/**
 * Third vulnerability layer: repo-level GitHub security advisories.
 *
 * WHY THIS EXISTS
 *   OSV-Scanner and npm audit both key on (ecosystem, name, version). An
 *   advisory that never gets an npm-ecosystem record is invisible to both,
 *   no matter how severe. That is not hypothetical — it is how
 *   CVE-2026-16732 (fastify trustProxy hop-count spoofing) reached `main`
 *   with CI green (#345):
 *
 *     - The OSV record for it carries a GIT range and no `package` field at
 *       all, so `osv-scanner scan source --lockfile` cannot match it —
 *       `POST /v1/query` for npm/fastify@5.12.0 returns `{}`.
 *     - GHSA-3m5p-2c4r-xxw2 404s on GitHub's *global* advisory API. It is
 *       still a repo-level advisory, so the GitHub Advisory DB — and
 *       therefore `npm audit` — does not carry it either.
 *
 *   What actually caught it was `tsc` rejecting a type-union member that
 *   upstream had removed. Luck, not a control.
 *
 *   The same fastify release fixed a SECOND repo-level-only advisory
 *   (GHSA-w2qp-rph6-63g4, schema validation bypass). Two misses from one
 *   release is a systematic blind spot in how the publisher files, not a
 *   one-off.
 *
 *   `GET /repos/{owner}/{repo}/security-advisories` returns advisories that
 *   were never promoted to the global database. That is the gap this closes.
 *
 * WHAT IT ENFORCES
 *   For every DIRECT dependency (dependencies + devDependencies) whose
 *   upstream repo is on GitHub: no published, non-withdrawn repo-level
 *   advisory may name that package with a vulnerable range that the
 *   installed version satisfies — unless its GHSA id is allowlisted.
 *
 *   Monorepos resolve correctly: many packages map to one repo
 *   (`@aws-sdk/*` → `aws/aws-sdk-js-v3`), and the match is on the
 *   advisory's own `vulnerabilities[].package.name`, not on the repo.
 *
 * WHICH RANGE IS AUTHORITATIVE
 *   Repo-level ranges are written by the publisher and are frequently
 *   coarser than the curated ones the advisory gets when it is promoted to
 *   the global database. GHSA-gpj5-g38j-94v9 is the worked example: the
 *   repo-level entry says `<= 1.0.0-beta.19` — one range spanning both
 *   release lines — while the global record splits it into `< 0.45.2`
 *   (patched 0.45.2) and `>= 1.0.0-beta.2, < 1.0.0-beta.20`. The installed
 *   drizzle-orm@0.45.2 satisfies the coarse range and is in fact the
 *   patched release on its line.
 *
 *   So: when a global record exists, its ranges win. When it does not — the
 *   case this gate exists for — the repo-level range is all there is, and
 *   it is used. Global-record advisories are still evaluated rather than
 *   skipped, because OSV-Scanner replaced `npm audit` here and the two
 *   databases are not supersets of one another either.
 *
 * ALLOWLIST
 *   Reuses `osv-scanner.toml`'s `[[IgnoredVulns]]` ids rather than
 *   introducing a third allowlist file — same advisory namespace, same
 *   owner/reason/ignoreUntil contract, already gated by
 *   scripts/check-allowlist-schema.sh. This script only scrapes the ids;
 *   that script owns schema validation, including expiry.
 *
 * FAIL-CLOSED
 *   A network error, a missing token, or an unparseable response exits 2.
 *   A scanner that reports "no advisories" because it could not reach the
 *   API is worse than no scanner, because it looks like a passing gate.
 *
 * COVERAGE IS REPORTED, NOT ASSUMED
 *   Packages with no GitHub repository, or whose repo has advisories
 *   disabled, are listed explicitly in the output. ADR-0027's complaint
 *   about its own vulnerability layer was that it "reads as complete" —
 *   this one states what it did not check.
 *
 * EXIT CODES
 *   0  no matching advisory
 *   1  a matching advisory (or one whose range could not be evaluated)
 *   2  structural problem — no token, network failure, unreadable input
 *
 * Usage:
 *   GITHUB_TOKEN="$(gh auth token)" node scripts/check-repo-advisories.mjs
 *
 * PROJECT_ROOT and ADVISORY_FIXTURE_DIR are overridable so the self-test
 * (scripts/__tests__/check-repo-advisories.test.sh) can stage a fake tree
 * and canned API responses without touching the network.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = process.env.PROJECT_ROOT ? path.resolve(process.env.PROJECT_ROOT) : repoRoot;
const fixtureDir = process.env.ADVISORY_FIXTURE_DIR
  ? path.resolve(process.env.ADVISORY_FIXTURE_DIR)
  : null;

const CONCURRENCY = 8;
const RETRIES = 3;

function fail(message, code) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * `git+https://github.com/fastify/fastify.git` → `fastify/fastify`.
 * Returns null for anything not on github.com, which is a coverage gap to
 * report rather than an error.
 */
function toGitHubSlug(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return null;
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(raw);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * GitHub joins range clauses with `, `; semver uses a space for the same
 * AND. Everything else about the syntax already agrees.
 */
function toSemverRange(vulnerableVersionRange) {
  return vulnerableVersionRange.split(',').join(' ').trim();
}

async function ghFetch(urlPath, token) {
  // Fixture mode. A missing file is a deliberate 404 — that is how the
  // self-test expresses "advisories disabled" and "not in the global DB".
  if (fixtureDir) {
    const repo = /^\/repos\/([^/]+)\/([^/]+)\/security-advisories/.exec(urlPath);
    const advisory = /^\/advisories\/([^/?]+)/.exec(urlPath);
    let file;
    if (repo) file = path.join(fixtureDir, 'repos', `${repo[1]}__${repo[2]}.json`);
    else if (advisory) file = path.join(fixtureDir, 'advisories', `${advisory[1]}.json`);
    else throw new Error(`no fixture mapping for ${urlPath}`);
    if (!existsSync(file)) return { status: 404, body: null };
    return { status: 200, body: readJson(file) };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`https://api.github.com${urlPath}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'projekt-manager-advisory-check',
          'x-github-api-version': '2022-11-28',
        },
      });
      // 404 is a legitimate answer here: the repo has advisories disabled,
      // was renamed, or (for the global-DB probe) the advisory is repo-only.
      if (res.status === 404) return { status: 404, body: null };
      if (res.ok) return { status: res.status, body: await res.json() };
      if (res.status === 403 || res.status === 429) {
        lastError = `rate limited (${res.status}) on ${urlPath}`;
      } else {
        lastError = `HTTP ${res.status} on ${urlPath}`;
      }
    } catch (err) {
      lastError = `${err.message} on ${urlPath}`;
    }
    if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  throw new Error(lastError);
}

/** Run `worker` over `items` with a bounded pool, preserving input order. */
async function mapPool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

// --- inputs -----------------------------------------------------------------

const token = process.env.GITHUB_TOKEN?.trim();
if (!token && !fixtureDir) {
  fail(
    'GITHUB_TOKEN is not set. The advisories endpoint needs it — unauthenticated ' +
      'requests get 60/hour, which cannot cover the dependency set. In CI pass ' +
      '${{ github.token }}; locally use `GITHUB_TOKEN="$(gh auth token)"`.',
    2,
  );
}

let pkg;
try {
  pkg = readJson(path.join(projectRoot, 'package.json'));
} catch (err) {
  fail(`cannot read package.json: ${err.message}`, 2);
}

const directDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
if (directDeps.length === 0) fail('package.json declares no direct dependencies', 2);

// Installed version + upstream repo come from the installed tree, so no
// registry round-trip is needed. `npm ci` runs before this step in CI.
const resolved = [];
const noManifest = [];
const noGitHubRepo = [];

for (const name of directDeps) {
  const manifestPath = path.join(projectRoot, 'node_modules', name, 'package.json');
  if (!existsSync(manifestPath)) {
    noManifest.push(name);
    continue;
  }
  const manifest = readJson(manifestPath);
  const slug = toGitHubSlug(manifest.repository);
  if (!slug) {
    noGitHubRepo.push(name);
    continue;
  }
  resolved.push({ name, version: manifest.version, slug });
}

if (noManifest.length > 0) {
  fail(
    `${noManifest.length} direct dependency/ies are not installed (${noManifest.join(', ')}). ` +
      'Run `npm ci` first — this check reads the installed tree for versions and repo URLs.',
    2,
  );
}

// One request per repo, not per package: `@aws-sdk/*` is ~2 packages on one
// monorepo, `@fastify/*` is five separate repos. Both collapse correctly.
const slugs = [...new Set(resolved.map((d) => d.slug))].sort();
const byName = new Map(resolved.map((d) => [d.name, d]));

// --- fetch ------------------------------------------------------------------

let advisoriesBySlug;
try {
  const fetched = await mapPool(slugs, async (slug) => {
    const res = await ghFetch(`/repos/${slug}/security-advisories?per_page=100`, token);
    return [slug, res];
  });
  advisoriesBySlug = new Map(fetched);
} catch (err) {
  fail(
    `could not reach the GitHub advisories API: ${err.message}. Failing closed — ` +
      'a gate that reports "no advisories" because the API was unreachable is ' +
      'indistinguishable from a passing one.',
    2,
  );
}

const advisoriesDisabled = slugs.filter((s) => advisoriesBySlug.get(s).status === 404);

// --- allowlist --------------------------------------------------------------

// Deliberately a dumb scan for `id = "..."`. scripts/check-allowlist-schema.sh
// owns the real parse and rejects anything missing owner/reason/ignoreUntil,
// so restating that logic here would only create a second thing to drift.
const allowlistPath = path.join(projectRoot, 'osv-scanner.toml');
const allowlist = new Set();
if (existsSync(allowlistPath)) {
  const toml = readFileSync(allowlistPath, 'utf8');
  for (const line of toml.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*id\s*=\s*"([^"]+)"/.exec(line);
    if (m) allowlist.add(m[1]);
  }
}

// --- candidates -------------------------------------------------------------

// Every (advisory, installed dep) pair, before any range evaluation. Ranges
// are resolved in the next step, where the global record may override.
const candidates = [];
let advisoryCount = 0;

for (const slug of slugs) {
  const { body } = advisoriesBySlug.get(slug);
  if (!Array.isArray(body)) continue;

  for (const adv of body) {
    // Drafts and withdrawn advisories are not claims about shipped code.
    if (adv.state !== 'published' || adv.withdrawn_at) continue;
    advisoryCount += 1;

    for (const vuln of adv.vulnerabilities ?? []) {
      if (vuln.package?.ecosystem?.toLowerCase() !== 'npm') continue;
      const dep = byName.get(vuln.package.name);
      // The repo may publish advisories for sibling packages we don't use.
      if (!dep || dep.slug !== slug) continue;
      if (!vuln.vulnerable_version_range) continue;

      candidates.push({
        ...dep,
        ghsa: adv.ghsa_id,
        severity: adv.severity,
        summary: adv.summary,
        repoRange: vuln.vulnerable_version_range,
        repoPatched: vuln.patched_versions,
      });
    }
  }
}

// --- resolve ranges against the global DB -----------------------------------

const globalIds = [...new Set(candidates.map((c) => c.ghsa))];
let globalById;
try {
  const probed = await mapPool(globalIds, async (id) => {
    const res = await ghFetch(`/advisories/${id}`, token);
    return [id, res.status === 404 ? null : res.body];
  });
  globalById = new Map(probed);
} catch (err) {
  fail(
    `could not resolve advisories against the global database: ${err.message}. ` +
      'Failing closed rather than judging every candidate on the coarser ' +
      'repo-level range.',
    2,
  );
}

const findings = [];
const allowlisted = [];

for (const c of candidates) {
  const global = globalById.get(c.ghsa);
  const globalRanges = (global?.vulnerabilities ?? [])
    .filter((v) => v.package?.ecosystem?.toLowerCase() === 'npm' && v.package.name === c.name)
    .map((v) => ({ range: v.vulnerable_version_range, patched: v.first_patched_version?.identifier }));

  // Global ranges are curated per release line; the repo-level one is what
  // the publisher wrote. Prefer the former when it exists.
  const useGlobal = globalRanges.length > 0;
  const ranges = useGlobal ? globalRanges : [{ range: c.repoRange, patched: c.repoPatched }];

  let matched = null;
  let unparseable = false;

  for (const r of ranges) {
    const semverRange = toSemverRange(r.range);
    if (!semver.validRange(semverRange)) {
      // Do not skip: an unparseable range is an unevaluated advisory, and
      // silently passing one is the failure mode this gate exists to fix.
      unparseable = true;
      matched = r;
      break;
    }
    if (semver.satisfies(c.version, semverRange, { includePrerelease: true })) {
      matched = r;
      break;
    }
  }

  if (!matched) continue;

  const finding = {
    ...c,
    range: matched.range,
    patched: matched.patched,
    rangeSource: useGlobal ? 'global advisory DB' : 'repo-level advisory',
    inGlobalDb: Boolean(global),
    unparseable,
  };
  if (allowlist.has(c.ghsa)) allowlisted.push(finding);
  else findings.push(finding);
}

// --- report -----------------------------------------------------------------

console.log(`Repo-level advisory scan: ${slugs.length} repos, ${directDeps.length} direct deps`);
console.log(`  published advisories seen: ${advisoryCount}`);

// State what was NOT checked. A layer that reads as complete is the exact
// complaint #345 raised against the existing two.
if (noGitHubRepo.length > 0) {
  console.log(`  NOT CHECKED — no GitHub repository (${noGitHubRepo.length}):`);
  console.log(`    ${noGitHubRepo.join(', ')}`);
}
if (advisoriesDisabled.length > 0) {
  console.log(`  NOT CHECKED — advisories disabled or repo moved (${advisoriesDisabled.length}):`);
  console.log(`    ${advisoriesDisabled.join(', ')}`);
}
if (allowlisted.length > 0) {
  console.log(`  allowlisted via osv-scanner.toml (${allowlisted.length}):`);
  for (const f of allowlisted) console.log(`    ${f.ghsa}  ${f.name}@${f.version}`);
}

if (findings.length === 0) {
  console.log('OK: no repo-level advisory matches an installed direct dependency');
  process.exit(0);
}

console.error('');
console.error('ERROR: repo-level security advisories match installed dependencies.\n');

for (const f of findings) {
  // Whether the global DB carries it explains why the other gates were
  // green, which is the first question a triager asks.
  const visibility = f.inGlobalDb
    ? 'in the global advisory DB'
    : 'REPO-LEVEL ONLY — invisible to OSV-Scanner and npm audit';

  console.error(`  ${f.ghsa}  [${f.severity}]  ${f.name}@${f.version}`);
  console.error(`    ${f.summary}`);
  console.error(`    vulnerable: ${f.range}${f.patched ? `   patched: ${f.patched}` : ''}`);
  console.error(`    range from: ${f.rangeSource}`);
  console.error(`    visibility: ${visibility}`);
  console.error(`    https://github.com/${f.slug}/security/advisories/${f.ghsa}`);
  if (f.unparseable) {
    console.error(
      '    NOTE: the vulnerable range could not be parsed as semver, so this is ' +
        'reported unevaluated. Check by hand and widen toSemverRange() if the ' +
        'syntax is legitimate.',
    );
  }
  console.error('');
}

console.error('Fix by bumping the package past the patched version.');
console.error('If there is no fix yet, add the GHSA id to osv-scanner.toml with');
console.error('owner + reason + ignoreUntil (<=90d) — see docs/ops/dep-management.md');
console.error('§ Allowlist. Do not weaken this check to get past it.');
process.exit(1);
