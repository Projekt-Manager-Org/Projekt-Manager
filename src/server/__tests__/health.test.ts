/**
 * Tests for the health probe and its route (#48).
 *
 * The probe runs DB and storage checks in parallel and maps the outcome
 * to `{status, checks}`; the route in `src/server/routes/health.ts`
 * turns that into 200 or 503.
 *
 * These tests mock pg.Pool and StorageClient so we can exercise every
 * branch (both ok, db fail, storage fail, both fail) without standing
 * up real infrastructure. They live under src/server/__tests__/ and
 * therefore run in the `integration` vitest project (see vitest.config.ts),
 * but they do not require a live database or storage backend.
 */

import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { probeHealth } from '../health.js';
import { healthRoutes, type HealthDeps } from '../routes/health.js';
import type { StorageClient } from '../storage/client.js';

function mockPool(query: () => Promise<unknown>): pg.Pool {
  return { query } as unknown as pg.Pool;
}

function mockStorage(ping: () => Promise<void>): StorageClient {
  return {
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
    getSignedUrl: vi.fn(),
    ping,
  } as StorageClient;
}

describe('probeHealth', () => {
  it('returns status "ok" when both checks succeed', async () => {
    const pool = mockPool(async () => ({ rows: [{ '?column?': 1 }] }));
    const storage = mockStorage(async () => undefined);

    const result = await probeHealth(pool, storage);

    expect(result).toEqual({
      status: 'ok',
      checks: { db: 'ok', storage: 'ok' },
    });
  });

  it('returns status "degraded" when db fails', async () => {
    const pool = mockPool(async () => {
      throw new Error('connection refused');
    });
    const storage = mockStorage(async () => undefined);

    const result = await probeHealth(pool, storage);

    expect(result.status).toBe('degraded');
    expect(result.checks.db).toBe('fail');
    expect(result.checks.storage).toBe('ok');
  });

  it('returns status "degraded" when storage fails', async () => {
    const pool = mockPool(async () => ({ rows: [{ '?column?': 1 }] }));
    const storage = mockStorage(async () => {
      throw new Error('NoSuchBucket');
    });

    const result = await probeHealth(pool, storage);

    expect(result.status).toBe('degraded');
    expect(result.checks.db).toBe('ok');
    expect(result.checks.storage).toBe('fail');
  });

  it('returns status "degraded" when both fail', async () => {
    const pool = mockPool(async () => {
      throw new Error('db dead');
    });
    const storage = mockStorage(async () => {
      throw new Error('minio dead');
    });

    const result = await probeHealth(pool, storage);

    expect(result).toEqual({
      status: 'degraded',
      checks: { db: 'fail', storage: 'fail' },
    });
  });

  it('runs both checks in parallel — a hang in one does not block the other', async () => {
    // Concurrency is asserted on a deterministic VIRTUAL clock, not on
    // wall-clock elapsed time — the old `Date.now()` budget flaked under
    // load (a busy box pushed a genuinely-parallel probe past the ceiling).
    // Both checks take a virtual 40ms:
    //   - Parallel (`Promise.allSettled`): both timers are scheduled at
    //     t=0, so advancing the clock by 40ms settles the probe.
    //   - Sequential (`await` then `await`): the storage timer is only
    //     scheduled after the db check resolves at t=40, so it needs t=80
    //     — the probe is still pending after a single 40ms advance.
    // A serial refactor like `const db = await pool.query(); const st =
    // await storage.ping();` therefore leaves `settled` false and fails
    // here, deterministically and without a wall-clock budget.
    vi.useFakeTimers();
    try {
      const pool = mockPool(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({ rows: [{ '?column?': 1 }] }), 40)),
      );
      const storage = mockStorage(() => new Promise((resolve) => setTimeout(resolve, 40)));

      let settled = false;
      const probe = probeHealth(pool, storage).then((r) => {
        settled = true;
        return r;
      });

      // Advance exactly one check's worth of virtual time.
      await vi.advanceTimersByTimeAsync(40);

      // Parallel → both timers fired at t=40 → probe settled.
      // Sequential → storage timer is at t=80 → probe still pending.
      expect(settled).toBe(true);

      await expect(probe).resolves.toEqual({
        status: 'ok',
        checks: { db: 'ok', storage: 'ok' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GET /api/health', () => {
  async function inject(deps: HealthDeps | null) {
    const app = Fastify({ logger: false });
    await app.register(healthRoutes(deps));
    await app.ready();
    try {
      return await app.inject({ method: 'GET', url: '/api/health' });
    } finally {
      await app.close();
    }
  }

  it('answers 200 when both dependencies are reachable', async () => {
    const res = await inject({
      pool: mockPool(async () => ({ rows: [{ '?column?': 1 }] })),
      storage: mockStorage(async () => undefined),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { db: 'ok', storage: 'ok' } });
  });

  it('answers 503 when a dependency is down', async () => {
    const res = await inject({
      pool: mockPool(async () => ({ rows: [{ '?column?': 1 }] })),
      storage: mockStorage(async () => {
        throw new Error('NoSuchBucket');
      }),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks: { db: 'ok', storage: 'fail' } });
  });

  it('answers 503 when the app was built without probe dependencies', async () => {
    // An app with no database and no object store is degraded, so the
    // dependency-less branch reports it rather than passing a healthcheck
    // it cannot substantiate.
    const res = await inject(null);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks: { db: 'fail', storage: 'fail' } });
  });
});
