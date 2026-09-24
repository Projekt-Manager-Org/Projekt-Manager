/**
 * Phone-only bottom tab bar — Android-style primary nav.
 *
 * Renders the user's primary destinations (everything visible in nav
 * except the secondary "Verwaltung" set) as icons + labels, fixed to
 * the bottom of the viewport. Hidden at >= md via CSS — the desktop
 * keeps the top nav pill.
 *
 * The header's primary nav buttons are hidden in the same breakpoint
 * (Header.module.css), so the two surfaces never compete on a phone.
 * Verwaltung / email-extract / backup badge / user menu remain in the
 * top header on every viewport because they are admin / status
 * affordances, not destinations the worker reaches every minute.
 */
import { useAuthStore } from '@/state/authStore';
import { useUIStore } from '@/state/uiStore';
import { useRouterNav } from '@/hooks/useRouterNav';
import { SECONDARY_VIEWS, visibleRoutesForUser } from '@/config/routes';
import { TAB_BAR_ICONS } from './tabBarIconMap';
import styles from './MobileTabBar.module.css';

export function MobileTabBar() {
  const authUser = useAuthStore((s) => s.authUser);
  const activeView = useUIStore((s) => s.activeView);
  const { navigateTo } = useRouterNav();

  if (!authUser) return null;

  // Mirrors the Header's "≥2 to render the menu" rule (Header.tsx) — a
  // single-item secondary bucket renders inline alongside the primary
  // tabs so the user reaches it in one tap. Bookkeeper's only secondary
  // entry is `rechnungen`, so on a phone they see `Rechnungen` next to
  // Projekte / Kunden rather than behind the header's Verwaltung
  // dropdown.
  const visibleRoutes = visibleRoutesForUser(authUser);
  const primaryRoutes = visibleRoutes.filter((r) => !SECONDARY_VIEWS.includes(r.view));
  const secondaryRoutes = visibleRoutes.filter((r) => SECONDARY_VIEWS.includes(r.view));
  const tabRoutes =
    secondaryRoutes.length >= 2 ? primaryRoutes : [...primaryRoutes, ...secondaryRoutes];

  // Empty tab set (e.g. unknown-role caller) — render nothing
  // rather than an empty bar that would steal vertical real estate.
  if (tabRoutes.length === 0) return null;

  return (
    <nav className={styles.tabBar} data-testid="mobile-tab-bar" aria-label="Hauptnavigation">
      {tabRoutes.map((r) => {
        const active = r.view === activeView;
        const Icon = TAB_BAR_ICONS[r.view];
        return (
          <button
            key={r.view}
            type="button"
            className={`${styles.tab} ${active ? styles.tabActive : ''}`}
            onClick={() => navigateTo(r.path)}
            data-testid={`tab-bar-${r.view}`}
            aria-current={active ? 'page' : undefined}
          >
            {Icon && <Icon className={styles.icon} />}
            <span className={styles.label}>{r.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
