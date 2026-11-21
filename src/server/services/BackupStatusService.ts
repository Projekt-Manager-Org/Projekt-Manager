/**
 * Read-side service for the backup-freshness surface.
 *
 * The write path (upsert on each run) lives in `services/backup.ts`. This
 * service carries the READ surface so routes can render the badge without
 * reaching into the repository (ARCHITECTURE.md § Architecture Overview —
 * routes delegate to services, not repositories).
 *
 * Kept deliberately thin: just a read. The complexity of the write
 * path does not belong here; keeping the two surfaces separate keeps
 * each one focused on one responsibility.
 */

import type { Database } from '../db/connection.js';
import { getBackupStatus, type BackupStatus } from '../repositories/backupStatus.js';

/**
 * Postgres error codes that signal "the database is unreachable" — the
 * one class of failure the badge renders as `unknown` rather than
 * bubbling up to a 500. Expressed as an exhaustive allowlist so a
 * programmer error (e.g., missing table, schema drift) doesn't silently
 * decay into "status unknown" and mislead operators into trusting a
 * broken deploy (AC-612).
 *
 * References:
 *   - https://www.postgresql.org/docs/current/errcodes-appendix.html
 *   - node-postgres exposes Postgres `code` as-is on the thrown error.
 *   - Socket-level errors (ECONNREFUSED etc.) surface as Node error
 *     codes on the outer Error, not inside a PG error envelope.
 */
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  // node / libuv socket failures — no connection established at all.
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  // Postgres SQLSTATEs from class 08 (connection exceptions) plus 57P03
  // (cannot_connect_now — server starting up / shutting down).
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08007', // transaction_resolution_unknown
  '57P03', // cannot_connect_now
]);

interface ErrorWithCode {
  code?: unknown;
  message?: unknown;
}

/**
 * Type guard for `{ code: string, message: string }`-shaped errors.
 * Node and pg both surface the important classification via `code`;
 * the rest of the stack is captured for logging only.
 */
function isConnectionError(err: unknown): err is ErrorWithCode & { code: string } {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as ErrorWithCode).code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}

/**
 * Structured logger — minimal shape so the service can be used from the
 * Fastify request log (Pino) AND from the CLI entry point. The route
 * adapter passes its `request.log`; the CLI passes `console`.
 */
export interface BackupStatusLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export class BackupStatusService {
  constructor(
    private db: Database,
    private logger?: BackupStatusLogger,
  ) {}

  /**
   * Read the current backup status. Returns `null` ONLY when the DB
   * itself is unreachable (connection refused, timeout, etc.) — the
   * `unknown` badge state is reserved for "we genuinely cannot tell".
   *
   * Any other failure mode — missing table (programmer error / migration
   * not applied), schema drift, permissions, corrupted row — is NOT
   * coerced to `null`. Swallowing those would dress a programmer error
   * up as "status unknown", which is the misleading-state class ADR-0014
   * rules out: an operator looking at a red/green/unknown badge should
   * never see "unknown" when the real story is "your deploy is broken".
   * Those failures propagate; the caller surfaces them as a 500 so
   * monitoring and logs actually catch them.
   */
  async read(): Promise<BackupStatus | null> {
    try {
      return await getBackupStatus(this.db);
    } catch (err) {
      if (isConnectionError(err)) {
        // Connection-class failure — this is the one failure we model as
        // "status truly unknown". Log at warn so repeated DB outages are
        // visible but do not page.
        this.logger?.warn(
          {
            event: 'backup_status_read_unreachable',
            code: (err as { code: string }).code,
          },
          'backup status DB unreachable',
        );
        return null;
      }

      // Everything else is a programmer/config error. Log structured
      // context (never the raw Error — no stack traces in the log JSON)
      // and rethrow so the upstream error surface surfaces it.
      this.logger?.warn(
        {
          event: 'backup_status_read_error',
          code:
            typeof err === 'object' && err !== null
              ? String((err as ErrorWithCode).code ?? 'unknown')
              : 'unknown',
          message: err instanceof Error ? err.message : String(err),
        },
        'backup status read failed — not a connection error; propagating',
      );
      throw err;
    }
  }
}
