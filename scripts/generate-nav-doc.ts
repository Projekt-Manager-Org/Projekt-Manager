/**
 * Generates the per-role nav matrix in `docs/spec/ui/index.md` §8.7.1
 * from `ROUTE_DEFINITIONS` (`src/config/routes.ts`) — the published
 * table is not hand-authored (AC-349).
 *
 * Sibling of `generate-permissions-doc.ts`, same markers-and-`--check`
 * shape. What differs is scope: only the machine-derivable columns are
 * generated. The per-view prose below the table — why the worker list
 * is phone-first, how the Verwaltung grouping behaves — is spec intent
 * that exists nowhere in the code, and generating over it would delete
 * the only part worth reading.
 *
 * The Access column publishes the RULE, not just its outcome. That is
 * why `RouteAccess` is data: `hasPermission(u.roles, 'invoice:read')` as
 * a closure can be evaluated but not read, so a generator could only
 * ever print the role set it resolves to today and the spec would lose
 * "`invoice:read` required".
 *
 * Roles are resolved against `ROLE_KEYS`, which AC-343 keeps exhaustive
 * over production roles by construction — a new role cannot silently
 * go missing from the published matrix.
 *
 * Usage:
 *   npx tsx scripts/generate-nav-doc.ts           # write in place
 *   npx tsx scripts/generate-nav-doc.ts --check   # verify only
 *
 * $NAV_DOC_PATH overrides the target file — used by
 * scripts/__tests__/check-nav-doc.test.sh to point at a fixture copy
 * without touching the real doc.
 *
 * Exit codes: 0 success / in-sync; 1 drift found (--check only); 2
 * toolchain error (doc file unreadable or markers missing) so the
 * caller's `set -e` trips loudly instead of silently no-op'ing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as prettier from 'prettier';
import { ROUTES, type RouteAccess, type RouteEntry } from '../src/config/routes.js';
import { ROLE_KEYS } from '../src/config/roleKeys.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = process.env.NAV_DOC_PATH ?? path.join(REPO_ROOT, 'docs/spec/ui/index.md');

const START_MARKER = '<!-- GENERATED:nav-matrix:START';
const END_MARKER = '<!-- GENERATED:nav-matrix:END -->';

/** The rule, as the spec should read it. */
function renderRule(access: RouteAccess): string {
  return access.kind === 'role'
    ? `Role: ${access.roles.join(', ')}`
    : `\`${access.permission}\``;
}

/** The rule's outcome over the production role set. */
function resolveRoles(entry: RouteEntry): string {
  const granted = ROLE_KEYS.filter((role) => entry.canAccess({ roles: [role] }));
  return granted.length > 0 ? granted.join(', ') : '—';
}

function renderLanding(entry: RouteEntry): string {
  const landing = ROLE_KEYS.filter((role) => entry.isDefaultFor({ roles: [role] }));
  return landing.length > 0 ? landing.join(', ') : '—';
}

function renderTable(): string {
  const header =
    '| View | Path | Label | Access | Roles | Landing |\n| --- | --- | --- | --- | --- | --- |\n';
  // Parametrized paths are deep-link targets, not nav entries — the same
  // `/:` filter `visibleRoutesForUser` applies. Their access rules are
  // documented where the surface is specified.
  const rows = ROUTES.filter((entry) => !entry.path.includes('/:'))
    .map(
      (entry) =>
        `| \`${entry.view}\` | \`${entry.path}\` | "${entry.label}" | ${renderRule(entry.access)} | ${resolveRoles(entry)} | ${renderLanding(entry)} |`,
    )
    .join('\n');
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
    console.error(`ERROR: GENERATED:nav-matrix markers not found in ${DOC_PATH}`);
    process.exit(2);
  }

  const startLineEnd = doc.indexOf('\n', startIdx) + 1;
  const before = doc.slice(0, startLineEnd);
  const after = doc.slice(endIdx);
  const spliced = `${before}\n${renderTable()}\n${after}`;

  const config = await prettier.resolveConfig(DOC_PATH);
  return prettier.format(spliced, { ...config, filepath: DOC_PATH });
}

const checkOnly = process.argv.includes('--check');
const expected = await buildExpectedDoc();

if (checkOnly) {
  const actual = readFileSync(DOC_PATH, 'utf8');
  if (actual === expected) {
    console.log(`OK: ${DOC_PATH} is in sync with ROUTE_DEFINITIONS.`);
    process.exit(0);
  }
  console.error(
    `ERROR: ${DOC_PATH}'s nav matrix is stale — run \`npx tsx scripts/generate-nav-doc.ts\` and commit the result.`,
  );
  process.exit(1);
}

writeFileSync(DOC_PATH, expected);
console.log(`Wrote nav matrix to ${DOC_PATH}.`);
