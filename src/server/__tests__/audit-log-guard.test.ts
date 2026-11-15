/**
 * AC-642: the database rejects a change to an audit entry made outside
 * the two permitted paths.
 *
 * Writes go straight to Postgres, below every service, the way a stray
 * `UPDATE audit_log` or `TRUNCATE … CASCADE` would. Each must fail with
 * a trigger raise (P0001, so a malformed statement cannot pass as a
 * rejection) and leave the entry intact.
 *
 * The permitted paths keep their own tests: a user delete clearing
 * `actor_id` (`data-integrity.test.ts`, AC-567) and retention
 * (`audit-retention.test.ts`, AC-632). Of those, this file pins only that
 * retention's allowance ends with its transaction.
 *
 * One connection for the whole file, so an allowance leaking onto a
 * pooled connection reaches the next statement.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPatch,
  expectedVersion,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { validateEnvRuntime } from '../config/env.js';
import * as schema from '../db/schema.js';
import { runAuditRetentionCleanup } from '../services/audit-retention.js';

describe('AC-642: the database rejects direct writes to audit entries', () => {
  let pool: pg.Pool;
  let ownerToken: string;
  let customerId: string;
  let entryId: string;
  let entryBefore: Record<string, unknown>;
  let phoneSuffix = 0;

  async function readEntryRow(): Promise<Record<string, unknown> | undefined> {
    const res = await pool.query('SELECT * FROM audit_log WHERE id = $1', [entryId]);
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  async function sqlStateOf(statement: string, params: unknown[] = []): Promise<string | null> {
    try {
      await pool.query(statement, params);
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? 'no-code';
    }
  }

  beforeAll(async () => {
    await startApp();
    pool = new pg.Pool({ connectionString: validateEnvRuntime().DATABASE_URL, max: 1 });
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const custList = await authGet(ownerToken, '/api/customers?limit=1');
    customerId = (custList.json().customers as { id: string }[])[0]!.id;
  });

  // A fresh entry per case, authored by owner (so `actor_id` is set).
  beforeEach(async () => {
    const patch = await authPatch(ownerToken, `/api/customers/${customerId}`, {
      ...(await expectedVersion(ownerToken, `/api/customers/${customerId}`)),
      phone: `0221-914${++phoneSuffix}`, // distinct, else a no-op records nothing
    });
    expect(patch.statusCode).toBe(200);

    const latest = await pool.query(
      `SELECT id FROM audit_log WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [customerId],
    );
    entryId = (latest.rows[0] as { id: string }).id;
    entryBefore = (await readEntryRow())!;
    expect(entryBefore.actor_id).not.toBeNull();
  });

  afterAll(async () => {
    await pool.end();
    await stopApp();
  });

  it.each([
    ['a recorded field', `UPDATE audit_log SET entity_label = 'tampered' WHERE id = $1`],
    [
      'the actor link, without deleting the user',
      `UPDATE audit_log SET actor_id = NULL WHERE id = $1`,
    ],
    ['the entry, by DELETE', `DELETE FROM audit_log WHERE id = $1`],
  ])('rejects a direct change to %s', async (_label, statement) => {
    expect(await sqlStateOf(statement, [entryId])).toBe('P0001');
    expect(await readEntryRow()).toEqual(entryBefore);
  });

  it('rejects a direct DELETE after retention ran on the same connection', async () => {
    const quietLogger = { info: () => {}, error: () => {} };
    await runAuditRetentionCleanup({
      db: drizzle(pool, { schema }),
      logger: quietLogger,
      windowDays: 90,
    });

    expect(await sqlStateOf(`DELETE FROM audit_log WHERE id = $1`, [entryId])).toBe('P0001');
    expect(await readEntryRow()).toEqual(entryBefore);
  });

  // Depth > 1 alone is not the exception: a trigger elsewhere that
  // rewrites an entry must fail too. The probe trigger lives inside a
  // transaction that is rolled back.
  it('rejects a change to a recorded field made from inside another trigger', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE TEMP TABLE audit_probe (id int);
        CREATE FUNCTION pg_temp.audit_probe_fn() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE audit_log SET entity_label = 'tampered' WHERE id = '${entryId}';
          RETURN NEW;
        END $$;
        CREATE TRIGGER audit_probe AFTER INSERT ON audit_probe
          FOR EACH ROW EXECUTE FUNCTION pg_temp.audit_probe_fn();
      `);
      const code = await client.query('INSERT INTO audit_probe VALUES (1)').then(
        () => null,
        (err: { code?: string }) => err.code ?? 'no-code',
      );
      expect(code).toBe('P0001');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await readEntryRow()).toEqual(entryBefore);
  });

  it.each([
    ['audit_log itself', 'TRUNCATE TABLE audit_log'],
    ['users, cascading over the actor FK', 'TRUNCATE TABLE users CASCADE'],
  ])('rejects a TRUNCATE of %s', async (_label, statement) => {
    expect(await sqlStateOf(statement)).toBe('P0001');
    expect(await readEntryRow()).toEqual(entryBefore);
  });
});
