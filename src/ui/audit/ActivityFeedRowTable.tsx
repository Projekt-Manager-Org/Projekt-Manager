/**
 * Table-row variant of the audit-log row, used by the global Aktivität
 * view (ui/management.md §8.13.1 — prescriptive column list).
 *
 * Renders the same information as `ActivityFeedRow` but split across
 * `<td>` cells so the columns line up across rows. The drawer content
 * is rendered INSIDE the last `<td>` (the "Details" column) rather
 * than as a sibling `<tr>`: the row-scoped E2E locator
 * `row.getByTestId('activity-feed-drawer-content')` depends on the
 * content being a descendant of the main row, which rules out the
 * cleaner sibling-row form. CSS gives the open drawer enough width
 * via a negative right margin.
 *
 * E2E data-* contract (AC-185 / AC-187): `data-action`,
 * `data-has-payload`, `data-created-at`.
 */

import { useState } from 'react';
import type { AuditEntry } from '@/domain/audit';
import { auditProjectSlot } from '@/domain/audit';
import { formatDateTimeDE } from '@/domain/dateFormat';
import { STRINGS } from '@/config/strings';
import { labelForAuditAction } from '@/config/auditActionLabels';
import { PayloadDrawer } from './PayloadDrawer';
import styles from './ActivityFeedRow.module.css';
import tableStyles from './AuditTable.module.css';

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
    return { label: STRINGS.audit.system, reason: entry.actorReason };
  }
  return { label: entry.actorDisplayName ?? STRINGS.audit.userNeutral, reason: null };
}

/**
 * Structural empty-payload detection. Mirrors `ActivityFeedRow.tsx` —
 * see its comment for the rationale. Falls back to `true` for
 * free-shape payloads (no `before` / `after` keys) because
 * `PayloadDrawer` has a JSON fallback for those.
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

export function ActivityFeedRowTable({ entry }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hasPayload = hasRenderablePayload(entry.payload);
  const actor = resolveActorLabel(entry);

  return (
    <tr
      className={tableStyles.row}
      data-testid={`activity-feed-row-${entry.id}`}
      data-action={entry.action}
      data-has-payload={hasPayload ? 'true' : 'false'}
      data-created-at={entry.createdAt}
    >
      <td className={tableStyles.timestamp}>{formatDateTimeDE(entry.createdAt)}</td>
      <td className={tableStyles.actor}>
        {actor.label}
        {actor.reason && <span className={styles.actorReason}> ({actor.reason})</span>}
      </td>
      {/* AC-342: parent project's label snapshot for child entities,
          duplicated from `entityLabel` for project rows, em dash for
          rows without a project ancestor (customer, user,
          company_profile, data_import). Shared with the dock's
          compact row via `auditProjectSlot` (AC-339). */}
      <td className={tableStyles.project} data-testid="audit-row-project">
        {auditProjectSlot(entry)}
      </td>
      <td className={tableStyles.entity}>
        <div className={styles.entityLabel}>{entityTypeLabel(entry.entityType)}</div>
        <div className={tableStyles.entityId}>{entry.entityLabel ?? entry.entityId}</div>
      </td>
      <td className={tableStyles.action}>{labelForAuditAction(entry.action)}</td>
      <td className={tableStyles.payload}>
        {hasPayload ? (
          <>
            <button
              type="button"
              className={styles.drawerToggle}
              data-testid="activity-feed-drawer-toggle"
              onClick={() => setDrawerOpen((open) => !open)}
              aria-expanded={drawerOpen}
            >
              {drawerOpen ? STRINGS.audit.detailsHide : STRINGS.audit.detailsShow}
            </button>
            {drawerOpen && (
              <div
                className={styles.drawerContent}
                data-testid="activity-feed-drawer-content"
                role="region"
              >
                <PayloadDrawer payload={entry.payload} />
              </div>
            )}
          </>
        ) : (
          <span className={styles.drawerValueNull}>—</span>
        )}
      </td>
    </tr>
  );
}
