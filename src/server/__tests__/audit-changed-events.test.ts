/**
 * API integration tests — `audit_changed` SSE emission.
 *
 * The ActivityFeed on the project detail surface refetched only on
 * `filterKey` change. Mutations such as adding / hiding an attachment
 * write an audit row but do NOT bump the parent project's `updatedAt`,
 * so the filterKey stayed stable and the feed showed stale data until
 * a manual reload.
 *
 * Fix: the audit publisher's `onAuditCommitted` hook fans every
 * committed audit row to the SSE bus as `audit_changed`. The client
 * `ActivityFeed` subscribes to that event and refetches the current
 * filter; the audit store's `fetchSeq` guard collapses concurrent
 * fetches into one rendered result.
 *
 * This file pins the server side:
 *   - a mutation that writes an audit row emits exactly one
 *     `audit_changed` frame on the SSE bus, post-commit;
 *   - a transaction that aborts emits no event (parity with the
 *     `project_changed` AC-276 tx-abort arm and AC-270's
 *     storage_usage_changed posture).
 *
 * Strategy mirrors `project-changed-events.test.ts`: subscribe a fake
 * connection directly to the in-process bus, drive a happy-path
 * mutation, then assert exactly one `audit_changed` frame.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';

import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { ProjectCrudService } from '../services/ProjectCrudService.js';
import type { ServiceLogger } from '../services/Logger.js';
import { AUDIT_CHANGED } from '../../config/sseEvents.js';

interface SseConnection {
  write(chunk: string): void;
}

interface SseBusModule {
  subscribe(c: SseConnection): void;
  unsubscribe(c: SseConnection): void;
}

async function loadBus(): Promise<SseBusModule> {
  const path = '../sse/bus.js';
  return (await import(/* @vite-ignore */ path)) as unknown as SseBusModule;
}

interface SubscribedFake extends SseConnection {
  chunks: string[];
}

function subscribeFake(bus: SseBusModule): SubscribedFake {
  const conn: SubscribedFake = {
    chunks: [],
    write(chunk: string): void {
      this.chunks.push(chunk);
    },
  };
  bus.subscribe(conn);
  return conn;
}

function countEvents(conn: SubscribedFake, eventName: string): number {
  // Anchor on `event: <name>\n` so a substring match cannot collide
  // with a sibling event.
  const matches = conn.chunks.join('').match(new RegExp(`event: ${eventName}\\n`, 'g'));
  return matches ? matches.length : 0;
}

function countAuditChanged(conn: SubscribedFake): number {
  return countEvents(conn, AUDIT_CHANGED);
}

async function seededCustomerIdAny(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/customers');
  const customers = (res.json().customers ?? res.json().data) as Array<{ id: string }>;
  if (!Array.isArray(customers) || customers.length === 0) {
    throw new Error('seed has no customers');
  }
  return customers[0].id;
}

async function resolveOwnerUserId(db: Database): Promise<string> {
  const row = await db.execute(
    sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
  );
  const r = row.rows[0] as { id: string } | undefined;
  if (!r) throw new Error('seed missing owner user');
  return r.id;
}

describe('audit_changed: SSE emission per audit-row commit', () => {
  let ownerToken: string;
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
  });

  afterAll(async () => {
    await pool.end();
    await stopApp();
  });

  it('emits exactly one audit_changed frame after a successful project create commit', async () => {
    const bus = await loadBus();
    const customerId = await seededCustomerIdAny(ownerToken);

    const conn = subscribeFake(bus);
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const res = await authPost(ownerToken, '/api/projects', {
        number: `AUD-${suffix}`,
        title: `audit_changed fixture ${suffix}`,
        customerId,
      });
      expect(res.statusCode).toBe(201);

      // Post-commit hook fires after the create tx commits. Drain the
      // microtask queue in case the audit publisher chooses a
      // setImmediate post-commit shape (parity with AC-276).
      await new Promise<void>((r) => setImmediate(r));

      // createProject writes exactly one audit row (the project's
      // creation), so the SSE bus sees one audit_changed frame.
      expect(countAuditChanged(conn)).toBe(1);
    } finally {
      bus.unsubscribe(conn);
    }
  });

  it('the audit_changed frame is the contentless envelope and carries no audit content', async () => {
    // AC-320's emission shipped in 31961a7; this arm pins the
    // previously-untested contentless contract: the `data:` payload is
    // the bare invalidation envelope `{ "type": "audit_changed" }` and
    // NO audit content (entity ids, labels, payload diff, actor) rides
    // the channel. Audit content is `audit:read`-gated and fetched only
    // via api.md §14.2.8 — AC-319 depends on this stream being
    // content-free so a caller lacking `audit:read` learns nothing from
    // it. Expected to PASS (retroactive coverage of a security-relevant
    // claim).
    const bus = await loadBus();
    const customerId = await seededCustomerIdAny(ownerToken);

    const conn = subscribeFake(bus);
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const title = `audit_changed contentless ${suffix}`;
      const res = await authPost(ownerToken, '/api/projects', {
        number: `AUD-CL-${suffix}`,
        title,
        customerId,
      });
      expect(res.statusCode).toBe(201);
      const projectId = res.json().id as string;

      await new Promise<void>((r) => setImmediate(r));

      const stream = conn.chunks.join('');

      // The exact contentless frame (verified-fact bus shape: a
      // payloadless broadcast emits `data: {"type":"<name>"}`).
      expect(stream).toContain('event: audit_changed\ndata: {"type":"audit_changed"}');

      // No audit content leaks onto the channel — neither the row's
      // identifiers/label nor any `{ before, after }` diff envelope keys.
      expect(stream).not.toContain(projectId);
      expect(stream).not.toContain(title);
      expect(stream).not.toContain('"payload"');
      expect(stream).not.toContain('"entityType"');
      expect(stream).not.toContain('"actorId"');
      expect(stream).not.toContain('"entityId"');
    } finally {
      bus.unsubscribe(conn);
    }
  });

  it('emits no audit_changed frame when the originating transaction aborts', async () => {
    const bus = await loadBus();
    const customerId = await seededCustomerIdAny(ownerToken);

    // Same Proxy-rejection injection point AC-276 uses for the
    // project_changed tx-abort arm: db.transaction() rejects, so no
    // audit row commits, so no frame should fire.
    const flakyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return () => Promise.reject(new Error('simulated-tx-abort'));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Database;

    const service = new ProjectCrudService(flakyDb);

    const conn = subscribeFake(bus);
    try {
      const log: ServiceLogger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      } as unknown as ServiceLogger;

      const suffix = crypto.randomUUID().slice(0, 8);
      await expect(
        service.createProject(
          {
            number: `AUD-ABORT-${suffix}`,
            title: `audit_changed tx-abort ${suffix}`,
            customerId,
          },
          await resolveOwnerUserId(db),
          log,
        ),
      ).rejects.toThrow(/simulated-tx-abort/);

      await new Promise<void>((r) => setImmediate(r));

      expect(countAuditChanged(conn)).toBe(0);
    } finally {
      bus.unsubscribe(conn);
    }
  });
});
