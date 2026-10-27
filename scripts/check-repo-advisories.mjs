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
 *   advisory's own `vulnerabilities[].package.name`, not on the repo. An
 *   advisory filed on a SIBLING repo counts too — orgs that split one
 *   package per repo still file some advisories centrally, and requiring
 *   the filing repo to be the package's own repo dropped those in silence.
 *
 * WHICH RANGE IS AUTHORITATIVE
 *   Repo-level ranges are written by the publisher; global ones are
 *   curated on promotion. They are usually the same split, written
 *   differently — and the difference decides the verdict.
 *
 *   GHSA-gpj5-g38j-94v9 is the worked example. Both records split
 *   drizzle-orm's two release lines; only the global one bounds them:
 *
 *     repo-level:  <= 0.45.1          patched 0.45.2
 *                  <= 1.0.0-beta.19   patched 1.0.0-beta.20
 *     global:      < 0.45.2                      (first patched 0.45.2)
 *                  >= 1.0.0-beta.2, < 1.0.0-beta.20
 *
 *   `<= 1.0.0-beta.19` is unbounded below, so under plain semver it also
 *   covers every 0.x release — `semver.satisfies('0.45.2',
 *   '<=1.0.0-beta.19')` is `true`. The installed drizzle-orm@0.45.2 is the
 *   PATCHED release on its own line, and the global record's lower bound
 *   (`>= 1.0.0-beta.2`) is what says so.
 *
 *   So: when a global record exists, its ranges win. When it does not — the
 *   case this gate exists for — the repo-level range is all there is, and
 *   it is used. Global-record advisories are still evaluated rather than
 *   skipped, because OSV-Scanner replaced `npm audit` here and the two
 *   databases are not supersets of one another either.
 *
 *   A global record that clears a repo-level match is printed, not hidden:
 *   this layer exists because the global DB lags. The override is SETTLED,
 *   and listed on one line, when the global `github_reviewed_at` is at or
 *   after the repo-level `updated_at` — a curator saw the publisher's last
 *   edit. Anything else asks for a re-check. Review, not age, decides: an
 *   edit the curators never picked up does not become safe by getting old.
 *
 *   `github_reviewed_at` is the FIRST review and does not move on later
 *   curation (measured, #516). So a publisher edit after it keeps the
 *   re-check call for good, even once curators catch up — noisy, never
 *   quiet. See ADR-0027's "does NOT cover" table.
 *
 *   KNOWN FALSE POSITIVE, unmitigated on purpose. An unbounded `<= X` on a
 *   newer release line matches every older version. When the advisory is
 *   repo-level-only there is no curated record to correct it, so the gate
 *   reds on a version that is in fact patched. The finding output flags the
 *   shape ("this advisory splits into N ranges") so triage is quick; the
 *   allowlist is the only escape. Narrowing it automatically would mean
 *   guessing a lower bound the publisher did not write — and guessing wrong
 *   in the direction of a false NEGATIVE, which is the failure #345 was
 *   about. See ADR-0027 § 2026-08-28 amendment.
 *
 * ALLOWLIST
 *   Reuses `osv-scanner.toml`'s `[[IgnoredVulns]]` ids rather than
 *   introducing a third allowlist file — same advisory namespace, same
 *   owner/reason/ignoreUntil contract, already gated by
 *   scripts/check-allowlist-schema.sh. This script only scrapes the ids;
 *   that script owns schema validation, including expiry.
 *
 *   That split only holds where both run. Every caller MUST run
 *   check-allowlist-schema.sh first, or an expired `ignoreUntil` suppresses
 *   a match forever — unlike OSV-Scanner, which honours the date itself.
 *   Enforced in ci.yml (`lint`) and security-scheduled.yml
 *   (`repo-advisories`).
 *
 * GLOBAL PROBES
 *   `GET /advisories?ghsa_id={id}` with the token. Measured (#511):
 *
 *     endpoint               token                repo-only   global
 *     /advisories/{id}       ${{ github.token }}  403         200
 *     /advisories/{id}       anonymous / OAuth    404         200
 *     /advisories?ghsa_id=   all three            200 []      200 [record]
 *
 *   Under ${{ github.token }} the single-record endpoint cannot say "not in
 *   the global DB", which is this gate's whole subject. The list query can,
 *   on the token's own quota rather than the per-IP anonymous one. With
 *   `ghsa_id` set, its default `type=reviewed` filter does not apply.
 *
 *   A filter by one id answers `[]` or that one record. Anything else (not
 *   a list, several records, another id) is unreadable and exits 2.
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
 *   Listings are paginated to exhaustion rather than capped at one page,
 *   and a 200 whose body is not an array exits 2. Both are cases where a
 *   truncated read would have printed the same "OK" as a complete one.
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
 * Upstream repo → `owner/repo`, or null when it is not on GitHub.
 *
 * npm's `repository` field has four shapes in the installed tree and three
 * of them omit the host entirely, because GitHub is npm's default:
 *
 *   git+https://github.com/fastify/fastify.git   → fastify/fastify
 *   git@github.com:fastify/fastify.git           → fastify/fastify
 *   github:ds300/patch-package                   → ds300/patch-package
 *   eslint/eslint                                → eslint/eslint
 *
 * Matching only the literal `github.com` dropped the last two silently,
 * which cost coverage on six direct deps including `tsx` and `eslint`.
 *
 * Other hosts always carry their own prefix (`gitlab:`, `bitbucket:`) or a
 * full URL, so neither can reach the shorthand branch. A null is a coverage
 * gap to report, not an error.
 */
function toGitHubSlug(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();

  const url = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(value);
  if (url) return `${url[1]}/${url[2]}`;

  // `owner/repo`, optionally `github:`-prefixed and `#committish`-suffixed.
  // `[\w.-]` cannot match the `:` in another host's prefix or in a scheme.
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#.*)?$/.exec(value);
  if (shorthand) return `${shorthand[1]}/${shorthand[2]}`;

  return null;
}

/**
 * GitHub joins range clauses with `, `; semver uses a space for the same
 * AND. Everything else about the syntax already agrees.
 */
function toSemverRange(vulnerableVersionRange) {
  return vulnerableVersionRange.split(',').join(' ').trim();
}

async function ghFetch(urlPath, token) {
  // Fixture mode. A missing file is the API's own "nothing here":
  //   repo listing, page 1   404 — advisories disabled
  //   repo listing, page 2+  []  — end of the listing; stage
  //                          `owner__repo.p2.json` to exercise pagination
  //   global query           []  — not in the global DB
  if (fixtureDir) {
    const [pathname, query] = urlPath.split('?');
    const params = new URLSearchParams(query ?? '');
    const page = Number(params.get('page') ?? '1');
    const repo = /^\/repos\/([^/]+)\/([^/]+)\/security-advisories$/.exec(pathname);
    const ghsaId = pathname === '/advisories' ? params.get('ghsa_id') : null;
    let file;
    if (repo) {
      file = path.join(
        fixtureDir,
        'repos',
        `${repo[1]}__${repo[2]}${page > 1 ? `.p${page}` : ''}.json`,
      );
      if (!existsSync(file))
        return page > 1 ? { status: 200, body: [] } : { status: 404, body: null };
    } else if (ghsaId) {
      file = path.join(fixtureDir, 'advisories', `${ghsaId}.json`);
      if (!existsSync(file)) return { status: 200, body: [] };
    } else {
      throw new Error(`no fixture mapping for ${urlPath}`);
    }
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
      // A legitimate answer for a repo listing: advisories disabled, or the
      // repo was renamed. The global query never 404s; its caller rejects it.
      if (res.status === 404) return { status: 404, body: null };
      if (res.ok) return { status: res.status, body: await res.json() };
      // 403 is quota ONLY when the remaining count is zero. Otherwise it
      // may be a permissions answer, and labelling that "rate limited" sent
      // this gate's first CI failure chasing the wrong cause.
      const remaining = res.headers.get('x-ratelimit-remaining');
      lastError =
        res.status === 429 || (res.status === 403 && remaining === '0')
          ? `rate limited (${res.status}) on ${urlPath}`
          : `HTTP ${res.status} on ${urlPath}`;
    } catch (err) {
      lastError = `${err.message} on ${urlPath}`;
    }
    if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  throw new Error(lastError);
}

/**
 * Read a paginated listing to exhaustion.
 *
 * `per_page=100` alone caps the read at 100 and says nothing about it. The
 * busiest repo in this dependency set files 35 advisories today, so the cap
 * is not live — but a silently truncated listing prints the same "OK" as a
 * complete one, which is the failure mode this whole file exists to remove.
 *
 * Anything other than a list, or a listing that will not terminate, throws
 * and is handled as a structural failure (exit 2).
 */
async function ghFetchList(basePath, token) {
  const PER_PAGE = 100;
  const MAX_PAGES = 20;
  const all = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ghFetch(`${basePath}?per_page=${PER_PAGE}&page=${page}`, token);
    // Only the first page can legitimately 404 (advisories disabled, repo
    // renamed or deleted). Later on it would mean the listing moved mid-read.
    if (res.status === 404) {
      if (page === 1) return { status: 404, body: null };
      throw new Error(`${basePath} 404'd on page ${page} after returning pages 1..${page - 1}`);
    }
    if (!Array.isArray(res.body)) {
      throw new Error(`${basePath} page ${page} returned ${typeof res.body}, not a list`);
    }
    all.push(...res.body);
    if (res.body.length < PER_PAGE) return { status: 200, body: all };
  }

  throw new Error(
    `${basePath} still had results after ${MAX_PAGES} pages (${all.length} entries). ` +
      'Refusing to report a truncated listing as complete.',
  );
}

/**
 * The global DB's record for `id`, or null when it has none. Any answer
 * other than `[]` or that one record throws. See GLOBAL PROBES.
 */
async function fetchGlobalAdvisory(id, token) {
  const query = `/advisories?ghsa_id=${encodeURIComponent(id)}`;
  const { status, body } = await ghFetch(query, token);
  if (!Array.isArray(body)) throw new Error(`${query} did not return a list (HTTP ${status})`);
  if (body.length === 0) return null;
  if (body.length > 1) throw new Error(`${query} returned ${body.length} records, expected 1`);
  if (body[0]?.ghsa_id !== id) {
    throw new Error(`${query} returned ${body[0]?.ghsa_id ?? 'a record without an id'}`);
  }
  return body[0];
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
    const res = await ghFetchList(`/repos/${slug}/security-advisories`, token);
    return [slug, res];
  });
  advisoriesBySlug = new Map(fetched);
} catch (err) {
  fail(
    `could not read the GitHub advisories API: ${err.message}. Failing closed — ` +
      'a gate that reports "no advisories" because the listing was unreachable or ' +
      'incomplete is indistinguishable from a passing one.',
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

// One entry per (advisory, installed dep), carrying ALL of that advisory's
// ranges for the package — publishers split by release line, and the count
// is what tells a triager whether an unbounded upper range is meaningful.
// Ranges are evaluated in the next step, where the global record may win.
const candidates = [];
let advisoryCount = 0;

for (const slug of slugs) {
  const { status, body } = advisoriesBySlug.get(slug);
  // 404 only — ghFetchList guarantees an array on 200 or throws.
  if (status === 404) continue;

  for (const adv of body) {
    // Drafts and withdrawn advisories are not claims about shipped code.
    if (adv.state !== 'published' || adv.withdrawn_at) continue;
    advisoryCount += 1;

    const rangesByDep = new Map();
    for (const vuln of adv.vulnerabilities ?? []) {
      if (vuln.package?.ecosystem?.toLowerCase() !== 'npm') continue;
      const dep = byName.get(vuln.package.name);
      // The repo may publish advisories for sibling packages we don't use.
      // Only that. Also demanding `dep.slug === slug` would drop packages we
      // DO use whose advisory the org filed on a different repo — a silent
      // false negative in the gate whose whole subject is false negatives.
      if (!dep) continue;
      if (!vuln.vulnerable_version_range) continue;

      if (!rangesByDep.has(dep.name)) rangesByDep.set(dep.name, []);
      rangesByDep.get(dep.name).push({
        range: vuln.vulnerable_version_range,
        patched: vuln.patched_versions ?? null,
      });
    }

    for (const [name, repoRanges] of rangesByDep) {
      candidates.push({
        ...byName.get(name),
        ghsa: adv.ghsa_id,
        // The repo that HOLDS the advisory, which is not always the package's
        // own repo (`slug` on the dep). The finding's link needs this one.
        advisorySlug: slug,
        severity: adv.severity,
        summary: adv.summary,
        repoRanges,
        repoUpdatedAt: adv.updated_at,
      });
    }
  }
}

// --- resolve ranges against the global DB -----------------------------------

// Probe ONLY the advisories whose repo-level range actually matches. The
// global record is consulted to CORRECT a repo-level match — publishers
// write ranges unbounded below — not to find one. Detection against the
// global database is layer 2's job: OSV.dev ingests GHSA, and OSV-Scanner
// runs in this same job. Probing the rest would re-ask a question already
// answered, at 24 requests per run instead of 1.
//
// Residual: a global record whose curated range is WIDER than the
// publisher's, during the window before OSV ingests it. Documented in
// ADR-0027's "does NOT cover" table rather than paid for on every run.
const adjudicated = candidates
  .map((c) => ({ ...c, repoMatch: firstMatch(c.version, c.repoRanges) }))
  .filter((c) => c.repoMatch);

const globalIds = [...new Set(adjudicated.map((c) => c.ghsa))];
let globalById;
try {
  const probed = await mapPool(globalIds, async (id) => [id, await fetchGlobalAdvisory(id, token)]);
  globalById = new Map(probed);
} catch (err) {
  fail(
    `could not resolve advisories against the global database: ${err.message}. ` +
      'Failing closed rather than judging every candidate on the coarser ' +
      'repo-level range.',
    2,
  );
}

/**
 * First range the installed version satisfies, or the first that cannot be
 * parsed. Unparseable counts as a match on purpose: an advisory this script
 * could not evaluate must not pass silently.
 */
function firstMatch(version, ranges) {
  for (const r of ranges) {
    const semverRange = toSemverRange(r.range);
    if (!semver.validRange(semverRange)) return { ...r, unparseable: true };
    if (semver.satisfies(version, semverRange, { includePrerelease: true })) {
      return { ...r, unparseable: false };
    }
  }
  return null;
}

/**
 * Whether the global review post-dates the publisher's last edit. See
 * WHICH RANGE IS AUTHORITATIVE. A missing or unparseable timestamp parses
 * to NaN and is not settled.
 */
function reviewedSinceEdit(global, repoUpdatedAt) {
  return Date.parse(global.github_reviewed_at) >= Date.parse(repoUpdatedAt);
}

const findings = [];
const allowlisted = [];
const overriddenByGlobal = [];

// Every entry here already matched its repo-level range; the loop decides
// whether the curated record overturns that.
for (const c of adjudicated) {
  const global = globalById.get(c.ghsa);
  // The GLOBAL advisory schema types `first_patched_version` as a string or
  // null. The `{ identifier }` object belongs to the Dependabot ALERTS API,
  // which this script never calls — reading `.identifier` here silently
  // dropped the patched version from every global-sourced finding.
  //
  // It types `vulnerable_version_range` as string-or-null too, same as the
  // repo-level shape guarded above. Passing a null through to semver threw
  // out of the top level, so a structural failure exited 1 — this script's
  // code for "a matching advisory" — with a stack trace and no finding.
  // Dropping the entry leaves no global range, so the publisher's range
  // stands and the candidate is still judged.
  const globalRanges = (global?.vulnerabilities ?? [])
    .filter(
      (v) =>
        v.package?.ecosystem?.toLowerCase() === 'npm' &&
        v.package.name === c.name &&
        v.vulnerable_version_range,
    )
    .map((v) => ({ range: v.vulnerable_version_range, patched: v.first_patched_version ?? null }));

  // Global ranges are curated and bounded on both ends; the repo-level ones
  // are what the publisher wrote. Prefer the former when it exists.
  const useGlobal = globalRanges.length > 0;
  const matched = useGlobal ? firstMatch(c.version, globalRanges) : c.repoMatch;

  if (!matched) {
    // Repo says vulnerable, global says patched. Usually the curated record
    // adding the lower bound the publisher omitted — but the premise of this
    // whole layer is that the global DB lags, so a disagreement it resolves
    // in favour of "clean" is exactly the thing not to swallow — until the
    // global review post-dates the publisher's last edit.
    overriddenByGlobal.push({
      ...c,
      repoRange: c.repoMatch.range,
      reviewedAt: global.github_reviewed_at ?? null,
      settled: reviewedSinceEdit(global, c.repoUpdatedAt),
    });
    continue;
  }

  const finding = {
    ...c,
    range: matched.range,
    patched: matched.patched,
    rangeSource: useGlobal ? 'global advisory DB' : 'repo-level advisory',
    inGlobalDb: Boolean(global),
    unparseable: matched.unparseable,
    // A repo-level-only advisory that splits release lines writes each range
    // unbounded below, so the newest line's range also covers every older
    // version. Flagged, not auto-narrowed — see the header.
    splitLines: !useGlobal && c.repoRanges.length > 1,
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
// Settled overrides are listed, not flagged: a call to re-check that never
// changes teaches people to skip the one that matters (#516).
const settled = overriddenByGlobal.filter((o) => o.settled);
const unsettled = overriddenByGlobal.filter((o) => !o.settled);
if (settled.length > 0) {
  const ids = settled.map((o) => `${o.ghsa}  ${o.name}@${o.version}`).join(', ');
  console.log(
    `  cleared by the global DB, reviewed since the last repo edit (${settled.length}): ${ids}`,
  );
}
if (unsettled.length > 0) {
  console.log(
    `  cleared by the global DB, global review predates the last repo edit (${unsettled.length}):`,
  );
  for (const o of unsettled) {
    console.log(
      `    ${o.ghsa}  ${o.name}@${o.version}  repo range: ${o.repoRange}  ` +
        `repo edited: ${o.repoUpdatedAt ?? 'unknown'}  global reviewed: ${o.reviewedAt ?? 'never'}`,
    );
  }
  console.log('    Global ranges won. If the global record is the stale one, this is a MISS —');
  console.log('    check the advisory page before trusting the pass.');
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
  console.error(`    https://github.com/${f.advisorySlug}/security/advisories/${f.ghsa}`);
  if (f.advisorySlug !== f.slug) {
    console.error(
      `    NOTE: filed on ${f.advisorySlug}, not on ${f.name}'s own repo ` +
        `(${f.slug}). Central filing in the same org — the advisory names ` +
        'this package, so it still counts.',
    );
  }
  if (f.unparseable) {
    console.error(
      '    NOTE: the vulnerable range could not be parsed as semver, so this is ' +
        'reported unevaluated. Check by hand and widen toSemverRange() if the ' +
        'syntax is legitimate.',
    );
  }
  if (f.splitLines) {
    console.error(
      `    NOTE: this advisory files ${f.repoRanges.length} ranges for ${f.name} ` +
        `(${f.repoRanges.map((r) => r.range).join(' | ')}) and has no global record ` +
        'to bound them. A range like `<= 2.x` written for a newer release line also ' +
        'matches every older version under semver, so verify the line you are on is ' +
        'really affected before treating this as real.',
    );
  }
  console.error('');
}

console.error('Fix by bumping the package past the patched version.');
console.error('If there is no fix yet, add the GHSA id to osv-scanner.toml with');
console.error('owner + reason + ignoreUntil (<=90d) — see docs/ops/dep-management.md');
console.error('§ Allowlist. Do not weaken this check to get past it.');
process.exit(1);
