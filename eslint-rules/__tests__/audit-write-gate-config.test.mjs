// Where eslint.config.js runs `local/audit-write-gate` (#938), and with which
// tables. A mistyped glob or an extra `ignores:` entry fails open: lint stays
// green and the file's audited writes go unchecked. A stale table list fails
// open the same way, so it is compared with the schema's own map.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { AUDIT_ENTITY_TO_TABLE } from '../../src/server/db/schema.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RULE = 'local/audit-write-gate';
const GUARD = '@eslint-community/eslint-comments/no-restricted-disable';
// The one file that may assert MutatingDatabase: it mints the handle.
const MINT = 'src/server/services/mutate.ts';

function serverSources(dir = 'src/server') {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : serverSources(rel);
    return entry.name.endsWith('.ts') ? [rel] : [];
  });
}

const eslint = new ESLint({ cwd: ROOT });
const configs = await Promise.all(
  serverSources().map(async (file) => [
    file,
    await eslint.calculateConfigForFile(path.join(ROOT, file)),
  ]),
);
const severity = (setting) => (Array.isArray(setting) ? setting[0] : setting);
const options = (setting) => (Array.isArray(setting) ? setting[1] : undefined);

describe('local/audit-write-gate wiring', () => {
  it('scans the source tree', () => {
    expect(configs.map(([file]) => file)).toContain(MINT);
    expect(configs.some(([file]) => file.startsWith('src/server/repositories/'))).toBe(true);
  });

  it('checks every repository write against every audited table', () => {
    const audited = Object.values(AUDIT_ENTITY_TO_TABLE)
      .map((t) => t.drizzleExport)
      .sort();
    for (const [file, config] of configs) {
      if (!file.startsWith('src/server/repositories/')) continue;
      const setting = config.rules?.[RULE];
      expect(severity(setting), file).toBe(2);
      expect([...(options(setting)?.tables ?? [])].sort(), file).toEqual(audited);
    }
  });

  it('refuses MutatingDatabase assertions everywhere else but the mint', () => {
    for (const [file, config] of configs) {
      if (file.startsWith('src/server/repositories/')) continue;
      const setting = config.rules?.[RULE];
      if (file === MINT) {
        expect(severity(setting) ?? 0, file).toBe(0);
        continue;
      }
      expect(severity(setting), file).toBe(2);
      expect(options(setting)?.tables, file).toBeUndefined();
    }
  });

  it('refuses an inline comment disabling the rule, in every file', () => {
    for (const [file, config] of configs) {
      expect(config.rules?.[GUARD], file).toContain(RULE);
    }
  });
});
