/**
 * Single row in the activity feed / audit list.
 *
 * Renders:
 *   - One-line German description (via `describeAuditRow`).
 *   - Actor cell — displayName on user-actor rows; `"System" +
 *     actorReason` on system-actor rows.
 *   - German timestamp (`DD.MM.YYYY HH:mm`).
 *   - Disclosure drawer with the `{ before, after }` diff — rendered
 *     only when the API returned a non-null `payload`.
 *
 * E2E contract (AC-185 / AC-187):
 *   - `data-has-payload` — `"true"` iff the API returned a non-null
 *     payload.
 *   - `data-action`      — the raw action string (purge-visibility
 *     assertion in AC-187).
 *   - `data-created-at`  — the ISO timestamp for the newest-first
 *     check in AC-185.
 */

import { useState } from 'react';
import type { AuditEntry } from '@/domain/audit';
import { describeAuditRow } from '@/domain/auditRowDescription';
import { formatDateTimeDE } from '@/domain/dateFormat';
import { STRINGS } from '@/config/strings';
import { PayloadDrawer } from './PayloadDrawer';
import styles from './ActivityFeedRow.module.css';

interface Props {
  entry: AuditEntry;
}

function entityTypeLabel(entityType: AuditEntry['entityType']): string {
  switch (entityType) {
    case 'project':
      return STRINGS.audit.entityProject;
    case 'customer':
      return STRINGS.audit.entityCustomer;
    case 'user':
      return STRINGS.audit.entityUser;
    case 'project_worker':
      return STRINGS.audit.entityProjectWorker;
    case 'attachment':
      return STRINGS.audit.entityAttachment;
    case 'invoice':
      return STRINGS.audit.entityInvoice;
    case 'company_profile':
      return STRINGS.audit.entityCompanyProfile;
    case 'data_import':
      return STRINGS.audit.entityDataImport;
  }
}

function resolveActorLabel(entry: AuditEntry) {
  if (entry.actorKind === 'system') {
    return {
      kind: 'system' as const,
      label: STRINGS.audit.system,
      reason: entry.actorReason,
    };
  }
  return {
    kind: 'user' as const,
    label: entry.actorDisplayName ?? STRINGS.audit.userNeutral,
    reason: null,
  };
}

/**
 * Structural empty-payload detection. The drawer should NOT render for
 * rows whose payload is structurally empty — e.g. the `{ before: {},
 * after: {} }` sentinel an agent writes for password-change audit
 * events where the `{ before, after }` fields themselves are redacted.
 * A `payload !== null` check would still render an empty drawer, which
 * is worse than hiding the toggle.
 *
 * Free-shape payloads (no `before` / `after` at all) fall through to
 * `true` — `PayloadDrawer` has a JSON fallback for those, and hiding
 * them would lose information.
 */
function hasRenderablePayload(payload: unknown): boolean {
  if (payload == null) return false;
  if (typeof payload !== 'object') return true;
  const p = payload as { before?: unknown; after?: unknown };
  if (!('before' in p) && !('after' in p)) return true;
  const before = p.before;
  const after = p.after;
  const beforeHasKeys =
    before != null && typeof before === 'object' && Object.keys(before).length > 0;
  const afterHasKeys = after != null && typeof after === 'object' && Object.keys(after).length > 0;
  return beforeHasKeys || afterHasKeys;
}

export function ActivityFeedRow({ entry }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const description = describeAuditRow({
    action: entry.action,
    payload: entry.payload,
    entityType: entry.entityType,
  });
  const hasPayload = hasRenderablePayload(entry.payload);
  const actor = resolveActorLabel(entry);

  return (
    <div
      className={styles.row}
      data-testid={`activity-feed-row-${entry.id}`}
      data-action={entry.action}
      data-has-payload={hasPayload ? 'true' : 'false'}
      data-created-at={entry.createdAt}
    >
      <div className={styles.headerLine}>
        <span className={styles.description}>{description}</span>
        <span className={styles.timestamp}>{formatDateTimeDE(entry.createdAt)}</span>
      </div>
      <div className={styles.metaLine}>
        <span className={actor.kind === 'system' ? styles.actorSystem : styles.actor}>
          {actor.label}
        </span>
        {actor.reason && <span className={styles.actorReason}>({actor.reason})</span>}
        <span className={styles.entity}>
          <span className={styles.entityLabel}>{entityTypeLabel(entry.entityType)}</span>
        </span>
      </div>
      {hasPayload && (
        <button
          type="button"
          className={styles.drawerToggle}
          data-testid="activity-feed-drawer-toggle"
          onClick={() => setDrawerOpen((open) => !open)}
          aria-expanded={drawerOpen}
        >
          {drawerOpen ? STRINGS.audit.detailsHide : STRINGS.audit.detailsShow}
        </button>
      )}
      {hasPayload && drawerOpen && (
        <div
          className={styles.drawerContent}
          data-testid="activity-feed-drawer-content"
          role="region"
        >
          <PayloadDrawer payload={entry.payload} />
        </div>
      )}
    </div>
  );
}
