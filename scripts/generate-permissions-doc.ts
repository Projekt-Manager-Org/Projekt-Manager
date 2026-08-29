/**
 * Generates the role-permission table in `docs/spec/api.md` §14.3 from
 * `ROLE_PERMISSIONS` (`src/config/permissions.ts`) — the published matrix
 * is not hand-authored (AC-343).
 *
 * Usage:
 *   npx tsx scripts/generate-permissions-doc.ts           # write in place
 *   npx tsx scripts/generate-permissions-doc.ts --check   # verify only
 *
 * $PERMISSIONS_DOC_PATH overrides the target file — used by
 * scripts/__tests__/check-permissions-doc.test.sh to point at a fixture
 * copy without touching the real doc. It overrides *only* the
 * destination: Prettier's configuration is always resolved from
 * CANONICAL_DOC_PATH, so a fixture written outside the repo is
 * byte-identical to the published doc rather than silently reformatted
 * with Prettier's built-in defaults.
 *
 * Exit codes: 0 success / in-sync; 1 drift found (--check only); 2
 * toolchain error (doc file unreadable or markers missing) so the
 * caller's `set -e` trips loudly instead of silently no-op'ing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as prettier from 'prettier';
import { ROLE_PERMISSIONS } from '../src/config/permissions.js';
import { ROLE_KEYS } from '../src/config/roleKeys.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The published doc. Also the path Prettier's configuration is always
 * resolved from, even when writing elsewhere — see `buildExpectedDoc`.
 */
const CANONICAL_DOC_PATH = path.join(REPO_ROOT, 'docs/spec/api.md');
const DOC_PATH = process.env.PERMISSIONS_DOC_PATH ?? CANONICAL_DOC_PATH;

const START_MARKER = '<!-- GENERATED:permissions-table:START';
const END_MARKER = '<!-- GENERATED:permissions-table:END -->';

function renderTable(): string {
  const header = '| Role | Permissions |\n| --- | --- |\n';
  const rows = ROLE_KEYS.map((role) => {
    const permissions = [...ROLE_PERMISSIONS[role]].sort().join(', ');
    return `| ${role} | ${permissions} |`;
  }).join('\n');
  return `${header}${rows}\n`;
}

async function buildExpectedDoc(): Promise<string> {
  let doc: string;
  try {
    doc = readFileSync(DOC_PATH, 'utf8');
  } catch {
    console.error(`ERROR: cannot read ${DOC_PATH}`);
    process.exit(2);
  }

  const startIdx = doc.indexOf(START_MARKER);
  const endIdx = doc.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.error(`ERROR: GENERATED:permissions-table markers not found in ${DOC_PATH}`);
    process.exit(2);
  }

  const startLineEnd = doc.indexOf('\n', startIdx) + 1;
  const before = doc.slice(0, startLineEnd);
  const after = doc.slice(endIdx);
  const spliced = `${before}\n${renderTable()}\n${after}`;

  // CANONICAL_DOC_PATH, never DOC_PATH — see the $PERMISSIONS_DOC_PATH
  // note in the file header.
  const config = await prettier.resolveConfig(CANONICAL_DOC_PATH);
  return prettier.format(spliced, { ...config, filepath: CANONICAL_DOC_PATH });
}

const checkOnly = process.argv.includes('--check');
const expected = await buildExpectedDoc();

if (checkOnly) {
  const actual = readFileSync(DOC_PATH, 'utf8');
  if (actual === expected) {
    console.log(`OK: ${DOC_PATH} is in sync with ROLE_PERMISSIONS.`);
    process.exit(0);
  }
  console.error(
    `ERROR: ${DOC_PATH}'s permission table is stale — run \`npx tsx scripts/generate-permissions-doc.ts\` and commit the result.`,
  );
  process.exit(1);
}

writeFileSync(DOC_PATH, expected);
console.log(`Wrote ${DOC_PATH}.`);
