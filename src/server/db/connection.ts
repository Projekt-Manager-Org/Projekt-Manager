/**
 * Database connection — Drizzle ORM over node-postgres.
 *
 * Reads DATABASE_URL from environment. Exports a factory
 * function so tests can create isolated connections.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { validateEnvRuntime } from '../config/env.js';
import * as schema from './schema.js';

const { Pool } = pg;

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A transaction handle — the argument Drizzle passes to a
 * `db.transaction(tx => ...)` callback.
 */
export type TxHandle = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * A `Database` or a transaction handle. Repository READ functions accept
 * this — they are callable from top-level code (with `db`) and from
 * inside a transaction (with `tx`).
 */
export type TransactionalDatabase = Database | TxHandle;

/**
 * Transaction handle ONLY — **not** a plain `Database`. Repository WRITE
 * functions on audited tables accept this so the type system enforces
 * AC-179: a mutation can only be authored from inside a transaction,
 * i.e. from inside `mutate()` / `mutateInTx()` (ADR-0021). Attempting to
 * call a write with a plain `Database` fails `tsc` — the bypass the
 * static arch check can't reliably detect (the scan can't distinguish
 * `db.insert(...)` from `tx.insert(...)`).
 */
export type MutatingDatabase = TxHandle;

export interface ConnectionOptions {
  connectionString?: string;
  /**
   * Session default for `lock_timeout`, in milliseconds, applied to
   * every connection this pool opens (node-postgres puts it in the
   * startup packet). Omitted = Postgres' default of "wait forever".
   *
   * The backup runner sets it (AC-345): every statement a run issues —
   * including the status-row write that reports the failure — must give
   * up rather than block behind an ACCESS EXCLUSIVE holder, because a
   * parked tick suppresses every later run through croner's
   * `protect: true`. A `SET LOCAL` inside the one transaction cannot
   * cover the writes that happen outside it, and a session-level `SET`
   * on a pooled client would leak into the next checkout.
   *
   * Not set for the app: a request that waits on a lock returns a slow
   * response, not a silent outage, and the timeout would surface as
   * user-visible errors during any migration.
   */
  lockTimeoutMs?: number;
}

/**
 * Create a Drizzle database instance backed by a pg Pool.
 *
 * In production, DATABASE_URL must be explicitly set — no fallback is allowed.
 * In dev/test the convenience fallback still works.
 */
export function createDatabase(opts: ConnectionOptions = {}): {
  db: Database;
  pool: pg.Pool;
} {
  // Route env reads through the validated loader so there is a single
  // source of truth for NODE_ENV and friends (consolidation review C-3 /
  // ADR-0013). validateEnvRuntime() re-parses process.env on every call
  // (the earlier singleton cache was dropped to keep test fixtures
  // truthful); calling it defensively here is cheap and matches whatever
  // start.ts saw. Integration tests that call createDatabase() directly
  // (db-constraints, bootstrap, rate-limit) rely on this defensive call
  // because they do not go through start.ts.
  const env = validateEnvRuntime();
  const connectionString = opts.connectionString ?? env.DATABASE_URL;

  const pool = new Pool({ connectionString, lock_timeout: opts.lockTimeoutMs });
  attachPoolErrorHandler(pool);
  const db = drizzle(pool, { schema });

  return { db, pool };
}

/**
 * Attach the canonical 'error' handler to a pg.Pool.
 *
 * Idle pool clients emit `error` when their backend is terminated
 * externally (`pg_terminate_backend`, postgres restart, network drop).
 * node-postgres documents the requirement: without a listener the
 * process crashes with the uncaught Error. The handler logs and
 * returns — node-postgres discards the dead client and subsequent
 * queries acquire fresh connections transparently. Exported so every
 * `new Pool` site uses the same listener; the alternative (inline at
 * each call) is how this footgun re-grows.
 */
export function attachPoolErrorHandler(pool: pg.Pool): void {
  pool.on('error', (err) => {
    console.error(JSON.stringify({ event: 'pg-pool-client-error', message: err.message }));
  });
}
