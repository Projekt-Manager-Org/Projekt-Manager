// Unit tests for the `local/no-direct-db-access` rule (#939).
//
// The rule's config wiring (which files it covers, the named exemptions)
// is tested separately in scripts/__tests__/check-db-access-rule.test.sh.

import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, it } from 'vitest';
import rule from '../no-direct-db-access.mjs';

// The message is the guard at the moment of failure: it must say where the
// query goes, and that regenerating the baseline is not the fix.
it('tells the reader where the query goes and not to regenerate the baseline', () => {
  expect(rule.meta.messages.query).toMatch(/src\/server\/repositories\//);
  expect(rule.meta.messages.query).toMatch(/baseline|eslint-suppressions\.json/);
});

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
});

const ALLOW = { allow: ['AUDIT_ENTITY_TYPES', 'AUDIT_EXCLUDED_FIELDS'] };
const REPOSITORY = { ...ALLOW, queries: false };
const query = { messageId: 'query' };
const reexport = { messageId: 'reexport' };

ruleTester.run('no-direct-db-access', rule, {
  valid: [
    {
      name: 'a type-only import',
      code: "import type { users } from '../db/schema.js'; let u: typeof users;",
      options: [ALLOW],
    },
    {
      name: 'a type-only specifier',
      code: "import { type users } from '../db/schema.js'; type U = typeof users.$inferSelect;",
      options: [ALLOW],
    },
    {
      name: 'a table in type positions only',
      code: [
        "import { dataExchangeJob } from '../db/schema.js';",
        'export type Job = typeof dataExchangeJob.$inferSelect;',
        'export function patch(p: Partial<typeof dataExchangeJob.$inferInsert>): void {}',
      ].join('\n'),
      options: [ALLOW],
    },
    {
      name: 'an allowed non-table constant',
      code: "import { AUDIT_ENTITY_TYPES } from '../db/schema.js'; export const t = AUDIT_ENTITY_TYPES;",
      options: [ALLOW],
    },
    {
      name: 'an allowed constant through a namespace import',
      code: "import * as schema from '../db/schema.js'; export const t = schema.AUDIT_ENTITY_TYPES;",
      options: [ALLOW],
    },
    {
      name: 'a binding imported from a non-schema module',
      code: "import { users } from './users.js'; users.find();",
      options: [ALLOW],
    },
    {
      name: 'a module named schema outside db/',
      code: "import { users } from './schema.js'; users.find();",
      filename: 'src/server/services/x.ts',
      options: [ALLOW],
    },
    {
      name: 'calls that are not database access',
      code: "map.get('k'); list.filter(Boolean); request.query; url.searchParams.get('q');",
      options: [ALLOW],
    },
    {
      name: 'a repository may query',
      code: [
        "import { users } from '../db/schema.js';",
        'export const all = (db) => db.select().from(users);',
        'export const raw = (db) => db.execute(sql`SELECT 1`);',
        'export const rel = (db) => db.query.users.findFirst();',
      ].join('\n'),
      options: [REPOSITORY],
    },
    {
      name: 'a repository may use a table inside an exported function',
      code: [
        "import { users } from '../db/schema.js';",
        'export const byId = (db, id) => db.select().from(users).where(eq(users.id, id));',
        'export default function all(db) { return db.select().from(users); }',
      ].join('\n'),
      options: [REPOSITORY],
    },
    {
      name: 'a repository may re-export an allowed constant',
      code: "export { AUDIT_ENTITY_TYPES } from '../db/schema.js';",
      options: [REPOSITORY],
    },
    {
      name: 'a repository may re-export a type',
      code: "export type { AuditEntityType } from '../db/schema.js';",
      options: [REPOSITORY],
    },
  ],
  invalid: [
    {
      name: 'a table used as a value',
      code: "import { users } from '../db/schema.js'; export const f = (db) => db.select().from(users);",
      options: [ALLOW],
      errors: [query],
    },
    {
      name: 'each reference counts',
      code: [
        "import { projects } from '../db/schema.js';",
        'export const f = (db, id) => db.select().from(projects).where(eq(projects.id, id));',
      ].join('\n'),
      options: [ALLOW],
      errors: [query, query],
    },
    {
      name: 'a table through a namespace import',
      code: "import * as schema from '../db/schema.js'; export const f = (db) => db.select().from(schema.users);",
      options: [ALLOW],
      errors: [query],
    },
    {
      name: 'a schema path without an extension',
      code: "import { users } from '../../server/db/schema'; export const f = (db) => db.select().from(users);",
      options: [ALLOW],
      errors: [query],
    },
    {
      name: 'the schema imported from next to it',
      code: "import { users } from './schema.js'; export const f = (db) => db.select().from(users);",
      filename: 'src/server/db/queries.ts',
      options: [ALLOW],
      errors: [query],
    },
    {
      name: 'raw SQL through execute()',
      code: 'export const f = (db) => db.execute(sql`SELECT 1`);',
      options: [ALLOW],
      errors: [query],
    },
    {
      name: 'raw SQL through the pg pool',
      code: "export const f = (pool) => pool.query('SELECT 1');",
      options: [ALLOW],
      errors: [query],
    },
    {
      name: 'a relational query',
      code: 'export const f = (db) => db.query.users.findMany();',
      options: [ALLOW],
      errors: [query],
    },
    {
      name: 'a module outside repositories/ re-exporting a table',
      code: "export { users } from '../db/schema.js';",
      options: [ALLOW],
      errors: [reexport],
    },
    {
      name: 'a repository re-exporting a table from the schema',
      code: "export { users } from '../db/schema.js';",
      options: [REPOSITORY],
      errors: [reexport],
    },
    {
      name: 'a repository re-exporting an imported table',
      code: "import { users } from '../db/schema.js'; export { users };",
      options: [REPOSITORY],
      errors: [reexport],
    },
    {
      name: 'a repository exporting a table under another name',
      code: "import { users } from '../db/schema.js'; export const usersTable = users;",
      options: [REPOSITORY],
      errors: [reexport],
    },
    {
      name: 'a repository exporting a table as its default',
      code: "import { users } from '../db/schema.js'; export default users;",
      options: [REPOSITORY],
      errors: [reexport],
    },
    {
      name: 'a repository exporting a table from a namespace import',
      code: "import * as schema from '../db/schema.js'; export const u = schema.users;",
      options: [REPOSITORY],
      errors: [reexport],
    },
    {
      name: 'a repository exporting tables inside an object or array',
      code: [
        "import { users, projects } from '../db/schema.js';",
        'export const byName = { users };',
        'export const all = [projects];',
      ].join('\n'),
      options: [REPOSITORY],
      errors: [reexport, reexport],
    },
    {
      name: 'a repository re-exporting a namespace import',
      code: "import * as schema from '../db/schema.js'; export { schema };",
      options: [REPOSITORY],
      errors: [reexport],
    },
    {
      name: 'a module outside repositories/ re-exporting a namespace import',
      code: "import * as schema from '../db/schema.js'; export { schema };",
      options: [ALLOW],
      errors: [reexport],
    },
    {
      name: 'a repository re-exporting the whole schema',
      code: "export * from '../db/schema.js';",
      options: [REPOSITORY],
      errors: [reexport],
    },
  ],
});
