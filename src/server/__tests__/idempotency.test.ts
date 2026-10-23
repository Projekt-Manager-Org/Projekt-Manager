/**
 * Integration tests: client-supplied id / idempotent create.
 *
 * Covers AC-124 (customer idempotent create), AC-477 (project idempotent
 * create), and AC-127 (IDEMPOTENCY_CONFLICT on body mismatch). Exercises
 * POST /api/customers and POST /api/projects with the optional `id` field:
 * fresh insert, replay on identical body, IDEMPOTENCY_CONFLICT on
 * mismatched body, malformed id rejection, and the two race cases
 * (same id + same body, same id + different body).
 *
 * The race cases mirror the shape of AC-94 (data-integrity.test.ts), using
 * Promise.all on two inject() calls and asserting on the resulting status
 * code pair plus the committed DB state.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

/**
 * Project numbers are capped at 20 chars by the DB schema. Build a short
 * tag from a per-file counter so each test's number stays unique within
 * the file and inside the cap.
 */
let projectNumberCounter = 0;
function nextProjectNumber(prefix: string): string {
  projectNumberCounter++;
  // 20-char cap: "I-" + prefix (max 12) + "-" + counter (up to 4 digits)
  const capped = prefix.slice(0, 12);
  return `I-${capped}-${projectNumberCounter}`;
}

describe('Idempotent create with client-supplied id', () => {
  let ownerToken: string;
  let seededCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const customerRes = await authGet(ownerToken, '/api/customers');
    seededCustomerId = customerRes.json().customers[0].id;
  });

  afterAll(async () => {
    await stopApp();
  });

  // -----------------------------------------------------------------
  // Customers
  // -----------------------------------------------------------------
  describe('POST /api/customers', () => {
    it('accepts a client-supplied UUID and returns the new row with that id', async () => {
      const id = randomUUID();
      const res = await authPost(ownerToken, '/api/customers', {
        id,
        name: 'Idempotent Customer 1',
        phone: '0123-4567',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().id).toBe(id);
      expect(res.json().name).toBe('Idempotent Customer 1');
    });

    it('replays an identical body under the same id and does not duplicate the row', async () => {
      const id = randomUUID();
      const body = {
        id,
        name: 'Idempotent Customer 2',
        phone: '0111-2222',
        email: 'idem2@example.de',
        address: { street: 'Teststr. 1', zip: '10115', city: 'Berlin' },
        notes: 'note',
      };
      const first = await authPost(ownerToken, '/api/customers', body);
      expect(first.statusCode).toBe(201);
      const firstId = first.json().id;

      const second = await authPost(ownerToken, '/api/customers', body);
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(firstId);

      // Search the listing for this name — must see exactly one hit.
      const list = await authGet(
        ownerToken,
        `/api/customers?search=${encodeURIComponent('Idempotent Customer 2')}`,
      );
      const matches = list
        .json()
        .customers.filter((c: Record<string, unknown>) => c.name === 'Idempotent Customer 2');
      expect(matches).toHaveLength(1);
    });

    it('rejects same id + different body with 409 IDEMPOTENCY_CONFLICT', async () => {
      const id = randomUUID();
      const first = await authPost(ownerToken, '/api/customers', {
        id,
        name: 'Idempotent Customer 3',
      });
      expect(first.statusCode).toBe(201);

      const second = await authPost(ownerToken, '/api/customers', {
        id,
        name: 'Different Name',
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('rejects same id + address-only mismatch with 409', async () => {
      const id = randomUUID();
      const base = {
        id,
        name: 'Idem Addr',
        address: { street: 'A', zip: '12345', city: 'X' },
      };
      expect((await authPost(ownerToken, '/api/customers', base)).statusCode).toBe(201);

      const mismatched = await authPost(ownerToken, '/api/customers', {
        ...base,
        address: { street: 'A', zip: '12345', city: 'Y' },
      });
      expect(mismatched.statusCode).toBe(409);
      expect(mismatched.json().code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('omitted id still produces a server-generated id (existing behavior preserved)', async () => {
      const res = await authPost(ownerToken, '/api/customers', {
        name: 'Server Generated Id',
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(typeof body.id).toBe('string');
      // UUID v4 sanity check — Postgres defaultRandom() emits v4.
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('rejects a malformed id with a client-error validation response', async () => {
      const res = await authPost(ownerToken, '/api/customers', {
        id: 'not-a-uuid',
        name: 'Malformed Id',
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });
  });

  // -----------------------------------------------------------------
  // Projects
  // -----------------------------------------------------------------
  describe('POST /api/projects', () => {
    it('accepts a client-supplied UUID and returns the new row with that id', async () => {
      const id = randomUUID();
      const res = await authPost(ownerToken, '/api/projects', {
        id,
        number: nextProjectNumber('FRESH'),
        title: 'Idem Project 1',
        customerId: seededCustomerId,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().id).toBe(id);
    });

    it('replays an identical body under the same id and does not duplicate the row', async () => {
      const id = randomUUID();
      const number = nextProjectNumber('REPLAY');
      const body = {
        id,
        number,
        title: 'Idem Project 2',
        customerId: seededCustomerId,
        plannedStart: '2026-07-01',
        plannedEnd: '2026-07-14',
        estimatedValue: 1234.5,
        notes: 'initial',
      };
      const first = await authPost(ownerToken, '/api/projects', body);
      expect(first.statusCode).toBe(201);
      const second = await authPost(ownerToken, '/api/projects', body);
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);

      // Only one row must carry this number.
      const list = await authGet(ownerToken, '/api/projects');
      const hits = list.json().data.filter((p: Record<string, unknown>) => p.number === number);
      expect(hits).toHaveLength(1);
    });

    it('rejects same id + different body with 409 IDEMPOTENCY_CONFLICT', async () => {
      const id = randomUUID();
      const firstNumber = nextProjectNumber('DIFF');
      const first = await authPost(ownerToken, '/api/projects', {
        id,
        number: firstNumber,
        title: 'Idem Project 3',
        customerId: seededCustomerId,
      });
      expect(first.statusCode).toBe(201);

      const second = await authPost(ownerToken, '/api/projects', {
        id,
        number: firstNumber,
        title: 'Different Title',
        customerId: seededCustomerId,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('replays when only assignedWorkerIds order differs (set semantics)', async () => {
      // Get two worker ids.
      const w1Tok = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
      const w2Tok = await login(SEED_USERS.worker2.username, SEED_DEFAULT_PASSWORD);
      const w1 = (await authGet(w1Tok, '/api/auth/me')).json().user.id;
      const w2 = (await authGet(w2Tok, '/api/auth/me')).json().user.id;

      const id = randomUUID();
      const number = nextProjectNumber('WORKERS');
      const first = await authPost(ownerToken, '/api/projects', {
        id,
        number,
        title: 'Worker Order',
        customerId: seededCustomerId,
        assignedWorkerIds: [w1, w2],
      });
      expect(first.statusCode).toBe(201);

      const second = await authPost(ownerToken, '/api/projects', {
        id,
        number,
        title: 'Worker Order',
        customerId: seededCustomerId,
        assignedWorkerIds: [w2, w1],
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);
    });

    it('omitted id still produces a server-generated id (existing behavior preserved)', async () => {
      const res = await authPost(ownerToken, '/api/projects', {
        number: nextProjectNumber('NOCLI'),
        title: 'No Client Id',
        customerId: seededCustomerId,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('rejects a malformed id with a client-error validation response', async () => {
      const res = await authPost(ownerToken, '/api/projects', {
        id: 'not-a-uuid',
        number: nextProjectNumber('BADID'),
        title: 'Malformed Id',
        customerId: seededCustomerId,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('replays when estimatedValue exceeds numeric(12,2) precision (incoming rounded to match stored)', async () => {
      const id = randomUUID();
      const number = nextProjectNumber('ROUND');
      const body = {
        id,
        number,
        title: 'Rounding Replay',
        customerId: seededCustomerId,
        // 1234.567 → Postgres numeric(12,2) → stored as 1234.57. A naive
        // comparator would reject the retry; the rounding rule in
        // idempotency.ts treats both sides as cent-accurate scalars.
        estimatedValue: 1234.567,
      };
      const first = await authPost(ownerToken, '/api/projects', body);
      expect(first.statusCode).toBe(201);
      const second = await authPost(ownerToken, '/api/projects', body);
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);
    });

    it('retry with omitted assignedWorkerIds against stored [w1] → 409 (not a logical match)', async () => {
      const w1Tok = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
      const w1 = (await authGet(w1Tok, '/api/auth/me')).json().user.id;

      const id = randomUUID();
      const number = nextProjectNumber('WOMIT');
      const first = await authPost(ownerToken, '/api/projects', {
        id,
        number,
        title: 'Omit Workers',
        customerId: seededCustomerId,
        assignedWorkerIds: [w1],
      });
      expect(first.statusCode).toBe(201);

      // Second call drops the field. Comparator treats `undefined` as `[]`
      // (empty set), which does not match stored `[w1]` → IDEMPOTENCY_CONFLICT.
      const second = await authPost(ownerToken, '/api/projects', {
        id,
        number,
        title: 'Omit Workers',
        customerId: seededCustomerId,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('duplicate number without client id produces a templated 409 mentioning the number', async () => {
      const number = nextProjectNumber('DUPNUM');
      const first = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'first',
        customerId: seededCustomerId,
      });
      expect(first.statusCode).toBe(201);

      const second = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'second',
        customerId: seededCustomerId,
      });
      expect(second.statusCode).toBe(409);
      const body = second.json();
      expect(body.code).toBe('CONFLICT');
      expect(body.message).toBe(`Projektnummer "${number}" ist bereits vergeben.`);
    });
  });

  // -----------------------------------------------------------------
  // Races (Promise.all pairs, same id)
  // -----------------------------------------------------------------
  describe('Concurrent POSTs with the same client-supplied id', () => {
    it('customers: same id + same body → exactly one row, both calls succeed', async () => {
      const id = randomUUID();
      const body = { id, name: `Race Same Body ${id}` };
      const [a, b] = await Promise.all([
        authPost(ownerToken, '/api/customers', body),
        authPost(ownerToken, '/api/customers', body),
      ]);
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);
      expect(a.json().id).toBe(id);
      expect(b.json().id).toBe(id);

      const list = await authGet(
        ownerToken,
        `/api/customers?search=${encodeURIComponent(body.name)}`,
      );
      expect(
        list.json().customers.filter((c: Record<string, unknown>) => c.name === body.name),
      ).toHaveLength(1);
    });

    it('customers: same id + different body → one 201, one 409, one row committed matches the winner', async () => {
      const id = randomUUID();
      const bodyA = { id, name: `Race Diff A ${id}` };
      const bodyB = { id, name: `Race Diff B ${id}` };
      const [a, b] = await Promise.all([
        authPost(ownerToken, '/api/customers', bodyA),
        authPost(ownerToken, '/api/customers', bodyB),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([201, 409]);

      const winner = a.statusCode === 201 ? bodyA : bodyB;
      const loser = a.statusCode === 201 ? b : a;
      expect(loser.json().code).toBe('IDEMPOTENCY_CONFLICT');

      const getRes = await authGet(ownerToken, `/api/customers/${id}`);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().name).toBe(winner.name);
    });

    it('projects: same id + same body → exactly one row, both calls succeed', async () => {
      const id = randomUUID();
      const number = nextProjectNumber('RACESAME');
      const body = {
        id,
        number,
        title: 'Race Same Project',
        customerId: seededCustomerId,
      };
      const [a, b] = await Promise.all([
        authPost(ownerToken, '/api/projects', body),
        authPost(ownerToken, '/api/projects', body),
      ]);
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);
      expect(a.json().id).toBe(id);
      expect(b.json().id).toBe(id);

      const list = await authGet(ownerToken, '/api/projects');
      expect(
        list.json().data.filter((p: Record<string, unknown>) => p.number === number),
      ).toHaveLength(1);
    });

    it('projects: same id + different body → one 201, one 409, one row committed matches the winner', async () => {
      const id = randomUUID();
      const numberA = nextProjectNumber('RACEA');
      const numberB = nextProjectNumber('RACEB');
      const bodyA = {
        id,
        number: numberA,
        title: 'Race Diff A',
        customerId: seededCustomerId,
      };
      const bodyB = {
        id,
        number: numberB,
        title: 'Race Diff B',
        customerId: seededCustomerId,
      };
      const [a, b] = await Promise.all([
        authPost(ownerToken, '/api/projects', bodyA),
        authPost(ownerToken, '/api/projects', bodyB),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([201, 409]);

      const winner = a.statusCode === 201 ? bodyA : bodyB;
      const loser = a.statusCode === 201 ? b : a;
      expect(loser.json().code).toBe('IDEMPOTENCY_CONFLICT');

      const getRes = await authGet(ownerToken, `/api/projects/${id}`);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().number).toBe(winner.number);
      expect(getRes.json().title).toBe(winner.title);
    });
  });
});
