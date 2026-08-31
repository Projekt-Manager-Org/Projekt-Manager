/**
 * Generates the error-code catalogue in `docs/spec/api.md` §14.4.1 from
 * `ERROR_CODES` (`src/server/errors.ts`) — the published catalogue is
 * not hand-authored (AC-354).
 *
 * Fifth in the same family as the permissions matrix (AC-343), the nav
 * matrix (AC-349), the OpenAPI document (AC-351) and the API surface
 * table (AC-352), and it exists for the reason the others do: the
 * hand-kept list had drifted from the code in both directions at once.
 *
 * Only the catalogue sentence is generated. §14.4.1 continues below the
 * end marker with per-code prose that exists nowhere in the code —
 * which codes specialize which category, what each `details` payload
 * carries — and that stays hand-written.
 *
 * Usage:
 *   npx tsx scripts/generate-error-codes.ts           # write in place
 *   npx tsx scripts/generate-error-codes.ts --check   # verify only
 *
 * $ERROR_CODES_DOC_PATH overrides the target file — used by
 * scripts/__tests__/check-error-codes.test.sh to point at a fixture copy
 * without touching the real doc. It overrides *only* the destination:
 * Prettier's configuration is always resolved from CANONICAL_DOC_PATH,
 * so a fixture written outside the repo is byte-identical to the
 * published doc rather than silently reformatted with Prettier's
 * built-in defaults.
 *
 * Exit codes: 0 success / in-sync; 1 drift found (--check only); 2
 * toolchain error (doc file unreadable or markers missing) so the
 * caller's `set -e` trips loudly instead of silently no-op'ing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as prettier from 'prettier';
import { ERROR_CODES } from '../src/server/errors.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The published doc. Also the path Prettier's configuration is always
 * resolved from, even when writing elsewhere — see `buildExpectedDoc`.
 */
const CANONICAL_DOC_PATH = path.join(REPO_ROOT, 'docs/spec/api.md');
const DOC_PATH = process.env.ERROR_CODES_DOC_PATH ?? CANONICAL_DOC_PATH;

const START_MARKER = '<!-- GENERATED:error-codes:START';
const END_MARKER = '<!-- GENERATED:error-codes:END -->';

/**
 * Declaration order, not sorted: `ERROR_CODES` groups by domain, and
 * that grouping is the only structure the catalogue has.
 */
function renderCatalogue(): string {
  const codes = ERROR_CODES.map((code) => `\`${code}\``).join(', ');
  return `The full set of machine-readable error codes: ${codes}.\n`;
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
    console.error(`ERROR: GENERATED:error-codes markers not found in ${DOC_PATH}`);
    process.exit(2);
  }

  const startLineEnd = doc.indexOf('\n', startIdx) + 1;
  const before = doc.slice(0, startLineEnd);
  const after = doc.slice(endIdx);
  const spliced = `${before}\n${renderCatalogue()}\n${after}`;

  // CANONICAL_DOC_PATH, never DOC_PATH — see the $ERROR_CODES_DOC_PATH
  // note in the file header.
  const config = await prettier.resolveConfig(CANONICAL_DOC_PATH);
  return prettier.format(spliced, { ...config, filepath: CANONICAL_DOC_PATH });
}

const checkOnly = process.argv.includes('--check');
const expected = await buildExpectedDoc();

if (checkOnly) {
  const actual = readFileSync(DOC_PATH, 'utf8');
  if (actual === expected) {
    console.log(`OK: ${DOC_PATH} is in sync with ERROR_CODES.`);
    process.exit(0);
  }
  console.error(
    `ERROR: ${DOC_PATH}'s error-code catalogue is stale — run \`npx tsx scripts/generate-error-codes.ts\` and commit the result.`,
  );
  process.exit(1);
}

writeFileSync(DOC_PATH, expected);
console.log(`Wrote ${DOC_PATH}.`);
