// Unit tests for the `local/audit-write-gate` rule (#938, #946).
//
// Where the rule runs, and its table list, are tested in
// audit-write-gate-config.test.mjs.

import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, it } from 'vitest';
import rule from '../audit-write-gate.mjs';

// The message is the guard at the moment of failure: it must name the two
// legitimate ways to get the handle.
it('names mutate() and the named exceptions as the way out', () => {
  for (const id of ['write', 'rawWrite', 'cast']) {
    expect(rule.meta.messages[id]).toMatch(/mutate\(\)/);
    expect(rule.meta.messages[id]).toMatch(/exemptFromAudit/);
  }
});

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
});

const REPOSITORY = {
  tables: ['projects', 'attachments', 'projectWorkers'],
  sqlTables: ['projects', 'attachments', 'project_workers'],
};
// Outside the repositories only raw SQL is checked: no builder table list.
const SERVER = { sqlTables: REPOSITORY.sqlTables };
const write = { messageId: 'write' };
const rawWrite = { messageId: 'rawWrite' };
const cast = { messageId: 'cast' };
const IMPORTS = [
  "import { sql } from 'drizzle-orm';",
  "import { projects, attachments, projectWorkers, sessions } from '../db/schema.js';",
  "import type { Database, MutatingDatabase, TransactionalDatabase, TxHandle } from '../db/connection.js';",
].join('\n');
const repo = (body) => `${IMPORTS}\n${body}`;

ruleTester.run('audit-write-gate', rule, {
  valid: [
    {
      name: 'an audited insert through a MutatingDatabase parameter',
      code: repo(
        'export async function f(db: MutatingDatabase) { await db.insert(projects).values({}); }',
      ),
      options: [REPOSITORY],
    },
    {
      name: 'an audited update and delete through a MutatingDatabase arrow parameter',
      code: repo(
        'export const f = async (tx: MutatingDatabase) => { await tx.update(attachments).set({}); await tx.delete(projects); };',
      ),
      options: [REPOSITORY],
    },
    {
      name: 'a write to a table that is not audited',
      code: repo('export async function f(db: TxHandle) { await db.insert(sessions).values({}); }'),
      options: [REPOSITORY],
    },
    {
      name: 'a read of an audited table through any handle',
      code: repo(
        'export async function f(db: TransactionalDatabase) { return db.select().from(projects); }',
      ),
      options: [REPOSITORY],
    },
    {
      name: 'a local binding shadowing the schema table',
      code: repo(
        'export function f(m: Map<number, string>) { const projects = 1; m.delete(projects); }',
      ),
      options: [REPOSITORY],
    },
    {
      name: 'without a table list, writes are not checked (the services config)',
      code: repo('export async function f(db: TxHandle) { await db.insert(projects).values({}); }'),
    },
    // Raw SQL (#946): a write on an audited table is allowed only as an
    // inline `sql` template passed to `.execute()` on a MutatingDatabase
    // parameter.
    {
      name: 'a raw TRUNCATE through a MutatingDatabase parameter',
      code: repo(
        'export async function f(tx: MutatingDatabase) { await tx.execute(sql`TRUNCATE TABLE project_workers, projects RESTART IDENTITY CASCADE`); }',
      ),
      options: [REPOSITORY],
    },
    {
      name: 'a raw DELETE with an interpolated audited table through a MutatingDatabase parameter',
      code: repo(
        'export async function f(tx: MutatingDatabase) { await tx.execute(sql`DELETE FROM ${projects}`); }',
      ),
      options: [REPOSITORY],
    },
    {
      name: 'a raw write to a table that is not audited',
      code: repo(
        [
          'export async function f(db: TxHandle, id: string) {',
          '  await db.execute(sql`DELETE FROM sessions WHERE expires_at < now()`);',
          '  await db.execute(sql`DELETE FROM ${sessions}`);',
          '  await db.execute(sql`DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects) AND id = ${id}`);',
          '}',
        ].join('\n'),
      ),
      options: [REPOSITORY],
    },
    {
      name: 'a raw read of an audited table, including a row lock',
      code: repo(
        'export async function f(db: TxHandle) { await db.execute(sql`SELECT id, updated_at FROM projects WHERE id = 1 FOR UPDATE`); }',
      ),
      options: [REPOSITORY],
    },
    {
      name: 'row-lock and upsert clauses, with an interpolation after UPDATE',
      code: repo(
        [
          'export async function f(db: TxHandle, wait: boolean, v: number) {',
          '  await db.execute(sql`SELECT id FROM projects FOR NO KEY UPDATE`);',
          '  await db.execute(sql`SELECT id FROM projects FOR UPDATE ${wait ? sql`` : sql`SKIP LOCKED`}`);',
          '  await db.execute(sql`INSERT INTO sessions (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET n = ${v}`);',
          '}',
        ].join('\n'),
      ),
      options: [REPOSITORY],
    },
    {
      name: 'a table whose name only starts with an audited one',
      code: repo(
        'export async function f(db: TxHandle) { await db.execute(sql`DELETE FROM projects_archive`); }',
      ),
      options: [REPOSITORY],
    },
    {
      name: 'a raw fragment without a write, built apart from the query',
      code: repo("export const dir = sql.raw(1 > 0 ? 'DESC' : 'ASC');"),
      options: [REPOSITORY],
    },
    {
      name: 'without a SQL table list, raw SQL is not checked (the services config)',
      code: repo(
        'export async function f(db: TxHandle) { await db.execute(sql`DELETE FROM projects`); }',
      ),
    },
    {
      name: 'MutatingDatabase in type positions',
      code: repo(
        'type H = MutatingDatabase; export function f(h: H): MutatingDatabase { return h; }',
      ),
    },
  ],
  invalid: [
    {
      name: 'the #938 reproduction shape: an audited insert through a plain transaction handle',
      code: repo(
        'export async function createPending(db: TxHandle) { await db.insert(attachments).values({}); }',
      ),
      options: [REPOSITORY],
      errors: [write],
    },
    {
      name: 'an audited update through TransactionalDatabase',
      code: repo(
        'export async function f(db: TransactionalDatabase) { await db.update(projects).set({}); }',
      ),
      options: [REPOSITORY],
      errors: [write],
    },
    {
      name: 'an audited delete through a plain Database',
      code: repo('export async function f(db: Database) { await db.delete(projects); }'),
      options: [REPOSITORY],
      errors: [write],
    },
    {
      name: 'a parameter widened to accept a plain transaction handle',
      code: repo(
        'export async function f(db: MutatingDatabase | TxHandle) { await db.insert(projects).values({}); }',
      ),
      options: [REPOSITORY],
      errors: [write],
    },
    {
      name: 'a local type named MutatingDatabase, not the branded one',
      code: [
        "import { projects } from '../db/schema.js';",
        "import type { TxHandle } from '../db/connection.js';",
        'type MutatingDatabase = TxHandle;',
        'export async function f(db: MutatingDatabase) { await db.insert(projects).values({}); }',
      ].join('\n'),
      options: [REPOSITORY],
      errors: [write],
    },
    {
      name: 'an untyped parameter',
      code: repo('export async function f(db) { await db.insert(projects).values({}); }'),
      options: [REPOSITORY],
      errors: [write],
    },
    {
      name: 'a receiver that is not a parameter',
      code: repo(
        'declare function open(): MutatingDatabase; export async function f() { const t = open(); await t.insert(projects).values({}); }',
      ),
      options: [REPOSITORY],
      errors: [write],
    },
    {
      name: 'a member receiver',
      code: repo(
        'export class R { constructor(private db: MutatingDatabase) {} async f() { await this.db.insert(projects).values({}); } }',
      ),
      options: [REPOSITORY],
      errors: [write],
    },
    {
      name: 'an aliased table import',
      code: [
        "import { projects as p } from '../db/schema.js';",
        "import type { TxHandle } from '../db/connection.js';",
        'export async function f(db: TxHandle) { await db.insert(p).values({}); }',
      ].join('\n'),
      options: [REPOSITORY],
      errors: [write],
    },
    {
      name: 'a table through a namespace import',
      code: [
        "import * as schema from '../db/schema.js';",
        "import type { TxHandle } from '../db/connection.js';",
        'export async function f(db: TxHandle) { await db.insert(schema.projects).values({}); }',
      ].join('\n'),
      options: [REPOSITORY],
      errors: [write],
    },
    {
      name: 'a raw DELETE through a plain transaction handle',
      code: repo(
        'export async function f(db: TxHandle) { await db.execute(sql`DELETE FROM projects`); }',
      ),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'a raw TRUNCATE whose audited table is not first in a multi-line list',
      code: repo(
        'export async function f(db: TxHandle) { await db.execute(sql`TRUNCATE\n  sessions,\n  project_workers\n  RESTART IDENTITY`); }',
      ),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'raw INSERT, UPDATE and MERGE, lower case, ONLY, quoted and schema-qualified',
      code: repo(
        [
          'export async function f(db: TxHandle) {',
          '  await db.execute(sql`insert into projects (id) values (1)`);',
          '  await db.execute(sql`UPDATE ONLY "attachments" SET status = 1`);',
          '  await db.execute(sql`merge into public.projects p using x on true when matched then delete`);',
          '}',
        ].join('\n'),
      ),
      options: [REPOSITORY],
      errors: [rawWrite, rawWrite, rawWrite],
    },
    {
      name: 'a raw write spread over several lines, inside a CTE',
      code: repo(
        'export async function f(db: TxHandle) { await db.execute(sql`WITH d AS (\n  DELETE\n  FROM attachments\n  RETURNING id\n) SELECT count(*) FROM d`); }',
      ),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'a raw write with the audited table interpolated',
      code: repo(
        'export async function f(db: TxHandle) { await db.execute(sql`DELETE FROM ${projects}`); }',
      ),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'a raw write whose target cannot be resolved fails closed',
      code: repo(
        [
          'export async function f(tx: TxHandle, list: string, table: unknown) {',
          '  await tx.execute(sql`TRUNCATE TABLE ${sql.raw(list)}`);',
          '  await tx.execute(sql`DELETE FROM ${table}`);',
          '}',
        ].join('\n'),
      ),
      options: [REPOSITORY],
      errors: [rawWrite, rawWrite],
    },
    {
      name: 'an interpolated audited table whose SQL name differs from its export',
      code: repo(
        'export async function f(db: TxHandle) { await db.execute(sql`DELETE FROM ${projectWorkers}`); }',
      ),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'a raw write through a parameter widened to accept a plain transaction handle',
      code: repo(
        'export async function f(tx: MutatingDatabase | TxHandle) { await tx.execute(sql`DELETE FROM projects`); }',
      ),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'a raw write composed apart from execute(), even on a MutatingDatabase parameter',
      code: repo(
        'export async function f(tx: MutatingDatabase) { const q = sql`DELETE FROM projects`; await tx.execute(q); }',
      ),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'a raw write in sql.raw(), as a string and as an untagged template',
      code: repo(
        [
          "const WIPE = ['sessions', 'projects'];",
          'export async function f(tx: MutatingDatabase) {',
          "  await tx.execute(sql.raw('DELETE FROM projects'));",
          "  await tx.execute(sql.raw(`TRUNCATE TABLE ${WIPE.join(', ')}`));",
          '}',
        ].join('\n'),
      ),
      options: [REPOSITORY],
      errors: [rawWrite, rawWrite],
    },
    {
      name: 'a raw write as a plain string, for a driver query',
      code: repo(
        "export async function f(client: { query(q: string): Promise<unknown> }) { await client.query('DELETE FROM attachments'); }",
      ),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'a raw write through a member receiver',
      code: repo(
        'export class R { constructor(private db: MutatingDatabase) {} async f() { await this.db.execute(sql`DELETE FROM projects`); } }',
      ),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'a raw write in a template whose tag is not drizzle-orm sql',
      code: [
        "import type { MutatingDatabase } from '../db/connection.js';",
        'declare function sql(s: TemplateStringsArray): unknown;',
        'export async function f(tx: MutatingDatabase) { await tx.execute(sql`DELETE FROM projects`); }',
      ].join('\n'),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'SQL comments between the keyword and its targets',
      code: repo(
        [
          'export async function f(db: TxHandle) {',
          '  await db.execute(sql`TRUNCATE TABLE\n  sessions, -- no FK back\n  projects`);',
          '  await db.execute(sql`TRUNCATE TABLE\n  -- children first\n  project_workers`);',
          '  await db.execute(sql`DELETE /* all */ FROM projects`);',
          '}',
        ].join('\n'),
      ),
      options: [REPOSITORY],
      errors: [rawWrite, rawWrite, rawWrite],
    },
    {
      name: 'a quoted target with no space after the keyword',
      code: repo(
        'export async function f(db: TxHandle) { await db.execute(sql`DELETE FROM"projects"`); }',
      ),
      options: [REPOSITORY],
      errors: [rawWrite],
    },
    {
      name: 'a write keyword whose target is concatenated on fails closed',
      code: repo(
        [
          'export async function f(tx: MutatingDatabase, client: { query(q: string): unknown }, list: string, t: string) {',
          "  await tx.execute(sql.raw('TRUNCATE TABLE ' + list));",
          "  await client.query('DELETE FROM ' + t);",
          '}',
        ].join('\n'),
      ),
      options: [REPOSITORY],
      errors: [rawWrite, rawWrite],
    },
    {
      name: 'an interpolated target inside double quotes fails closed',
      code: repo(
        [
          'export async function f(db: TxHandle, t: string) {',
          '  await db.execute(sql.raw(`TRUNCATE "${t}"`));',
          '  await db.execute(sql.raw(`DELETE FROM "public"."${t}"`));',
          '}',
        ].join('\n'),
      ),
      options: [REPOSITORY],
      errors: [rawWrite, rawWrite],
    },
    {
      name: 'a concatenated target after a quote, a schema or ONLY fails closed',
      code: repo(
        [
          'export async function f(db: TxHandle, t: string) {',
          "  await db.execute(sql.raw('DELETE FROM \"' + t + '\"'));",
          "  await db.execute(sql.raw('DELETE FROM public.' + t));",
          "  await db.execute(sql.raw('DELETE FROM ONLY' + ' ' + t));",
          '}',
        ].join('\n'),
      ),
      options: [REPOSITORY],
      errors: [rawWrite, rawWrite, rawWrite],
    },
    {
      name: 'outside the repositories, SQL text written to be run elsewhere',
      code: repo(
        [
          "export const WIPE = 'DELETE FROM projects';",
          'export const WIPE_SQL = sql`\n  TRUNCATE TABLE ${projectWorkers}`;',
        ].join('\n'),
      ),
      options: [SERVER],
      errors: [rawWrite, rawWrite],
    },
    {
      name: 'an `as` assertion to MutatingDatabase',
      code: repo('export function f(tx: TxHandle) { return tx as MutatingDatabase; }'),
      errors: [cast],
    },
    {
      name: 'a double assertion through unknown',
      code: repo('export function f(db: Database) { return db as unknown as MutatingDatabase; }'),
      errors: [cast],
    },
    {
      name: 'an angle-bracket assertion',
      code: repo('export function f(tx: TxHandle) { return <MutatingDatabase>tx; }'),
      errors: [cast],
    },
    {
      name: 'an assertion to an aliased import of MutatingDatabase',
      code: [
        "import type { MutatingDatabase as M, TxHandle } from '../db/connection.js';",
        'export function f(tx: TxHandle) { return tx as M; }',
      ].join('\n'),
      errors: [cast],
    },
    {
      name: 'an assertion inside a repository, where the write check also runs',
      code: repo('export function f(tx: TxHandle) { return tx as MutatingDatabase; }'),
      options: [REPOSITORY],
      errors: [cast],
    },
  ],
});
