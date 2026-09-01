#!/usr/bin/env node
/**
 * Static check: every checksum-pinned binary install in a workflow or a
 * composite action is actually tracked by a Renovate customManager.
 *
 * WHY THIS EXISTS
 *   ADR-0027 §Decision.1 manager 6 pins CLI binaries by URL + SHA256 and
 *   relies on an inline `# renovate:` annotation to keep them current. The
 *   annotation is matched by a regex in .github/renovate.json whose
 *   `matchStrings` joins the annotation, `version=` and `expected_sha=`
 *   with `\s+` — so ANY interposed line, including a comment, drops the
 *   pin out of tracking. Nothing reports that: Renovate does not warn
 *   about annotations it failed to match, the workflow keeps passing, and
 *   the pin quietly stops advancing. That is precisely the
 *   "adopted-already-dying" failure ADR-0027 was written to retire, and it
 *   is worst on a scanner — a stale OSV-Scanner reports green while no
 *   longer knowing about new advisories.
 *
 *   It is not hypothetical: the ripgrep pin shipped in exactly that state,
 *   with two explanatory comments between its annotation and `version=`.
 *
 * WHAT IT ENFORCES
 *   1. TRACKED — every `expected_sha="<64 hex>"` in a workflow, or in a
 *      `.yml`/`.yaml`/`.sh` file at ANY depth under .github/actions/, is
 *      captured as a `currentDigest` by a customManager whose
 *      `managerFilePatterns` actually match THAT path. (Spelling the
 *      actions glob out rather than writing it: `**` followed by `/`
 *      closes a block comment.)
 *      A pin no manager claims is an untracked pin. Applicability is
 *      per-file on purpose: a manager scoped to workflows tracks nothing in
 *      a composite action, and counting it would be a false green. The
 *      actions sweep recurses while manager 6's patterns reach exactly one
 *      level, so a pin nested deeper is reported untracked — loudly —
 *      rather than seen by neither side.
 *   2. SINGLE VERSION REFERENCE — within the same install block, the
 *      version value appears exactly once (on the `version=` line).
 *      Renovate rewrites only the span its regex matched, so a version
 *      hardcoded a second time in the download URL survives the bump and
 *      the step then fetches the old asset against the new checksum. The
 *      block ends at a dedent below the `version=` line or at the next
 *      `# renovate:` annotation, whichever comes first — in a `.sh` the pin
 *      sits at column 0, so only the annotation can end it.
 *   3. KNOWN DATASOURCE — the annotation's `datasource=` names a datasource
 *      that can actually resolve an asset checksum. The manager's regex
 *      captures `[a-z-]+`, so `github-release-attachment` (singular) is a
 *      perfectly good regex match and a dead pin: Renovate resolves no such
 *      datasource and the annotation does nothing. Rules 1 and 2 cannot see
 *      that — the pin looks tracked.
 *
 *   The regexes are READ FROM .github/renovate.json rather than restated
 *   here. Restating them would let the check and the config drift apart,
 *   which is the same class of bug the check exists to catch.
 *
 * WHY NODE AND NOT BASH
 *   The other check-*.sh gates stay in POSIX shell deliberately. This one
 *   has to parse JSON and evaluate PCRE-style named-group regexes taken
 *   from that JSON; doing it in shell would mean restating the regex,
 *   which defeats the point. Node is already a hard dependency of the
 *   `lint` job (npm ci runs before every check step).
 *
 *   Renovate evaluates these with re2. For the constructs used here —
 *   named groups, character classes, `\s+` — re2 and JS RegExp agree; the
 *   check would need revisiting if a manager ever adopts backreferences or
 *   lookaround, which re2 does not support anyway.
 *
 * EXIT CODES
 *   0  every pin tracked
 *   1  an untracked pin, or a version referenced more than once
 *   2  structural problem — config unreadable, no applicable manager found,
 *      or a scan root missing
 *
 * Usage:
 *   node scripts/check-renovate-annotations.mjs
 *
 * RENOVATE_CONFIG, WORKFLOW_DIR and ACTIONS_DIR are overridable so the
 * self-test (scripts/__tests__/check-renovate-annotations.test.sh) can stage
 * mutated copies without touching the real config, workflows or actions.
 * ACTIONS_DIR defaults to WORKFLOW_DIR's sibling `actions/`, so staging the
 * two together is enough to redirect both roots. A missing scan root is an
 * error, not an empty scan.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.RENOVATE_CONFIG
  ? path.resolve(process.env.RENOVATE_CONFIG)
  : path.join(repoRoot, '.github', 'renovate.json');
const workflowDir = process.env.WORKFLOW_DIR
  ? path.resolve(process.env.WORKFLOW_DIR)
  : path.join(repoRoot, '.github', 'workflows');
// Composite actions carry checksum pins too (`install-age`), and a pin
// hidden in one is exactly as untracked as a pin hidden in a workflow.
// Derived from WORKFLOW_DIR's parent rather than repoRoot so the self-test
// redirects both roots by staging `workflows/` and `actions/` side by side.
const actionsDir = process.env.ACTIONS_DIR
  ? path.resolve(process.env.ACTIONS_DIR)
  : path.join(path.dirname(workflowDir), 'actions');

function fail(message, code) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

/** `"/^\\.github/workflows/[^/]+\\.ya?ml$/"` → RegExp. */
function toRegExp(pattern) {
  const inner = pattern.startsWith('/') && pattern.endsWith('/') ? pattern.slice(1, -1) : pattern;
  return new RegExp(inner);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  fail(`cannot read ${path.relative(repoRoot, configPath)}: ${err.message}`, 2);
}

// `managerFilePatterns` is matched against repo-relative POSIX paths, which
// is how Renovate presents them — so applicability is per file, not global.
// A manager scoped to `.github/workflows/**` does not track a pin sitting in
// a composite action, and reporting it as tracked would be the exact
// false-green this check exists to prevent.
const regexManagers = (config.customManagers ?? []).filter((m) => m.customType === 'regex');

/** Digest-capturing managers Renovate would actually apply to `relPath`. */
function digestManagersFor(relPath) {
  return regexManagers.filter(
    (m) =>
      (m.managerFilePatterns ?? []).some((p) => toRegExp(p).test(relPath)) &&
      (m.matchStrings ?? []).some((s) => s.includes('(?<currentDigest>')),
  );
}

// Structural sanity: workflows are the canonical home for these pins, so a
// config that stopped covering them is a config problem, not a pin problem.
if (digestManagersFor('.github/workflows/ci.yml').length === 0) {
  fail(
    'no customManager in .github/renovate.json captures a `currentDigest` for ' +
      '.github/workflows/** — either the config changed shape or manager 6 was ' +
      'removed. Every checksum pin in a workflow is untracked until one exists.',
    2,
  );
}

// Datasources that can resolve a release asset's SHA256, which is what an
// `expected_sha` pin needs. Deliberately short: `github-releases` is the
// near-miss — its digest is the tag's COMMIT sha (40 hex), so it would
// overwrite a 64-hex checksum with a value that fails the workflow's own
// compare (ADR-0027 §Decision.1). Widen this set only alongside a manager
// that has been shown to resolve asset digests.
const DIGEST_DATASOURCES = new Set(['github-release-attachments']);

// Each entry carries two paths. `abs` is where the bytes are; `matchPath`
// is the canonical repo-relative POSIX path Renovate would present the file
// under, and is what `managerFilePatterns` gets tested against. They differ
// whenever WORKFLOW_DIR points at a staged copy (the self-test), and using
// `abs` for matching would make every manager look inapplicable — reporting
// correctly-annotated pins as untracked.
const scanFiles = readdirSync(workflowDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .map((f) => ({
    abs: path.join(workflowDir, f),
    matchPath: `.github/workflows/${f}`,
  }));

// Everything YAML or `.sh` under `.github/actions/`. The `.sh` half is
// where the pins actually sit: a composite's procedure goes in a sibling
// script so CI's shellcheck gate covers it (`install-age.sh`,
// `start-minio.sh`). `action.yml` stays in scope because a composite may
// still hold an inline `run:` block, and a pin hidden there is exactly as
// untracked as one hidden in a script.
//
// RECURSIVE, deliberately, even though the repo lays composite actions out
// one level deep and manager 6's `managerFilePatterns` reach exactly that
// far. A sweep that stopped at one level too would leave a pin nested any
// deeper seen by NEITHER side — tracked by no manager and reported by no
// check, which is the silent freeze this whole file exists to prevent.
// Scanning wider than the managers is the point: a file class no manager
// covers is then reported as an untracked pin, loudly.
const ACTION_FILE_RE = /\.(ya?ml|sh)$/;

// A scan root that is not there scans nothing and reports OK — the same
// false green, arrived at by a different route.
if (!existsSync(actionsDir)) {
  fail(
    `${path.relative(repoRoot, actionsDir)} does not exist — composite actions are a scan root ` +
      'for checksum pins (.github/renovate.json manager 6). If they moved, move this check and ' +
      'the manager patterns with them; scanning nothing silently is not an option.',
    2,
  );
}

function collectActionFiles(dir, relDir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const abs = path.join(dir, entry.name);
    const matchPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) collectActionFiles(abs, matchPath);
    else if (entry.isFile() && ACTION_FILE_RE.test(entry.name)) scanFiles.push({ abs, matchPath });
  }
}
collectActionFiles(actionsDir, '.github/actions');

const problems = [];
let pinCount = 0;

for (const { abs, matchPath } of scanFiles) {
  const rel = path.relative(repoRoot, abs);
  const content = readFileSync(abs, 'utf8');
  const lines = content.split('\n');

  // Digests Renovate would actually see, per manager applicable to THIS
  // file — a manager scoped elsewhere tracks nothing here.
  const tracked = new Map(); // digest -> { version, datasource }
  for (const manager of digestManagersFor(matchPath)) {
    for (const matchString of manager.matchStrings ?? []) {
      const re = new RegExp(matchString, 'g');
      for (const m of content.matchAll(re)) {
        if (m.groups?.currentDigest) {
          tracked.set(m.groups.currentDigest, {
            version: m.groups.currentValue ?? null,
            // Falls back to the manager's template when the annotation
            // does not carry one — Renovate resolves it the same way.
            datasource: m.groups.datasource ?? manager.datasourceTemplate ?? null,
          });
        }
      }
    }
  }

  // Every checksum pin present in the file.
  lines.forEach((line, i) => {
    const pin = /expected_sha="([a-f0-9]{64})"/.exec(line);
    if (!pin) return;
    pinCount += 1;
    const digest = pin[1];
    const lineNo = i + 1;

    if (!tracked.has(digest)) {
      // Diagnose the common cause rather than just reporting the symptom.
      const preceding = lines.slice(Math.max(0, i - 6), i);
      const annotationOffset = preceding.findIndex((l) => /#\s*renovate:/.test(l));
      let hint;
      if (annotationOffset === -1) {
        hint = 'no `# renovate:` annotation within the 6 lines above it — add one';
      } else {
        const between = preceding.slice(annotationOffset + 1).filter((l) => l.trim() !== '');
        const interposed = between.filter((l) => /^\s*#/.test(l));
        hint = interposed.length
          ? `${interposed.length} comment line(s) sit between the annotation and this pin — ` +
            'the manager regex joins them with `\\s+`, so move the prose ABOVE the annotation'
          : 'an annotation is present but the manager regex did not match it — check the ' +
            '`datasource=`/`depName=` spelling and that `version=` is the very next line';
      }
      problems.push(`${rel}:${lineNo}  untracked checksum pin — ${hint}`);
      return;
    }

    // Rule 3: the datasource has to be one that resolves asset checksums.
    const { version, datasource } = tracked.get(digest);
    if (!DIGEST_DATASOURCES.has(datasource)) {
      problems.push(
        `${rel}:${lineNo}  datasource "${datasource}" cannot resolve an asset checksum — ` +
          `expected one of: ${[...DIGEST_DATASOURCES].join(', ')}. The manager regex captures ` +
          '`[a-z-]+`, so a misspelling matches happily and then resolves to nothing.',
      );
      return;
    }

    // Rule 2: the version must be referenced exactly once in the block.
    if (!version) return;
    const versionLineIdx = lines.findIndex(
      (l, j) => j < i && j >= i - 6 && l.includes(`version="${version}"`),
    );
    if (versionLineIdx === -1) return;

    // Where the pin's block ends. Two terminators, whichever comes first:
    //
    //   - a dedent below the `version=` line's own indentation. This is
    //     what bounds a `run:` body in a workflow, and what bounds NOTHING
    //     in a `.sh`, where the pin sits at column 0 and no later line can
    //     be shallower.
    //   - the next `# renovate:` annotation, which starts another pin's
    //     block and therefore ends this one. In a single-pin script that
    //     degrades to end-of-file, which is the right scope: any line of a
    //     standalone install script can fetch the asset.
    //
    // Without the second terminator, two pins in one script share a block:
    // the first swallows the second's `version=` line, and two tools that
    // happen to sit on the same version are reported as a duplicate use.
    const baseIndent = lines[versionLineIdx].search(/\S/);
    let end = versionLineIdx + 1;
    while (end < lines.length) {
      const l = lines[end];
      if (l.trim() !== '' && l.search(/\S/) < baseIndent) break;
      if (/#\s*renovate:/.test(l)) break;
      end += 1;
    }
    const block = lines.slice(versionLineIdx, end);
    // Comment lines are excluded: prose legitimately names the version it
    // documents ("no severity flag in CLI v2.3.8"), and Renovate rewriting
    // only the `version=` span is harmless there — a stale comment is a
    // docs nit, not a step that fetches the wrong asset. Counting them
    // would make the rule unsatisfiable short of rewording the comment.
    // Same reason `check-workflow-drift.sh` strips comments before diffing.
    const literalUses = block.filter((l) => !/^\s*#/.test(l) && l.includes(version)).length;
    if (literalUses > 1) {
      problems.push(
        `${rel}:${versionLineIdx + 1}  version "${version}" appears ${literalUses} times in ` +
          'this install block — Renovate rewrites only the `version=` line, so the other use would ' +
          'keep pointing at the old release. Derive it from "${version}" instead.',
      );
    }
  });
}

if (problems.length > 0) {
  console.error('ERROR: Renovate annotation problems found.\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error('');
  console.error('A checksum pin with no update path is the failure ADR-0027 exists to retire:');
  console.error('the version freezes silently while CI stays green. See');
  console.error(
    '.github/renovate.json manager 6 and docs/ops/dep-management.md § Weekly wrangler.',
  );
  process.exit(1);
}

console.log(`OK: ${pinCount} checksum-pinned binary install(s) tracked by Renovate`);
console.log(`  files scanned:     ${scanFiles.length} (workflows + composite actions)`);
