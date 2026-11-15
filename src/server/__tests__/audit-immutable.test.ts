/**
 * AC-642: no caller can change or delete an audit entry.
 *
 * Owner holds every permission, so if any role could write through the
 * audit surface, owner could. Each write method on both audit paths
 * must find no route (ROUTE_NOT_FOUND) and leave the entry's row
 * identical. ROUTE_NOT_FOUND also catches a write route that would
 * reject this payload or answer a domain NOT_FOUND.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPatch,
  authPut,
  authDelete,
  expectedVersion,
  getDb,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { installNotFoundHandler } from '../error-handler.js';

describe('AC-642: audit entries are immutable through the audit routes', () => {
  let ownerToken: string;
  let customerId: string;
  let entryId: string;
  let entryBefore: Record<string, unknown>;
  let phoneSuffix = 0;

  async function readEntryRow(): Promise<Record<string, unknown> | undefined> {
    const res = await getDb().execute(sql`SELECT * FROM audit_log WHERE id = ${entryId}`);
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  beforeAll(async () => {
    // buildApp() leaves the not-found handler to its caller; mount the
    // one start.ts mounts, so a missing route answers as in production.
    await startApp({ beforeReady: installNotFoundHandler });
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const custList = await authGet(ownerToken, '/api/customers?limit=1');
    customerId = (custList.json().customers as { id: string }[])[0]!.id;
  });

  // Seed data records no audit entries (AC-623) — each case gets a fresh
  // one, so a write that slips through fails only its own case.
  beforeEach(async () => {
    const patch = await authPatch(ownerToken, `/api/customers/${customerId}`, {
      ...(await expectedVersion(ownerToken, `/api/customers/${customerId}`)),
      phone: `0221-642${++phoneSuffix}`, // distinct, else a no-op records nothing
    });
    expect(patch.statusCode).toBe(200);

    const latest = await getDb().execute(
      sql`SELECT id FROM audit_log WHERE entity_id = ${customerId}
          ORDER BY created_at DESC LIMIT 1`,
    );
    entryId = (latest.rows[0] as { id: string }).id;
    entryBefore = (await readEntryRow())!;
  });

  afterAll(async () => {
    await stopApp();
  });

  const tamper = { entityLabel: 'tampered', action: 'delete', actorId: null, payload: null };
  const attempts = [
    { method: 'PUT', path: 'entry', send: (url: string) => authPut(ownerToken, url, tamper) },
    { method: 'PATCH', path: 'entry', send: (url: string) => authPatch(ownerToken, url, tamper) },
    { method: 'DELETE', path: 'entry', send: (url: string) => authDelete(ownerToken, url) },
    { method: 'PUT', path: 'list', send: (url: string) => authPut(ownerToken, url, tamper) },
    { method: 'PATCH', path: 'list', send: (url: string) => authPatch(ownerToken, url, tamper) },
    { method: 'DELETE', path: 'list', send: (url: string) => authDelete(ownerToken, url) },
  ] as const;

  it.each(attempts)('owner $method on the audit $path path changes nothing', async (attempt) => {
    const url = attempt.path === 'entry' ? `/api/audit/${entryId}` : '/api/audit';
    const res = await attempt.send(url);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ROUTE_NOT_FOUND');
    expect(await readEntryRow()).toEqual(entryBefore);
  });
});
