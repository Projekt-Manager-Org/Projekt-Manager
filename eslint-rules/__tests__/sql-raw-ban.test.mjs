// `sql.raw` is banned in application code (#1090, AC-787): it splices its
// argument into the query unparameterized, so one call fed request input
// is an injection. A constant needs no `sql.raw` — `sql\`DESC\`` is one;
// a name goes through `sql.identifier()`. `__tests__` keep it for fixture SQL.
//
// Linted through the repository's own config, so a mistyped glob or an
// extra `ignores:` entry fails here rather than opening silently.

import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RULE = 'no-restricted-properties';
const eslint = new ESLint({ cwd: ROOT });

async function hits(code, file) {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  // A parse failure or an ignored file reports no rule hits either.
  expect(result.messages.filter((m) => m.ruleId === null)).toEqual([]);
  return result.messages.filter((m) => m.ruleId === RULE);
}

const IMPORT = "import { sql } from 'drizzle-orm';\n";

describe('AC-787: sql.raw is banned in application code', () => {
  it.each([
    ['a repository', 'src/server/repositories/__fixture__.ts'],
    ['a service', 'src/server/services/__fixture__.ts'],
    ['a route', 'src/server/routes/__fixture__.ts'],
  ])('fails lint in %s', async (_where, file) => {
    const found = await hits(
      `${IMPORT}export const q = (input: string) => sql.raw(input);\n`,
      file,
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/sql\.identifier/);
  });

  it('catches the destructured form', async () => {
    const found = await hits(
      `${IMPORT}const { raw } = sql;\nexport const q = (input: string) => raw(input);\n`,
      'src/server/repositories/__fixture__.ts',
    );
    expect(found).toHaveLength(1);
  });

  it('leaves tests free to run fixture SQL', async () => {
    const found = await hits(
      `${IMPORT}export const q = (input: string) => sql.raw(input);\n`,
      'src/server/__tests__/__fixture__.test.ts',
    );
    expect(found).toHaveLength(0);
  });
});
