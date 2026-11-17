// Where eslint.config.js runs `local/audit-write-gate` (#938, #946), and with
// which tables. A mistyped glob or an extra `ignores:` entry fails open: lint
// stays green and the file's audited writes go unchecked. A stale table list fails
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
// Files whose raw SQL writes audited tables on purpose, unchecked.
const RAW_EXEMPT = [
  // The dev seed's wipe (data-model.md §7).
  'src/server/seed.ts',
];

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
    const auditedSql = Object.values(AUDIT_ENTITY_TO_TABLE)
      .map((t) => t.sqlName)
      .sort();
    for (const [file, config] of configs) {
      if (!file.startsWith('src/server/repositories/')) continue;
      const setting = config.rules?.[RULE];
      expect(severity(setting), file).toBe(2);
      expect([...(options(setting)?.tables ?? [])].sort(), file).toEqual(audited);
      expect([...(options(setting)?.sqlTables ?? [])].sort(), file).toEqual(auditedSql);
    }
  });

  it('names each audited table in SQL as its export in snake case', () => {
    // The rule resolves an interpolated table (`${projectWorkers}`) this way.
    for (const { sqlName, drizzleExport } of Object.values(AUDIT_ENTITY_TO_TABLE)) {
      expect(drizzleExport.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)).toBe(sqlName);
    }
  });

  it('refuses MutatingDatabase assertions and raw audited writes everywhere else', () => {
    const auditedSql = Object.values(AUDIT_ENTITY_TO_TABLE)
      .map((t) => t.sqlName)
      .sort();
    for (const [file, config] of configs) {
      if (file.startsWith('src/server/repositories/')) continue;
      const setting = config.rules?.[RULE];
      if (file === MINT) {
        expect(severity(setting) ?? 0, file).toBe(0);
        continue;
      }
      expect(severity(setting), file).toBe(2);
      expect(options(setting)?.tables, file).toBeUndefined();
      const sqlTables = RAW_EXEMPT.includes(file) ? [] : auditedSql;
      expect([...(options(setting)?.sqlTables ?? [])].sort(), file).toEqual(sqlTables);
    }
  });

  it('names only existing files as raw-SQL exemptions', () => {
    const files = configs.map(([file]) => file);
    for (const file of RAW_EXEMPT) expect(files).toContain(file);
  });

  it('refuses an inline comment disabling the rule, in every file', () => {
    for (const [file, config] of configs) {
      expect(config.rules?.[GUARD], file).toContain(RULE);
    }
  });
});
