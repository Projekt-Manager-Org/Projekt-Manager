/**
 * Single-line compact row for the activity dock (AC-339).
 *
 * The dock is a glanceable strip docked at the bottom of the shell; it
 * is NOT a detail view. So a row collapses to one line:
 *
 *   <Aktor> · <Projekt> · <Beschreibung>           <DD.MM.YYYY HH:mm>
 *
 *   - Aktor: user displayName or "System" with reason.
 *   - Projekt: parent project's label snapshot (`ancestorEntityLabel`,
 *     see data-model.md §5.10). Em dash for entries with no project
 *     ancestor (`customer`, `user`, `company_profile`, `data_import`).
 *   - Beschreibung: one-line German description from `describeAuditRow`.
 *
 * No drawer / no payload toggle — the detailed payload view lives on
 * the Aktivität page (ui/management.md §8.13.1). The dock-row drops the
 * `data-has-payload` data-attribute that the other layouts expose for
 * the same reason: there is no drawer to gate.
 *
 * E2E contract still pins (same as the list/table variants):
 *   - `data-action`     — the raw action string.
 *   - `data-created-at` — the ISO timestamp for newest-first checks.
 */

import type { AuditEntry } from '@/domain/audit';
import { describeAuditRow } from '@/domain/auditRowDescription';
import { formatDateTimeDE } from '@/domain/dateFormat';
import { STRINGS } from '@/config/strings';
import styles from './ActivityFeedRowCompact.module.css';

interface Props {
  entry: AuditEntry;
}

function resolveActorLabel(entry: AuditEntry): { label: string; isSystem: boolean } {
  if (entry.actorKind === 'system') {
    const reason = entry.actorReason;
    return {
      label: reason ? `${STRINGS.audit.system} (${reason})` : STRINGS.audit.system,
      isSystem: true,
    };
  }
  return {
    label: entry.actorDisplayName ?? STRINGS.audit.userNeutral,
    isSystem: false,
  };
}

/**
 * Project slot — `ancestorEntityLabel` for child entities and project
 * rows (data-model.md §5.10), em dash for top-level entries. Em dash is
 * a single visual atom — the user reads "no project" without parsing
 * a missing field.
 */
function projectLabel(entry: AuditEntry): string {
  return entry.ancestorEntityLabel ?? '—';
}

export function ActivityFeedRowCompact({ entry }: Props) {
  const description = describeAuditRow({
    action: entry.action,
    payload: entry.payload,
    entityType: entry.entityType,
  });
  const actor = resolveActorLabel(entry);

  return (
    <div
      className={styles.row}
      data-testid={`activity-feed-row-${entry.id}`}
      data-action={entry.action}
      data-created-at={entry.createdAt}
    >
      <span
        className={styles.body}
        title={`${actor.label} · ${projectLabel(entry)} · ${description}`}
      >
        <span className={actor.isSystem ? styles.actorSystem : styles.actor}>{actor.label}</span>
        <span className={styles.separator} aria-hidden="true">
          ·
        </span>
        <span className={styles.project}>{projectLabel(entry)}</span>
        <span className={styles.separator} aria-hidden="true">
          ·
        </span>
        <span className={styles.description}>{description}</span>
      </span>
      <span className={styles.timestamp}>{formatDateTimeDE(entry.createdAt)}</span>
    </div>
  );
}
