#!/usr/bin/env node
//
// Section-citation drift check — a cited spec or doc section must exist.
// Rule: ARCHITECTURE.md § Design Decisions (documentation drift guards).
//
// A claim is `<file>.md §N(.N)*` in any tracked text file: a code comment
// (`data-model.md §5.1`), prose, a test name. When a section is deleted the
// citation stays — data-model.md's §5.21 outlived its section in two
// services, and #1070 found a dead one into api.md by hand. lychee
// resolves link anchors, `check-doc-paths.sh` cited paths; neither reads
// these.
//
// Claim — the file name, then `§` and a dotted number, with blanks or one
// line break — a wrapped comment line (`*`, `//`, `#`, `--` continuation)
// — allowed between them. A list (`§5.3, §6.6`, `§5.18 / §6.14`) claims
// each number in the same file. Named citations (`§ Design Decisions`)
// and dates (`§ 2026-10-29`, the ADR history headings) are not claims.
//
// File — in order:
//   1. inside a markdown link (`[api.md §14.3](api.md#143-…)`, or the link
//      followed by `§N`), the link target, relative to the citing file;
//   2. the name relative to the citing file — for a bare name, the file
//      beside it: in `docs/ops/backup/`, a bare `setup.md` is the backup one;
//   3. a path relative to the repository root; a bare name in `docs/spec/`;
//   4. the one tracked `.md` whose path ends in the name at a segment
//      boundary.
//   None, or several in step 4 → fail, asking for a path. A link target
//   that does not exist is lychee's to report, not this check's.
//
// Section — a heading of that file starting with the number (`### 5.1 …`,
// `## 3. …`), outside fenced code.
//
// Not scanned: `src/server/db/migrations/` and `src/server/db/baseline/`.
// The baseline parts are concatenated into `0000_baseline.sql`; editing
// either, even a comment, changes the migration hash and every existing
// database then needs docs/ops/recover-from-schema-change.md. Nor this
// check's self-test, whose fixtures cite dead sections on purpose.
//
// A check cannot see a citation whose section still exists but no longer
// holds the fact — renumbering existing sections makes every citation one
// of those, hence the spec convention that sections are never renumbered.
//
// Reads the git INDEX for the file list, so untracked files do not change
// the result.
//
// Exit codes:
//   0 — every claim resolves
//   1 — at least one dead or ambiguous citation; each printed as
//       `file:line: citation — reason`
//   2 — toolchain error (not a git work tree)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT =
  process.env.SECTION_CITATIONS_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXCLUDED_PREFIXES = [
  'src/server/db/migrations/',
  'src/server/db/baseline/',
  'scripts/__tests__/check-section-citations.test.sh',
];

let tracked;
try {
  tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
} catch {
  console.error(`ERROR: ${ROOT} is not a git work tree.`);
  process.exit(2);
}

function read(file) {
  try {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    return text.includes('\0') ? null : text;
  } catch {
    return null; // deleted in the work tree but still in the index
  }
}

// Section numbers per markdown file.
const HEADING = /^#{1,6}[ \t]+(\d+(?:\.\d+)*)\.?(?:[ \t]|$)/;
const FENCE = /^[ \t]*(```|~~~)/;
const sections = new Map();
for (const file of tracked.filter((f) => f.endsWith('.md'))) {
  const text = read(file);
  if (text === null) continue;
  const numbers = new Set();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = HEADING.exec(line);
      if (m) numbers.add(m[1]);
    }
  }
  sections.set(file, numbers);
}
const markdown = [...sections.keys()];

// Between the name and `§`, and between `§` and the number: blanks, or a
// line break followed by a comment-continuation marker.
// One optional break, matched one way only: a looser form backtracks
// exponentially over whitespace-only lines.
const GAP = String.raw`[ \t]*(?:\r?\n[ \t]*(?:(?:\*|\/\/|#|--)[ \t]*)?)?`;
// Not followed by a digit, `-` or `.digit`: a range or date is no claim,
// and backtracking cannot shorten `4.1-4.2` into a claim of `4`.
const DOTTED = String.raw`\d+(?:\.\d+)*(?![\d-]|\.\d)`;
const NUMBER = String.raw`§${GAP}(${DOTTED})((?:[ \t]*(?:,|\/|and|or)${GAP}§${GAP}${DOTTED})*)`;
const NAME = String.raw`((?:[\w.-]+\/)*[\w-][\w.-]*\.md)`;
// 1a: `[… name.md §N …](target.md#…)` — the claim sits in the link text.
const LINK_TEXT_CLAIM = new RegExp(String.raw`\[([^\]\n]*?)\]\(([^)\s]+?\.md)(?:#[^)\s]*)?\)`, 'g');
const TEXT_CLAIM = new RegExp(String.raw`(?<![\w./-])${NAME}[\`*_]*${GAP}${NUMBER}`, 'g');
// 1b: `[…](target.md#…) §N` — the claim follows the link.
const LINK_THEN_NUMBER = new RegExp(
  String.raw`\]\(([^)\s]+?\.md)(?:#[^)\s]*)?\)[\`*_]*${GAP}${NUMBER}`,
  'g',
);

const known = new Set(markdown);
const posix = path.posix;

function resolveName(name, citing) {
  const dir = posix.dirname(citing);
  const beside = posix.normalize(posix.join(dir, name));
  if (known.has(beside)) return { file: beside };
  if (name.includes('/')) {
    const fromRoot = posix.normalize(name);
    if (known.has(fromRoot)) return { file: fromRoot };
  } else if (known.has(`docs/spec/${name}`)) {
    return { file: `docs/spec/${name}` };
  }
  const tail = `/${name.replace(/^(\.\.?\/)+/, '')}`;
  const matches = markdown.filter((f) => f.endsWith(tail) || f === tail.slice(1));
  if (matches.length === 1) return { file: matches[0] };
  if (matches.length === 0) return { error: 'no tracked file of that name' };
  return { error: `ambiguous (${matches.join(', ')}) — cite a path` };
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const problems = [];
let claims = 0;
const FOLLOW_ON = new RegExp(String.raw`§${GAP}(${DOTTED})`, 'g');
// `first` is the claim's number, `rest` the list after it, if any.
function check(citing, text, index, citation, resolved, first, rest) {
  const numbers = [first, ...[...rest.matchAll(FOLLOW_ON)].map((m) => m[1])];
  claims += numbers.length;
  const where = `${citing}:${lineOf(text, index)}`;
  const shown = citation.replace(/\s+/g, ' ');
  if (resolved.error) {
    problems.push(`${where}: ${shown} — ${resolved.error}`);
    return;
  }
  for (const n of numbers)
    if (!sections.get(resolved.file).has(n))
      problems.push(`${where}: ${shown} — ${resolved.file} has no section ${n}`);
}

for (const citing of tracked) {
  if (EXCLUDED_PREFIXES.some((p) => citing.startsWith(p))) continue;
  const text = read(citing);
  if (text === null) continue;
  const claimed = []; // [start, end) spans already decided via a link

  for (const m of text.matchAll(LINK_TEXT_CLAIM)) {
    const inner = [...m[1].matchAll(TEXT_CLAIM)];
    if (inner.length === 0) continue;
    claimed.push([m.index, m.index + m[0].length]);
    const target = posix.normalize(posix.join(posix.dirname(citing), m[2]));
    if (!known.has(target)) continue; // lychee's finding
    for (const c of inner) check(citing, text, m.index, c[0], { file: target }, c[2], c[3]);
  }
  for (const m of text.matchAll(LINK_THEN_NUMBER)) {
    if (claimed.some(([s, e]) => m.index >= s && m.index < e)) continue;
    claimed.push([m.index, m.index + m[0].length]);
    const target = posix.normalize(posix.join(posix.dirname(citing), m[1]));
    if (!known.has(target)) continue;
    check(citing, text, m.index, m[0], { file: target }, m[2], m[3]);
  }
  for (const m of text.matchAll(TEXT_CLAIM)) {
    if (claimed.some(([s, e]) => m.index >= s && m.index < e)) continue;
    check(citing, text, m.index, m[0], resolveName(m[1], citing), m[2], m[3]);
  }
}

if (problems.length > 0) {
  console.error('Dead or ambiguous section citations:');
  for (const p of problems) console.error(`  ${p}`);
  console.error(`${problems.length} citation(s). Fix the citation, or cite a path.`);
  process.exit(1);
}
console.log(`OK: all ${claims} section citations resolve.`);
