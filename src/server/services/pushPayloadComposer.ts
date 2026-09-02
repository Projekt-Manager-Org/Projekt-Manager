/**
 * Push payload composer — server-side template renderer (AC-211, ADR-0023).
 *
 * Pure function. No I/O, no DB lookups. Operates only on the audit row
 * (already snapshotted via `entityLabel`) and the system-event payload.
 * The publisher calls this once per dispatched event and forwards the
 * result to the transport, which the service worker reads back as
 * `{title, body, url}`.
 *
 * Why server-side, not in the SW: the SW has no access to the audit
 * row or German label catalog without an extra fetch round-trip on
 * every push. Composing once at dispatch time is simpler and keeps the
 * SW's surface deliberately minimal (push + click only — see sw.js).
 *
 * Label sources:
 *   - Title: `NOTIFICATION_EVENT_LABELS` (config/notificationEvents.ts).
 *   - Status name in transition body: `STATE_CONFIGS` (config/stateConfig.ts).
 *   - Project identifier in body: `entityLabel` (snapshotted at write time
 *     via `projectAuditLabel` — survives rename / archive).
 *   - Backup-condition body: `STRINGS.backup` (config/strings.ts), the
 *     same catalog the badge renders from.
 */

import {
  type NotificationEventClass,
  labelForEventClass,
} from '../../config/notificationEvents.js';
import { STATE_CONFIGS, type WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import type { BackupBadgeReason } from '../../domain/backupBadge.js';
import type { AuditLogRow } from './audit-publisher.js';

export interface RenderedPushPayload {
  title: string;
  body: string;
  url: string;
}

const STATE_LABEL_BY_KEY = new Map<string, string>(STATE_CONFIGS.map((s) => [s.key, s.label]));

function statusLabel(key: string | null): string | null {
  if (!key) return null;
  return STATE_LABEL_BY_KEY.get(key as WorkflowState) ?? null;
}

function readAfterStatus(row: AuditLogRow | null): string | null {
  if (!row) return null;
  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const after = (payload as { after?: unknown }).after;
  if (typeof after !== 'object' || after === null) return null;
  const status = (after as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

const PROJECT_FALLBACK_BODY = 'Aktualisierung';

/**
 * Click target for the storage warning — the view that carries the
 * storage row (`StorageUsageRow`, ui/daten.md §8.11.3).
 */
const STORAGE_EVENT_URL = '/daten';

/**
 * Click target for the backup warning. There is no backup *page*: the
 * badge renders in the header of every authenticated surface
 * (`Header.tsx`, AC-170), so the relevant destination is simply an
 * authenticated view with the badge in it. `/kanban` is the owner's
 * landing view (`LANDING_ORDER` in src/config/routes.ts) and both
 * system events are seeded owner-only, so this is where the tap would
 * have put them anyway.
 */
const BACKUP_EVENT_URL = '/kanban';

/**
 * Push body per derived backup-badge reason, valued with the badge's
 * own labels so a push and the badge it points at never disagree about
 * what is wrong.
 *
 * Keyed by `BackupBadgeReason` rather than `string`: a reason added to
 * the domain union without a body here is a compile error, matching the
 * exhaustiveness the badge's own `switch` statements get from their
 * `never` branches.
 */
const BACKUP_REASON_BODY: Readonly<Record<BackupBadgeReason, string>> = {
  'last-run-failed': STRINGS.backup.lastRunFailed,
  'backup-never-run': STRINGS.backup.backupNeverRun,
  'drill-never-run': STRINGS.backup.drillNeverRun,
  'backup-stale': STRINGS.backup.backupStale,
  'backup-aging': STRINGS.backup.backupAging,
  'drill-stale': STRINGS.backup.drillStale,
};

function readStringField(payload: Record<string, unknown> | null, key: string): string | null {
  if (payload === null) return null;
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function readNumberField(payload: Record<string, unknown> | null, key: string): number | null {
  if (payload === null) return null;
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Compose the user-facing push payload for a dispatched event.
 *
 * `auditRow` is null for system-bus events (`backup.failed`,
 * `disk.threshold_reached`); those read `systemPayload` instead, which
 * the threshold monitor populates with the derived condition.
 */
export function composePushPayload(
  eventClass: NotificationEventClass,
  auditRow: AuditLogRow | null,
  systemPayload: Record<string, unknown> | null,
): RenderedPushPayload {
  const title = labelForEventClass(eventClass);

  switch (eventClass) {
    case 'project.transition_forward':
    case 'project.transition_backward': {
      const label = auditRow?.entityLabel ?? null;
      const targetStatus = statusLabel(readAfterStatus(auditRow));
      const body =
        label && targetStatus ? `${label} → ${targetStatus}` : (label ?? PROJECT_FALLBACK_BODY);
      const url = projectUrl(auditRow);
      return { title, body, url };
    }

    case 'project.archived': {
      const label = auditRow?.entityLabel ?? PROJECT_FALLBACK_BODY;
      return { title, body: label, url: projectUrl(auditRow) };
    }

    case 'project.assignment_changed': {
      const label = auditRow?.entityLabel ?? PROJECT_FALLBACK_BODY;
      return { title, body: label, url: projectUrl(auditRow) };
    }

    case 'project.attachment_added': {
      // Body identifies the affected project via the row-level
      // `ancestorEntityLabel` snapshot (AC-211 / AC-339) so the
      // notification names the project even after a later rename /
      // archive. The click target is the project — resolved from the
      // audit row's ANCESTOR link, NOT `entityId`: an `attachment` row's
      // `entityId` is the attachment, the ancestor is `('project',
      // projectId, projectLabel)` (architecture.md §11.12).
      const projectLabel = auditRow?.ancestorEntityLabel ?? null;
      const body = projectLabel ? `Neue Datei in ${projectLabel}` : 'Neue Datei hinzugefügt';
      return { title, body, url: projectUrlFromAncestor(auditRow) };
    }

    case 'backup.failed': {
      // The monitor publishes the derived badge reason; reuse the badge's
      // own German labels so the push and the badge the owner lands on
      // say the same thing. Falls back to the generic sentence when the
      // payload is absent or carries an unknown reason.
      // `reason` arrives as an untrusted string off the payload, so the
      // lookup is guarded by `hasOwn` rather than a bare index — an
      // unknown reason (or an inherited key like `toString`) falls
      // through to the generic sentence instead of rendering a
      // non-string.
      const reason = readStringField(systemPayload, 'reason');
      const body =
        reason !== null && Object.hasOwn(BACKUP_REASON_BODY, reason)
          ? BACKUP_REASON_BODY[reason as BackupBadgeReason]
          : 'Backup konnte nicht abgeschlossen werden.';
      return { title, body, url: BACKUP_EVENT_URL };
    }

    case 'disk.threshold_reached': {
      const percent = readNumberField(systemPayload, 'percent');
      const body =
        percent === null ? 'Speichernutzung über Schwellwert.' : `Speicher zu ${percent}% belegt.`;
      return { title, body, url: STORAGE_EVENT_URL };
    }
  }
}

/**
 * Resolve `/projects/:id` when the audit row carries a project ancestor
 * (which is true for every project-scoped event the catalog admits, by
 * AC-192's recipient-scope contract). Falls back to `/` if the audit
 * row is missing — a defensive branch the catalog should never hit.
 */
function projectUrl(row: AuditLogRow | null): string {
  if (!row) return '/';
  // For `project` rows, entityId IS the project id. For `project_worker`
  // rows, entityId is the project id too (set by ProjectCrudService so
  // the per-project activity feed renders without a second lookup).
  return `/projects/${row.entityId}`;
}

/**
 * Resolve `/projects/:id` from the audit row's ANCESTOR link
 * (`ancestorEntityId`) rather than `entityId`. Required for
 * `project.attachment_added`: an `attachment` row's `entityId` is the
 * attachment, while the ancestor is `('project', projectId)`
 * (architecture.md §11.12, AC-211). Falls back to `/` only when the
 * ancestor is absent — a defensive branch the catalog should never hit,
 * since every `attachment:add` row carries a project ancestor (AC-219).
 */
function projectUrlFromAncestor(row: AuditLogRow | null): string {
  if (!row || !row.ancestorEntityId) return '/';
  return `/projects/${row.ancestorEntityId}`;
}
