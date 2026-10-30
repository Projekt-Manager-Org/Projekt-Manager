#!/usr/bin/env node
/**
 * Updater health: is Renovate running, and is its queue moving?
 * (ADR-0027 § 2026-10-29, control 2; #637)
 *
 * WHY THIS EXISTS
 *   Renovate is the only update path for whatever no vulnerability alert
 *   covers: runtimes, base images, CLI binaries. #637 found Node and
 *   PostgreSQL months behind with every check green — the queue starved by
 *   our own config and a pin branch erroring every run, visible only on
 *   the Dependency Dashboard. This reads the dashboard nightly and goes red.
 *
 * WHAT IS RED
 *   - Renovate did not run within a day of a request (LIVENESS below).
 *   - A dashboard section outside BENIGN_SECTIONS. Fail closed: an unknown
 *     heading is a format change this check does not understand.
 *   - An Awaiting Schedule branch outside AWAITING_EXEMPT: a starved update.
 *   - A dependency lookup warning. Renovate renders it under no heading
 *     (errors-warnings.ts, getDepWarningsDashboard), so it is matched by text.
 *   - A Renovate PR open longer than STALE_PR_DAYS, docker-host excepted.
 *   - No open dashboard, or more than one.
 *
 * LIVENESS
 *   Renovate edits the dashboard only when its body changes (GitHub
 *   platform, ensureIssue), so `updated_at` says nothing: 29 h without an
 *   edit was measured on 2026-10-13 with Renovate healthy. Instead each run
 *   ticks the Mend app's "manual job" box, and any later Renovate job
 *   re-renders it unticked (Mend also enqueues a job on dashboard actions).
 *   Still ticked at the next run means no job ran in between — so a manual
 *   re-run shortly after a run is red until a job lands, and a Renovate that
 *   dies right after clearing the box is red only the night after next
 *   (≤ 48 h).
 *
 *   The PATCH replaces the whole body; GitHub has no conditional write for
 *   issues. The body is re-read just before it, so the window in which a
 *   Renovate edit is overwritten — and boxes Renovate already consumed are
 *   re-ticked — is one round-trip; the next job re-renders anyway.
 *
 * CONTRACT
 *   Reads GITHUB_REPOSITORY; RENOVATE_HEALTH_NOW (ISO date) pins the clock
 *   for tests. Talks to GitHub through `gh api` (GH_TOKEN).
 *
 * EXIT CODES
 *   0  healthy
 *   1  unhealthy; one line per finding
 *   2  could not check (API error) — never reads as healthy
 */
import { execFileSync } from 'node:child_process';

const DASHBOARD_TITLE = 'Dependency Dashboard';
const RENOVATE_LOGIN = 'renovate[bot]';
const STALE_PR_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// Headings Renovate renders (dependency-dashboard.ts) that need no action.
// Pending Status Checks holds updates inside their release-age cooldown —
// or, for an update without a release timestamp, forever: the dashboard
// carries no age, so this check cannot tell. Control 1 owns that guard
// (minimumReleaseAge only where timestamps exist; #637).
const BENIGN_SECTIONS = new Set([
  'Abandoned Dependencies',
  'Pending Approval',
  'Pending Status Checks',
  'Pending Branch Automerge',
  'Open',
  'PR Closed (Blocked)',
  'Deprecations / Replacements',
  'Detected Dependencies',
]);
const AWAITING_SCHEDULE = 'Awaiting Schedule';
// Branches whose schedule is deliberate (.github/renovate.json): docker-host
// is quarterly; lock-file-maintenance runs daily before 9am, so it is listed
// for the rest of the day; renovate-config-validator is weekly (Renovate
// releases several times a day).
const AWAITING_EXEMPT = new Set([
  'renovate/docker-host',
  'renovate/lock-file-maintenance',
  'renovate/renovate-config-validator',
]);
// docker-host is merged by hand after acceptance on the VPS.
const STALE_PR_EXEMPT = new Set(['renovate/docker-host']);

const HEADING = /^## (.+?)\s*$/;
const BRANCH_ITEM = /<!-- [\w-]+-branch=(\S+) -->/;
const PROBE = /^- \[([ xX])\] <!-- manual job -->/m;
const LOOKUP_WARNING = /Renovate failed to look up the following dependencies: (.*)$/m;

function ghApi(args, input) {
  return execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

const allPages = (path) => JSON.parse(ghApi(['--paginate', '--slurp', path])).flat();

/** Section title → its lines; text before the first heading is dropped. */
function sections(body) {
  const result = new Map();
  let lines = [];
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(HEADING);
    if (heading) {
      lines = [];
      result.set(heading[1], lines);
    } else {
      lines.push(line);
    }
  }
  return result;
}

function dashboardFindings(body) {
  const findings = [];
  for (const [title, lines] of sections(body)) {
    if (title === AWAITING_SCHEDULE) {
      for (const line of lines) {
        const branch = line.match(BRANCH_ITEM)?.[1];
        if (branch && !AWAITING_EXEMPT.has(branch)) {
          findings.push(
            `${AWAITING_SCHEDULE}: ${branch} — an update held back by schedule or limits`,
          );
        }
      }
    } else if (!BENIGN_SECTIONS.has(title)) {
      findings.push(`dashboard section "${title}" needs attention`);
    }
  }
  const lookup = body.match(LOOKUP_WARNING);
  if (lookup) findings.push(`dependency lookup failed: ${lookup[1]}`);
  return findings;
}

function stalePrFindings(pulls, now) {
  return pulls
    .filter(
      (pr) =>
        pr.user?.login === RENOVATE_LOGIN &&
        !STALE_PR_EXEMPT.has(pr.head.ref) &&
        now - Date.parse(pr.created_at) > STALE_PR_DAYS * DAY_MS,
    )
    .map((pr) => `Renovate PR #${pr.number} (${pr.head.ref}) open since ${pr.created_at}`);
}

/** Ticks the probe on a fresh read; a box already ticked or gone is left alone. */
function tickProbe(repo, number) {
  const path = `repos/${repo}/issues/${number}`;
  const body = JSON.parse(ghApi([path])).body ?? '';
  if (body.match(PROBE)?.[1] !== ' ') return;
  ghApi(
    ['-X', 'PATCH', path, '--input', '-'],
    JSON.stringify({ body: body.replace(PROBE, '- [x] <!-- manual job -->') }),
  );
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const now = Date.parse(process.env.RENOVATE_HEALTH_NOW ?? new Date().toISOString());
  if (!repo || Number.isNaN(now)) {
    console.error('GITHUB_REPOSITORY must be set; RENOVATE_HEALTH_NOW, if set, must be a date.');
    return 2;
  }

  let dashboards;
  let pulls;
  try {
    dashboards = allPages(
      `repos/${repo}/issues?state=open&creator=${encodeURIComponent(RENOVATE_LOGIN)}&per_page=100`,
    ).filter((issue) => !issue.pull_request && issue.title === DASHBOARD_TITLE);
    pulls = allPages(`repos/${repo}/pulls?state=open&per_page=100`);
  } catch {
    console.error('Could not read from the GitHub API.');
    return 2;
  }

  const findings = [];
  let probeIssue = null;
  if (dashboards.length !== 1) {
    findings.push(
      `expected one open "${DASHBOARD_TITLE}" issue by ${RENOVATE_LOGIN}, found ${dashboards.length}`,
    );
  } else {
    const [dashboard] = dashboards;
    const body = dashboard.body ?? '';
    findings.push(...dashboardFindings(body));
    const probe = body.match(PROBE)?.[1];
    if (probe === undefined) {
      findings.push('no "manual job" box on the dashboard: Renovate liveness is unknown');
    } else if (probe === ' ') {
      probeIssue = dashboard.number;
    } else {
      findings.push('"manual job" box still ticked since the last check: Renovate has not run');
    }
  }
  findings.push(...stalePrFindings(pulls, now));

  for (const finding of findings) console.log(`::error::${finding}`);
  if (findings.length === 0) console.log('Renovate is healthy.');

  if (probeIssue !== null) {
    try {
      tickProbe(repo, probeIssue);
    } catch {
      console.error('Could not tick the "manual job" box.');
      return 2;
    }
  }
  return findings.length === 0 ? 0 : 1;
}

process.exitCode = main();
