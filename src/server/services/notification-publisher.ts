/**
 * Notification publisher — ADR-0023, api.md §14.2.9.
 *
 * Consumes two input streams: audit-log commits (via
 * `audit-publisher.onAuditCommitted`) and system bus events (via
 * `publishSystemEvent` — `backup.failed`, `disk.threshold_reached`).
 * For each event: reads the enabled-rule set AT dispatch time
 * (AC-193), applies stateFilter, resolves a deduplicated recipient
 * union (AC-192), drops muted users from the push attempt (AC-195),
 * and fans out a `DispatchObservation` per trigger.
 *
 * Per-subscriber failures are logged and swallowed, matching the
 * audit-publisher's AC-183 contract. Recipient-resolution helpers
 * live in `notificationRecipientResolver.ts`; this file is the
 * orchestrator (bus wiring + dispatch flow).
 */

import type { Database } from '../db/connection.js';
import { listEnabledRulesForEventClass } from '../repositories/notificationRule.js';
import {
  eventClassForAudit,
  type NotificationEventClass,
} from '../../config/notificationEvents.js';
import { onAuditCommitted, type AuditLogRow } from './audit-publisher.js';
import { dispatchToSubscriptions, type PushDispatcher } from './PushDispatcher.js';
import {
  extractAfterStatus,
  extractProjectId,
  filterUnmutedUserIds,
  resolveRecipients,
  ruleMatches,
} from './notificationRecipientResolver.js';
import { composePushPayload } from './pushPayloadComposer.js';

/**
 * Structured logger used for operational events. Mirrors the pino-style
 * object-first signature Fastify's built-in logger exposes. Wire via
 * `setNotificationPublisherLogger()` at startup.
 */
export interface PublisherLogger {
  warn(payload: object, msg: string): void;
  error(payload: object, msg: string): void;
}

let logger: PublisherLogger | null = null;

/**
 * Wire the operational logger. Call once at startup, after
 * `registerNotificationPublisher`. Tests that do not need structured
 * log output can skip this — unlogged events are dropped silently.
 */
export function setNotificationPublisherLogger(l: PublisherLogger): void {
  logger = l;
}

/**
 * Snapshot of a dispatched event. Tests subscribe via `onEventDispatched`
 * and partition observations by `auditEntryId` (or by the synthetic
 * system-event id for non-audit events).
 */
export interface DispatchObservation {
  /** `audit_log.id` for mutation events, or a synthetic id for system events. */
  auditEntryId: string;
  /** Rule ids that matched and contributed recipients. */
  ruleMatches: string[];
  /** Deduplicated live-user ids the event targets. */
  recipients: string[];
  /** Subset of `recipients` for whom a push attempt was made. */
  pushAttemptedUserIds: string[];
}

export type DispatchObservationHandler = (entry: DispatchObservation) => void | Promise<void>;

const observationHandlers = new Set<DispatchObservationHandler>();

/**
 * Register a dispatch-observation handler. Returns an unsubscribe
 * function. Handlers run in registration order; a thrown exception is
 * logged and swallowed so a bad observer does not block dispatch.
 */
export function onEventDispatched(handler: DispatchObservationHandler): () => void {
  observationHandlers.add(handler);
  return () => {
    observationHandlers.delete(handler);
  };
}

/**
 * System-event context — produced by non-mutation bus publishers. No
 * audit row backs it, so `payload` is an arbitrary opaque object. A
 * short-lived synthetic id is coined for observation keying.
 */
export interface SystemEvent {
  eventClass: 'backup.failed' | 'disk.threshold_reached';
  payload?: Record<string, unknown>;
}

// Module-level wiring. Publisher subscribes to the audit bus at start
// and keeps a reference to the shared `Database` + `PushDispatcher`.
let boundDb: Database | null = null;
let boundDispatcher: PushDispatcher | null = null;
let auditUnsubscribe: (() => void) | null = null;

/**
 * Attach the publisher to the audit bus and system bus. Idempotent —
 * subsequent calls replace prior bindings so tests can re-wire per
 * run. Must be called once at startup AFTER the audit-publisher logger
 * is wired so handler failures surface.
 */
export function registerNotificationPublisher(opts: {
  db: Database;
  dispatcher: PushDispatcher;
}): void {
  boundDb = opts.db;
  boundDispatcher = opts.dispatcher;

  // Replace any existing audit subscription — idempotent wiring.
  if (auditUnsubscribe) {
    auditUnsubscribe();
    auditUnsubscribe = null;
  }
  auditUnsubscribe = onAuditCommitted(async (row) => {
    const eventClass = eventClassForAudit({
      entityType: row.entityType,
      action: row.action,
    });
    if (!eventClass) return; // Not a notification-worthy mutation.
    await handleEvent({ eventClass, auditRow: row });
  });
}

/**
 * Publish a non-mutation system event. Used by backup and disk-threshold
 * paths. Returns once dispatch completes (observation handlers + push
 * attempts are awaited sequentially).
 */
export async function publishSystemEvent(event: SystemEvent): Promise<void> {
  await handleEvent({
    eventClass: event.eventClass,
    auditRow: null,
    systemPayload: event.payload ?? {},
  });
}

/** Shared dispatch path for both audit-driven and system-bus events. */
async function handleEvent(ctx: {
  eventClass: NotificationEventClass;
  auditRow: AuditLogRow | null;
  systemPayload?: Record<string, unknown>;
}): Promise<void> {
  if (!boundDb || !boundDispatcher) {
    logger?.warn(
      {
        event: 'notification-publisher-not-wired',
        auditEntryId: ctx.auditRow?.id ?? null,
        eventClass: ctx.eventClass,
      },
      'handleEvent called before publisher was bound — skipping dispatch',
    );
    return;
  }

  const { eventClass, auditRow } = ctx;

  // AC-193: read the rule set at dispatch time so a rule toggle that
  // commits before this function reads affects this event, and a rule
  // toggle that commits after does not.
  const rules = await listEnabledRulesForEventClass(boundDb, eventClass);

  // Resolve matching rules (stateFilter semantics).
  const afterStatus = extractAfterStatus(auditRow);
  const matching = rules.filter((rule) => ruleMatches(rule, afterStatus));

  // Resolve recipients per rule and union/dedupe.
  const projectId = extractProjectId(eventClass, auditRow);
  const recipientIds = await resolveRecipients(boundDb, matching, projectId);

  // Partition recipients by mute state, then drop the acting user. Both
  // are delivery-time filters that leave the `recipients` set — and thus
  // activity-feed inclusion — whole, shrinking only `pushAttemptedUserIds`:
  //   - Mute (AC-195): no push for a user who silenced delivery.
  //   - Actor exclusion (AC-321): no push to the user who performed the
  //     action; being notified of your own action is noise. System events
  //     carry no user actor (actorKind = 'system'), so nothing is dropped.
  const unmuted = await filterUnmutedUserIds(boundDb, recipientIds);
  const actorUserId = auditRow?.actorKind === 'user' ? auditRow.actorId : null;
  const pushCandidates =
    actorUserId === null ? unmuted : unmuted.filter((id) => id !== actorUserId);

  // Compose the user-facing payload once per event (AC-211). The
  // service worker reads `title` / `body` / `url`; without these
  // server-rendered strings the SW falls back to a generic notification
  // with an empty body — the iter-8 wiring gap that prompted this fix.
  const rendered = composePushPayload(eventClass, auditRow, ctx.systemPayload ?? null);

  // Push dispatch. We capture attempt ids BEFORE delegating so
  // observation handlers see the full set even if the transport throws.
  await dispatchToSubscriptions(boundDb, boundDispatcher, pushCandidates, {
    ...rendered,
    eventClass,
    auditEntryId: auditRow?.id ?? null,
  });

  const observation: DispatchObservation = {
    auditEntryId: auditRow?.id ?? `system:${eventClass}:${Date.now()}`,
    ruleMatches: matching.map((r) => r.id),
    recipients: recipientIds,
    pushAttemptedUserIds: pushCandidates,
  };

  // Observation fan-out. Failures are contained — a broken observer
  // must not break dispatch.
  for (const handler of [...observationHandlers]) {
    try {
      await handler(observation);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.error(
        { event: 'notification-publisher-observer-error', error: message },
        'Observation handler threw — swallowed to protect dispatch',
      );
    }
  }
}

/**
 * Test-only reset — clear observation handlers, drop the audit-bus
 * subscription, and null out bound references so the next
 * `registerNotificationPublisher()` wires onto clean state. Invoked by
 * `stopApp()` in the integration harness (src/test/api-helpers.ts);
 * production has no reason to call this.
 */
export function __resetForTests(): void {
  observationHandlers.clear();
  if (auditUnsubscribe) {
    auditUnsubscribe();
    auditUnsubscribe = null;
  }
  boundDb = null;
  boundDispatcher = null;
  logger = null;
}
