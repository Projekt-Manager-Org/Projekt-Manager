// Unit tests for the `local/audit-write-gate` rule (#938).
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
  for (const id of ['write', 'cast']) {
    expect(rule.meta.messages[id]).toMatch(/mutate\(\)/);
    expect(rule.meta.messages[id]).toMatch(/exemptFromAudit/);
  }
});

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
});

const REPOSITORY = { tables: ['projects', 'attachments'] };
const write = { messageId: 'write' };
const cast = { messageId: 'cast' };
const IMPORTS = [
  "import { projects, attachments, sessions } from '../db/schema.js';",
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
