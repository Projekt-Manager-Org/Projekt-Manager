/**
 * App-shell activity dock (spec ui/index.md §8.1.2, AC-317/318/319).
 *
 * A collapsible panel docked at the bottom of the authenticated layout,
 * directly above the Footer, surfacing the live activity feed so a
 * privileged user can leave it open (e.g. on the Kanban board) and watch
 * the business unfold in real time.
 *
 * - Permission gate (AC-319): rendered ONLY for callers holding
 *   `audit:read` (owner / office under the default matrix). The gate runs
 *   before any render so worker / bookkeeper get `null` — the container is
 *   absent from the DOM, not merely hidden. Defense in depth on top of the
 *   server's 403 on the read endpoint (mirrors StorageUsageBadge.tsx).
 *
 * - Default-collapsed (AC-318): `expanded` starts `false`. The toggle
 *   flips it. Because the dock is mounted in the app SHELL (App.tsx, a
 *   sibling of the routed `<main>`), a client-side view switch does NOT
 *   remount it — so this plain component state survives navigation, which
 *   is exactly the AC-318 "collapse state persists across view navigation"
 *   guarantee. (It may reset on a full page reload; the AC only requires
 *   persistence across view switches.)
 *
 * - Desktop-only (AC-318): hidden on phones via the CSS-module media query
 *   at `max-width: 768px`, parity with the Footer (mobile users reach the
 *   same history through Verwaltung → Aktivität).
 *
 * - Recipient-scoped feed (AC-318 / AC-200): the embedded ActivityFeed
 *   fetches with `recipientScope: true` — the caller's recipient-scoped
 *   default, with no "Alles anzeigen" toggle (that is a global-view
 *   concern). The feed is mounted only while expanded, so the first
 *   `/api/audit` fetch fires on expand.
 *
 * - Live update (AC-317): handled entirely by the embedded ActivityFeed,
 *   which already subscribes to the `audit_changed` SSE event and refetches
 *   (api.md §14.2.13). No parallel subscription here.
 */

import { useState } from 'react';
import { usePermission } from '@/hooks/usePermission';
import { STRINGS } from '@/config/strings';
import type { AuditListParams } from '@/domain/audit';
import { ActivityFeed } from '@/ui/audit/ActivityFeed';
import styles from './ActivityDock.module.css';

/**
 * Recipient-scoped default (AC-200) — module-level constant so the
 * reference is stable across renders. `recipientScope: true` rides the
 * wire (auditApi.list runs params through `toQuery`); the server returns
 * only rows the caller would receive per the resolved notification-rule
 * set. The dock offers no "Alles anzeigen" escape hatch.
 */
const DOCK_FILTERS: AuditListParams = { recipientScope: true };

/**
 * Stable filter key — the dock's filter never changes, so a constant key
 * is correct (ActivityFeed keys its refetch effect off this, not off the
 * filters object identity).
 */
const DOCK_FILTER_KEY = 'activity-dock';

export function ActivityDock() {
  const canReadAudit = usePermission('audit:read');
  const [expanded, setExpanded] = useState(false);

  // AC-319: callers without `audit:read` never get the dock in the DOM.
  if (!canReadAudit) return null;

  const toggleLabel = expanded
    ? STRINGS.layout.activityDockCollapse
    : STRINGS.layout.activityDockExpand;

  return (
    <aside
      className={styles.dock}
      data-testid="activity-dock"
      aria-label={STRINGS.layout.activityDockTitle}
    >
      <button
        type="button"
        className={styles.toggle}
        data-testid="activity-dock-toggle"
        aria-expanded={expanded}
        aria-label={toggleLabel}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className={styles.title}>{STRINGS.layout.activityDockTitle}</span>
        <span className={styles.chevron} aria-hidden="true">
          {expanded ? '▾' : '▴'}
        </span>
      </button>

      {/* The panel element is always present so its test-id is a stable
          target; CSS collapses it when not expanded (AC-318
          default-collapsed → `toBeHidden`). The feed is mounted only while
          expanded so the first `/api/audit` fetch fires on expand. */}
      <div
        className={expanded ? styles.panel : styles.panelCollapsed}
        data-testid="activity-dock-panel"
      >
        {expanded && (
          <ActivityFeed
            filters={DOCK_FILTERS}
            filterKey={DOCK_FILTER_KEY}
            testId="activity-dock-feed"
            layout="list"
            inline
            loadOlderTestId="activity-dock-load-older"
          />
        )}
      </div>
    </aside>
  );
}
