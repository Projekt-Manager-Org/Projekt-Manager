/**
 * Post-commit audit publisher — api.md §14.2.8.
 *
 * ADR-0021 splits the audit-write path from subscriber dispatch: the
 * `mutate()` helper writes the domain mutation and the `audit_log` row
 * in one transaction, and only after that transaction commits does the
 * helper invoke `dispatch()` here. A throwing subscriber therefore cannot
 * roll back the originating mutation — AC-183.
 *
 * Surface (pinned by api.md §14.2.8 "Post-commit publisher contract"):
 *
 *   onAuditCommitted(handler) → unsubscribe
 *     Handlers are invoked once per commit, in registration order
 *     (Set iteration order = insertion order in modern JS runtimes).
 *
 *   setOperationalLogger(logger)
 *     Wires the structured operational logger used to surface handler
 *     failures. Without this wiring, a subscriber failure is silently
 *     swallowed — the failure-surface contract (AC-183) mandates a
 *     structured log line, so production code must call this once at
 *     startup.
 *
 *   dispatch(row)
 *     Internal — called by `mutate()` after commit. Exported so tests
 *     can drive the publisher directly if needed.
 */

import type { AuditEntityType } from '../db/schema.js';

/**
 * The committed audit-log row as observed by subscribers. Shape mirrors
 * `data-model.md §5.10` — subscribers receive field-keyed diffs rather
 * than full-row snapshots.
 */
export interface AuditLogRow {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorKind: 'user' | 'system';
  actorReason: string | null;
  entityType: AuditEntityType;
  entityId: string;
  /** Human-readable label snapshot (data-model.md §5.10). */
  entityLabel: string | null;
  /**
   * Ancestor-link snapshot (architecture.md §11.12). Populated at write
   * time for nested entities (project_worker, attachment, invoice) and
   * for project rows (self-ancestor) so the per-parent activity feed
   * can fetch every row scoped to a project in one indexed query, and
   * so the cross-project surfaces (the dock + global Aktivität view's
   * Projekt column) can render the parent project's name without a
   * runtime JOIN. Null for top-level entities (customer, user,
   * company_profile, data_import). The `(type, id)` pair is both-or-
   * neither (DB CHECK `audit_log_ancestor_pair`); `Label` is co-
   * populated by the service layer whenever the pair is set (projects
   * always carry a displayName-derived label).
   */
  ancestorEntityType: AuditEntityType | null;
  ancestorEntityId: string | null;
  ancestorEntityLabel: string | null;
  action: string;
  payload: unknown;
  correlationId: string | null;
}

/** Subscriber function. Return value (sync or async) is ignored. */
export type AuditHandler = (row: AuditLogRow) => void | Promise<void>;

/**
 * Structured logger used to surface subscriber failures. Only the
 * `error` channel is used — handler-error is the sole log line the
 * publisher emits, so there is no `info` surface to wire.
 */
export interface OperationalLogger {
  error: (payload: object) => void;
}

/**
 * AC-183 pins this exact event discriminator on the handler-error log
 * line. Exported so tests can reference the same literal without
 * drift.
 */
export const EVENT_HANDLER_ERROR = 'audit-publisher-handler-error';

// Module-level registry. A Set preserves insertion order in ES2015+,
// which is the registration-order guarantee api.md §14.2.8 pins.
const handlers = new Set<AuditHandler>();
let logger: OperationalLogger | null = null;

/**
 * Register a post-commit handler. Returns an unsubscribe function so
 * callers (e.g. tests) can remove their handler without hanging on to
 * a reference to the exact closure. The Set identity guarantees at-
 * most-once dispatch per commit per handler.
 */
export function onAuditCommitted(handler: AuditHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Wire the operational logger. Call once at startup. A subsequent call
 * replaces the previous logger — tests use this to inject a spy without
 * mutating the original handle.
 */
export function setOperationalLogger(l: OperationalLogger): void {
  logger = l;
}

/**
 * Invoked by `mutate()` after the transaction commits. Iterates every
 * registered handler and catches any thrown error so one bad subscriber
 * cannot prevent the next from running. Each failure surfaces through
 * the operational logger with the AC-183 field set exactly.
 *
 * Snapshots the handler set at dispatch entry so a subscriber that
 * registers during its own dispatch does not receive the current row
 * as well (would double-fire). Unsubscription mid-dispatch is also
 * safe: the removed handler still runs once for this row, which is
 * the existing behavior and matches the registration-order guarantee.
 */
export async function dispatch(row: AuditLogRow): Promise<void> {
  for (const handler of [...handlers]) {
    try {
      await handler(row);
    } catch (err) {
      logger?.error({
        event: EVENT_HANDLER_ERROR,
        audit_entry_id: row.id,
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Test-only reset. Not part of the public spec surface but a useful
 * safety valve when tests subscribe and the vitest runner reuses the
 * module between describe blocks. Production code has no reason to
 * call this.
 */
export function __resetForTests(): void {
  handlers.clear();
  logger = null;
}
