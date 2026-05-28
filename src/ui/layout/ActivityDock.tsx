/**
 * App-shell activity dock (spec ui/index.md §8.1.2,
 * AC-317/318/319/339/340/341).
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
 *   server's 403 on the read endpoint.
 *
 * - Default-collapsed (AC-318): `expanded` starts `false`. The toggle
 *   flips it. Because the dock is mounted in the app SHELL (App.tsx, a
 *   sibling of the routed `<main>`), a client-side view switch does NOT
 *   remount it — so this plain component state survives navigation, which
 *   is exactly the AC-318 "collapse state persists across view navigation"
 *   guarantee. (It may reset on a full page reload; the AC only requires
 *   persistence across view switches.)
 *
 * - Full RBAC-scoped feed (AC-318): the dock fetches every audit row the
 *   caller may read — `recipientScope` narrowing is a notifications
 *   concern (AC-200) and is exercised only on the Aktivität page. The
 *   dock surface is "everything the caller may read".
 *
 * - Single-line compact rows (AC-339): rows render as a single
 *   `Aktor · Projekt · Beschreibung` line with the timestamp aligned
 *   right (see `ActivityFeedRowCompact`). No detail drawer — the
 *   detailed payload view lives on the Aktivität page.
 *
 * - Global `Alt+A` shortcut (AC-340): from any view, `Alt+A` toggles the
 *   dock. The handler calls `preventDefault()` and is suppressed in
 *   editable-affordance focus (see `useGlobalShortcut`). The toggle
 *   button label includes the hint `(Alt+A)` so the shortcut is
 *   self-documenting.
 *
 * - Hidden on `/audit` (AC-341): the page already renders the full audit
 *   table, so a second feed below it would be redundant. The shortcut
 *   handler is suppressed while `/audit` is active so the keystroke is
 *   not silently swallowed by a stale handler.
 *
 * - Desktop-only (AC-318): hidden on phones via the CSS-module media query
 *   at `max-width: 768px`, parity with the Footer (mobile users reach the
 *   same history through Verwaltung → Aktivität).
 *
 * - Live update (AC-317): handled entirely by the embedded ActivityFeed,
 *   which already subscribes to the `audit_changed` SSE event and refetches.
 */

import { useCallback, useState } from 'react';
import { usePermission } from '@/hooks/usePermission';
import { useGlobalShortcut } from '@/hooks/useGlobalShortcut';
import { useUIStore } from '@/state/uiStore';
import { STRINGS } from '@/config/strings';
import type { AuditListParams } from '@/domain/audit';
import { ActivityFeed } from '@/ui/audit/ActivityFeed';
import styles from './ActivityDock.module.css';

/**
 * Full RBAC-scoped feed (AC-318). The dock shows every audit row the
 * caller may read; recipient-scoped narrowing is a notifications
 * concern (AC-200) and is exercised only on the Aktivität page.
 *
 * Module-level constant so the reference is stable across renders —
 * ActivityFeed keys its refetch effect off `filterKey`, not off the
 * filters object identity.
 */
const DOCK_FILTERS: AuditListParams = {};

/**
 * Stable filter key — the dock's filter never changes, so a constant
 * key is correct.
 */
const DOCK_FILTER_KEY = 'activity-dock';

/**
 * The view key of Verwaltung → Aktivität — AC-341 hides the dock while
 * this view is active because the page already renders the full audit
 * table. Mirrored from the routes table; a magic string is acceptable
 * here because the source of truth (config/routes.ts) uses the same
 * literal and there is no risk of drift without a coordinated rename.
 */
const AUDIT_VIEW_KEY = 'aktivitaet';

export function ActivityDock() {
  const canReadAudit = usePermission('audit:read');
  const activeView = useUIStore((s) => s.activeView);
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  // AC-340: install the global `Alt+A` shortcut for `audit:read`
  // holders. Suppressed while the Aktivität view is active (AC-341),
  // so the keystroke is not silently swallowed by a handler whose
  // target dock is hidden.
  const shortcutDisabled = !canReadAudit || activeView === AUDIT_VIEW_KEY;
  useGlobalShortcut({ key: 'a', alt: true }, toggle, { disabled: shortcutDisabled });

  // AC-319: callers without `audit:read` never get the dock in the DOM.
  if (!canReadAudit) return null;

  // AC-341: hide the dock on `/audit`. The collapse state persists in
  // the component's local state; navigation back restores the prior
  // expanded/collapsed state without a remount because the dock is a
  // shell sibling, not a routed child.
  if (activeView === AUDIT_VIEW_KEY) return null;

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
        onClick={toggle}
      >
        <span className={styles.title}>
          {STRINGS.layout.activityDockTitle}{' '}
          <span className={styles.shortcutHint}>{STRINGS.layout.activityDockShortcutHint}</span>
        </span>
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
            layout="compact"
            inline
            loadOlderTestId="activity-dock-load-older"
          />
        )}
      </div>
    </aside>
  );
}
