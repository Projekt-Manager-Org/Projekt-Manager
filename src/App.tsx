import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { Routes, Route, Navigate, useInRouterContext, useLocation } from 'react-router';
import { useAuthStore } from '@/state/authStore';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { subscribeProjectStoresToSse } from '@/state/projectSseSubscription';
import { subscribeInvoiceStoreToSse } from '@/state/invoiceSseSubscription';
import { subscribeAttachmentStoreToSse } from '@/state/attachmentSseSubscription';
import { viewFromPath } from '@/hooks/useRouterNav';
import { ROUTES, routeByPath, landingPathForUser } from '@/config/routes';
import { isInsecureConnection } from '@/config/insecureConnection';
import { Header } from '@/ui/layout/Header';
import { Footer } from '@/ui/layout/Footer';
import { ActivityDock } from '@/ui/layout/ActivityDock';
import { MobileTabBar } from '@/ui/layout/MobileTabBar';
import { MyProjectsView } from '@/ui/myprojects/MyProjectsView';
import { KanbanBoard } from '@/ui/kanban/KanbanBoard';
import { CalendarView } from '@/ui/calendar/CalendarView';
import { CustomerManagement } from '@/ui/management/CustomerManagement';
import { ProjectManagement } from '@/ui/management/ProjectManagement';
import { UserManagement } from '@/ui/management/UserManagement';
import { DatenView } from '@/ui/management/DatenView';
import { AuditManagement } from '@/ui/audit/AuditManagement';
import { NotificationRulesManagement } from '@/ui/management/NotificationRulesManagement';
import { ProjectDetailPanel } from '@/ui/detail/ProjectDetailPanel';
import { ProjectDetailPage } from '@/ui/detail/ProjectDetailPage';
import { InvoiceListView } from '@/ui/invoices/InvoiceListView';
import { InvoiceDetailView } from '@/ui/invoices/InvoiceDetailView';
import { LoginForm } from '@/ui/auth/LoginForm';
import { ConfirmDialog } from '@/ui/common/ConfirmDialog';
import { ToastContainer } from '@/ui/common/ToastContainer';
import { NotPermittedView } from '@/ui/common/NotPermittedView';
import type { ViewMode } from '@/domain/types';
import { STRINGS } from '@/config/strings';
import styles from './App.module.css';

/**
 * Sync URL → Zustand store. Components that read `activeView` from the store
 * (e.g. Header highlight) stay in sync with the URL.
 * Only runs when a router context is present (skipped in tests).
 */
function useUrlToStoreSync() {
  const location = useLocation();
  const setView = useUIStore((s) => s.setView);

  useEffect(() => {
    const view = viewFromPath(location.pathname);
    if (useUIStore.getState().activeView !== view) {
      setView(view);
    }
  }, [location.pathname, setView]);
}

/** Wrapper that calls useUrlToStoreSync only when inside a router context. */
function UrlStoreSync() {
  useUrlToStoreSync();
  return null;
}

/**
 * Route guard driven by the central route table (`src/config/routes.ts`).
 *
 * AC-149: a caller who cannot access the path sees a not-permitted
 * error surface. The URL is NOT changed — no redirect, no swap — so
 * the spec-mandated "URL in the address bar remains unchanged" holds.
 * Unauthenticated callers still hit the login screen via the outer
 * `authUser` branch in `App`, so this guard only runs for authenticated
 * users.
 *
 * The current path is read from `useLocation()` rather than passed in as
 * a prop so the guard has a single source of truth for its identity and
 * is future-proof against parametrized routes (the prop-based form was
 * forced to duplicate the path at each mount site).
 */
function ProtectedRoute({ element }: { element: ReactElement }) {
  const authUser = useAuthStore((s) => s.authUser);
  const location = useLocation();
  const route = routeByPath(location.pathname);
  // Unknown paths should never reach here (we only mount known paths),
  // but if they did, treat as not-permitted rather than rendering
  // nothing — a reviewable signal beats a silent blank.
  if (!route || !authUser || !route.canAccess(authUser)) {
    return <NotPermittedView />;
  }
  return element;
}

/**
 * Fallback used by the catch-all route ("*") and the root ("/") — sends
 * the authenticated user to their landing view. Unauthenticated callers
 * never reach here because the outer branch in `App` renders the login
 * screen before the `<Routes>` tree is instantiated.
 *
 * Defensive: if the auth store clears mid-render, return `null` instead
 * of navigating. The outer `if (authUser)` branch in `App` re-renders
 * on the cleared store and swaps to the login screen — navigating to
 * `/` or `*` here would re-enter `LandingRedirect` via the catch-all
 * and could loop before the outer branch catches up (no frontend
 * `/login` route exists today; the login form is rendered as a fallback
 * when `authUser` is null, not as a route).
 */
function LandingRedirect() {
  const authUser = useAuthStore((s) => s.authUser);
  if (!authUser) return null;
  return <Navigate to={landingPathForUser(authUser)} replace />;
}

const VIEW_ELEMENTS: Record<ViewMode, ReactElement> = {
  meineProjekte: <MyProjectsView />,
  kanban: <KanbanBoard />,
  kalender: <CalendarView />,
  kunden: <CustomerManagement />,
  projekte: <ProjectManagement />,
  rechnungen: <InvoiceListView />,
  rechnungDetail: <InvoiceDetailView />,
  benutzer: <UserManagement />,
  daten: <DatenView />,
  aktivitaet: <AuditManagement />,
  benachrichtigungen: <NotificationRulesManagement />,
  projektDetail: <ProjectDetailPage />,
};

export function App() {
  const hasRouter = useInRouterContext();
  const activeView = useUIStore((s) => s.activeView);
  const selectedProjectId = useUIStore((s) => s.selectedProjectId);
  const selectProject = useUIStore((s) => s.selectProject);
  const authUser = useAuthStore((s) => s.authUser);
  const sessionChecked = useAuthStore((s) => s.sessionChecked);
  const mutationError = useProjectStore((s) => s.mutationError);
  const clearMutationError = useProjectStore((s) => s.clearMutationError);
  const projects = useProjectStore((s) => s.projects);

  const insecure = isInsecureConnection();

  const selectedProject = selectedProjectId
    ? (projects.find((p) => p.id === selectedProjectId) ?? null)
    : null;
  const sessionCheckFired = useRef(false);

  useEffect(() => {
    if (!insecure) return;
    // Snapshot the current title and restore it on cleanup. Without the
    // restore, React 19 StrictMode's double-mount in dev produces
    // "UNSICHER – UNSICHER – Projekt-Manager" because the effect runs
    // twice without reverting between runs (consolidation review
    // round-2 C M-2). The cleanup also handles the case where `insecure`
    // flips false at runtime (would never happen in practice, but
    // writing it correctly costs nothing).
    const previous = document.title;
    document.title = 'UNSICHER \u2013 ' + previous;
    return () => {
      document.title = previous;
    };
  }, [insecure]);

  useEffect(() => {
    if (!authUser && !sessionCheckFired.current) {
      sessionCheckFired.current = true;
      useAuthStore
        .getState()
        .checkSession()
        .then(() => {
          if (useAuthStore.getState().authUser) {
            useProjectStore.getState().fetchProjects();
          }
        });
    }
  }, [authUser]);

  // Cross-cutting `project_changed` SSE subscription (api.md §14.2.13,
  // ADR-0025, AC-277). Auth-gated: opening `/api/events` before the
  // session cookie is set yields 401 and the EventSource transitions to
  // CLOSED with no spec-mandated reconnect — the page would then never
  // receive frames until a manual reload. The cleanup runs on logout
  // (authUser → null) so the server-side connection is released
  // promptly instead of waiting for the heartbeat re-validation tick.
  useEffect(() => {
    if (!authUser) return;
    return subscribeProjectStoresToSse();
  }, [authUser]);

  useEffect(() => {
    if (!authUser) return;
    return subscribeInvoiceStoreToSse();
  }, [authUser]);

  // Cross-cutting `attachment_changed` SSE subscription (api.md
  // §14.2.13, ADR-0025, AC-337). Same auth-gated lifecycle as the
  // project / invoice subscriptions above — refreshes the per-project
  // attachment caches so an always-open gallery / Papierkorb reflects
  // another user's add / hide / restore / purge (#237).
  useEffect(() => {
    if (!authUser) return;
    return subscribeAttachmentStoreToSse();
  }, [authUser]);

  if (authUser) {
    // View content — either router-managed or store-managed.
    // Router path: every known route goes through `ProtectedRoute`, which
    // renders `NotPermittedView` when the caller cannot access the path
    // (AC-149). The `/` and `*` fallbacks route to the user's landing
    // view (§8.1.2) via the central route table — never hardcoded.
    // Store-only fallback is used by tests rendering <App /> without a
    // router; it mirrors the same gate by consulting the table directly.
    const storeRoute = ROUTES.find((r) => r.view === activeView);
    const viewContent = hasRouter ? (
      <Routes>
        {ROUTES.map((r) => (
          <Route
            key={r.view}
            path={r.path}
            element={<ProtectedRoute element={VIEW_ELEMENTS[r.view]} />}
          />
        ))}
        <Route path="/" element={<LandingRedirect />} />
        <Route path="*" element={<LandingRedirect />} />
      </Routes>
    ) : storeRoute && storeRoute.canAccess(authUser) ? (
      VIEW_ELEMENTS[storeRoute.view]
    ) : (
      <NotPermittedView />
    );

    return (
      <div className={styles.app}>
        {hasRouter && <UrlStoreSync />}
        {insecure && (
          <div className={styles.insecureBanner} role="alert" data-testid="insecure-banner">
            UNSICHERER MODUS &mdash; Keine Verschl&uuml;sselung, Zugangsdaten werden im Klartext
            &uuml;bertragen
          </div>
        )}
        <Header />
        <main className={styles.main}>
          {mutationError && (
            <div className={styles.mutationError} role="alert" data-testid="mutation-error-banner">
              <span>{mutationError}</span>
              <button
                className={styles.mutationErrorDismiss}
                onClick={clearMutationError}
                aria-label={STRINGS.ui.closeError}
              >
                &#x2715;
              </button>
            </div>
          )}
          {viewContent}
        </main>
        {/* App-shell activity dock (AC-317/318/319). Mounted as a shell
            sibling — not inside the routed `<main>` — so a view switch
            does not remount it and its collapse state persists across
            navigation (AC-318). Gated to `audit:read` holders internally. */}
        <ActivityDock />
        <Footer />
        <MobileTabBar />
        {selectedProject && (
          <ProjectDetailPanel project={selectedProject} onClose={() => selectProject(null)} />
        )}
        <ConfirmDialog />
        <ToastContainer />
      </div>
    );
  }

  if (!sessionChecked) {
    return <div className={styles.loading}>{STRINGS.ui.loading}</div>;
  }

  return (
    <>
      {insecure && (
        <div className={styles.insecureBanner} role="alert" data-testid="insecure-banner">
          UNSICHERER MODUS &mdash; Keine Verschl&uuml;sselung, Zugangsdaten werden im Klartext
          &uuml;bertragen
        </div>
      )}
      <LoginForm />
    </>
  );
}
