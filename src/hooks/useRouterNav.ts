/**
 * Safe navigation hook — works with and without a React Router context.
 *
 * In production the app is wrapped in BrowserRouter (main.tsx) so useNavigate
 * and useLocation are available. In unit tests that render <App /> directly
 * (no router), the hook falls back to the Zustand UI store.
 *
 * Path ↔ ViewMode mapping lives in the central route table
 * (`src/config/routes.ts`) — this module re-exports the helpers so
 * existing callers keep a single import site.
 */

import { useInRouterContext, useNavigate, useLocation } from 'react-router';
import { useUIStore } from '@/state/uiStore';
import { viewFromPath, pathFromView, type RouteView } from '@/config/routes';
import type { ViewMode } from '@/domain/types';

/**
 * Compile-time mirror check: `RouteView` (config layer, can't import
 * `ViewMode`) must equal `ViewMode` exactly. If the two unions drift,
 * these two assignments fail `tsc --noEmit` and the offender gets
 * caught at build time. No runtime cost.
 */
type _RouteViewMirrorsViewMode = RouteView extends ViewMode ? true : never;
type _ViewModeMirrorsRouteView = ViewMode extends RouteView ? true : never;
const _routeViewMirror: _RouteViewMirrorsViewMode = true;
const _viewModeMirror: _ViewModeMirrorsRouteView = true;
void _routeViewMirror;
void _viewModeMirror;

export { viewFromPath, pathFromView };

/**
 * Hook that navigates via React Router when available, or falls back
 * to the Zustand UI store when rendered without a router (unit tests).
 *
 * The eslint-disable below is safe: useInRouterContext() returns a
 * constant per mount — a component is either inside a <BrowserRouter>
 * or not for its entire lifetime, so the hook call order never changes.
 */
export function useRouterNav() {
  const hasRouter = useInRouterContext();

  if (hasRouter) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useRouterNavWithRouter();
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useRouterNavWithStore();
}

/** Router path — only called when a BrowserRouter context is present. */
function useRouterNavWithRouter() {
  const navigate = useNavigate();
  const location = useLocation();
  const setView = useUIStore((s) => s.setView);

  return {
    navigateTo: (path: string) => {
      navigate(path);
      // Also sync the store so components reading activeView stay correct
      // before the URL→store sync effect fires.
      setView(viewFromPath(path));
    },
    pathname: location.pathname,
  };
}

/** Store-only path — used in tests that render without a router. */
function useRouterNavWithStore() {
  const setView = useUIStore((s) => s.setView);
  const activeView = useUIStore((s) => s.activeView);

  return {
    navigateTo: (path: string) => {
      setView(viewFromPath(path));
    },
    pathname: pathFromView(activeView),
  };
}
