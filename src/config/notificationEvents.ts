/**
 * Notification event catalog — data-model.md §5.11, ADR-0023.
 *
 * Closed enum of event classes the notification publisher dispatches.
 * Adding a class is a code change plus a matching seed rule — the
 * catalog is deliberately not user-editable so templates stay aligned
 * with the `mutate()` payload contract (ADR-0023 §Decision).
 *
 * Two event families:
 *   - Mutation events fire from `audit-publisher` after a domain mutation
 *     commits. The `(entityType, action)` pair is mapped to an event
 *     class via `AUDIT_TO_EVENT_CLASS`.
 *   - System-bus events (`backup.failed`, `disk.threshold_reached`) have
 *     no `audit_log` row; they publish directly via the system-event
 *     bus (ADR-0021 §Decision "Notification publisher").
 *
 * German labels live on the config layer per architecture.md §11.2 —
 * both server (publisher dispatch context) and UI (rule-editor view,
 * activity feed) import from here.
 */

/** Closed event-class enum — pinned by data-model.md §5.11. */
export const NOTIFICATION_EVENT_CLASSES = [
  'project.transition_forward',
  'project.transition_backward',
  'project.archived',
  'project.assignment_changed',
  'project.attachment_added',
  'backup.failed',
  'disk.threshold_reached',
] as const;

export type NotificationEventClass = (typeof NOTIFICATION_EVENT_CLASSES)[number];

/**
 * Event classes that carry a `projectId` in their payload. Only these
 * accept `recipientSpec.includeAssignedWorkers = true` (ADR-0023 §Decision
 * recipient spec, data-model.md §5.11 design note).
 */
export const PROJECT_SCOPED_EVENT_CLASSES: ReadonlySet<NotificationEventClass> = new Set([
  'project.transition_forward',
  'project.transition_backward',
  'project.archived',
  'project.assignment_changed',
  'project.attachment_added',
]);

/** Event classes where `stateFilter` is meaningful (transitions only). */
export const TRANSITION_EVENT_CLASSES: ReadonlySet<NotificationEventClass> = new Set([
  'project.transition_forward',
  'project.transition_backward',
]);

/**
 * Mapping from `(entity_type, action)` → event class. The publisher
 * consumes this to translate an audit row into an event class before
 * rule matching. Entries that do not produce notifications (e.g.
 * `customer.create`) are absent — missing entry = no notification event.
 */
export interface AuditEventKey {
  entityType: string;
  action: string;
}

type AuditMapKey = `${string}::${string}`;

function key(k: AuditEventKey): AuditMapKey {
  return `${k.entityType}::${k.action}`;
}

const AUDIT_TO_EVENT_MAP = new Map<AuditMapKey, NotificationEventClass>([
  [key({ entityType: 'project', action: 'transition:forward' }), 'project.transition_forward'],
  [key({ entityType: 'project', action: 'transition:backward' }), 'project.transition_backward'],
  // soft-delete = archive (ADR-0017); the ProjectCrudService emits
  // `action = 'archive'` on the project row so map that to the archived
  // event class.
  [key({ entityType: 'project', action: 'archive' }), 'project.archived'],
  [key({ entityType: 'project_worker', action: 'create' }), 'project.assignment_changed'],
  [key({ entityType: 'project_worker', action: 'delete' }), 'project.assignment_changed'],
  // Attachment `complete` (pending → ready) writes the `attachment:add`
  // row (AC-219); that row is the dispatch trigger for the
  // `project.attachment_added` event (AC-316). Init writes no row, so an
  // abandoned upload publishes nothing.
  [key({ entityType: 'attachment', action: 'attachment:add' }), 'project.attachment_added'],
]);

export function eventClassForAudit(k: AuditEventKey): NotificationEventClass | null {
  return AUDIT_TO_EVENT_MAP.get(key(k)) ?? null;
}

/**
 * German labels for each event class. Rendered in the rule-editor
 * dropdown (ui/management.md §8.14) and used as the activity-feed
 * description when no richer payload-aware derivation applies.
 *
 * `[C]` per architecture.md §12.2 — a customer deployment may retune
 * labels without touching code; the English key is the stable axis.
 */
export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventClass, string> = {
  'project.transition_forward': 'Projekt-Statuswechsel vorwärts',
  'project.transition_backward': 'Projekt-Statuswechsel zurück',
  'project.archived': 'Projekt archiviert',
  'project.assignment_changed': 'Mitarbeiter-Zuweisung geändert',
  'project.attachment_added': 'Datei hinzugefügt',
  'backup.failed': 'Backup fehlgeschlagen',
  'disk.threshold_reached': 'Speichergrenze erreicht',
};

export function labelForEventClass(eventClass: NotificationEventClass): string {
  return NOTIFICATION_EVENT_LABELS[eventClass];
}
