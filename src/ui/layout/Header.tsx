import { useState, useLayoutEffect, useRef } from 'react';
import { useAuthStore } from '@/state/authStore';
import { useUIStore } from '@/state/uiStore';
import { useBackupStatusRefresh } from '@/hooks/useBackupStatusRefresh';
import { usePermission } from '@/hooks/usePermission';
import { useRouterNav } from '@/hooks/useRouterNav';
import { SECONDARY_VIEWS, landingPathForUser, visibleRoutesForUser } from '@/config/routes';
import { BRANDING } from '@/config/brandingConfig';
import { STRINGS } from '@/config/strings';
import { BACKUP_THRESHOLDS } from '@/config/backupThresholds';
import { deriveBadgeState } from '@/domain/backupBadge';
import type { ThemePreference } from '@/config/themeStorage';
import { BackupBadge } from './BackupBadge';
import { BrandMark } from './BrandMark';
import { MenuBackdrop } from '../common/MenuBackdrop';
import { EmailExtractModal } from '../extraction/EmailExtractModal';
import { PasswordChangeModal } from './PasswordChangeModal';
import { PushSubscriptionControls } from './PushSubscriptionControls';
import styles from './Header.module.css';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: STRINGS.theme.light },
  { value: 'dark', label: STRINGS.theme.dark },
  { value: 'system', label: STRINGS.theme.system },
];

/** First letters of up to two whitespace-separated words, uppercased.
 *  "Vladimir Zhelezarov" → "VZ"; "Inhaber" → "I"; "" → "". */
function initialsFromName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

export function Header() {
  const activeView = useUIStore((s) => s.activeView);
  const authUser = useAuthStore((s) => s.authUser);
  const backupStatus = useAuthStore((s) => s.backupStatus);
  const logout = useAuthStore((s) => s.logout);
  const updateThemePreference = useAuthStore((s) => s.updateThemePreference);
  const { navigateTo } = useRouterNav();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const [pwChangeOpen, setPwChangeOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Owner-only: keep `backupStatus` fresh without a full reload. The hook
  // is a no-op for every other role, so unconditional invocation is safe
  // (one-liner beats a conditional wrapper that the linter would flag as
  // a hook-rules violation anyway).
  useBackupStatusRefresh();

  // The dropdown is right-anchored by default (opens leftward). When the
  // header wraps and the button lands near the left edge of the viewport,
  // that leftward open clips off-screen. Flip to left-anchor in that
  // case. A fixed breakpoint can't decide this reliably — wrap depends
  // on summary content width, not viewport alone — so we measure the
  // button's position on open. Mutating the class directly (rather than
  // via setState) avoids a cascading render before paint.
  //
  // The width to fit against is the dropdown's actual `offsetWidth`, not
  // a hardcoded constant. The earlier snapshot of `min-width: 140px`
  // drifted from reality when the push-notification section added more
  // items — the check kept evaluating `rect.right >= 140` as true and
  // suppressed the flip even though the real 176-ish-px dropdown was
  // still clipping off-screen. Reading the live width at measure time
  // is self-correcting against future content growth.
  useLayoutEffect(() => {
    if (!dropdownOpen || !buttonRef.current || !dropdownRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const dropdownWidth = dropdownRef.current.offsetWidth;
    const leftwardFits = rect.right >= dropdownWidth;
    const rightwardFits = viewportWidth - rect.left >= dropdownWidth;
    // Only flip when the default (leftward open) would clip AND the
    // flipped direction actually has room. If neither fits, keep the
    // default so the clipping is at least symmetric with the wide-
    // layout case.
    dropdownRef.current.classList.toggle(styles.dropdownAlignLeft, !leftwardFits && rightwardFits);
  }, [dropdownOpen]);

  // Navigation is driven from the central route table so the per-role
  // matrix (`docs/spec/ui/index.md §8.7.1`, AC-75) has one source of truth —
  // the guard in `App.tsx` consults the same table. Extractor visibility
  // is an action affordance (not a nav concern), so it stays permission-
  // driven via `usePermission`.
  const visibleRoutes = authUser ? visibleRoutesForUser(authUser) : [];
  const canExtract = usePermission('customer:write');

  const primaryRoutes = visibleRoutes.filter((r) => !SECONDARY_VIEWS.includes(r.view));
  const secondaryRoutes = visibleRoutes.filter((r) => SECONDARY_VIEWS.includes(r.view));
  // A single-item dropdown is clutter — when only one secondary route is
  // available, render it inline alongside the primary tabs. The full
  // "Verwaltung" menu appears only when it groups two or more entries.
  const renderSecondaryAsMenu = secondaryRoutes.length >= 2;
  const inlineRoutes = renderSecondaryAsMenu
    ? primaryRoutes
    : [...primaryRoutes, ...secondaryRoutes];
  const secondaryActive = renderSecondaryAsMenu
    ? secondaryRoutes.some((r) => r.view === activeView)
    : false;

  // AC-170 + AC-171: the backup-freshness badge renders on every
  // authenticated surface for role `owner`. The login screen stays
  // badge-free because it renders no Header at all (see App.tsx).
  // Non-owners never see the badge — the server also omits
  // `backupStatus` for them, so the state would be `unknown`, but
  // hiding the surface entirely matches AC-170's "not rendered"
  // wording.
  //
  // `backupStatus === undefined` for an owner means the server could
  // not read the row (DB down). AC-171 forbids silently hiding the
  // badge in that case — `deriveBadgeState(undefined, …)` returns the
  // `unknown` branch, which the component renders as "Status unbekannt".
  // Do NOT gate on `backupStatus !== undefined` here; that would
  // reintroduce the misleading-state defect.
  const isOwner = authUser ? authUser.roles.includes('owner') : false;
  const backupBadgeState = isOwner
    ? deriveBadgeState(backupStatus, new Date(), BACKUP_THRESHOLDS)
    : null;

  const handleLogout = async () => {
    setDropdownOpen(false);
    // authStore.logout() now clears downstream project/UI state itself
    // so the session-expired path and the interactive logout path
    // cannot diverge (consolidation review C F-6).
    await logout();
  };

  const handleThemeSelect = (value: ThemePreference) => {
    // Fire-and-forget: the store handles optimistic update, server
    // round-trip, and revert-on-failure. Swallow the returned promise so
    // the click handler stays synchronous from React's perspective.
    void updateThemePreference(value);
  };

  return (
    <header className={styles.header} data-testid="header">
      <div className={styles.navGroup}>
        <button
          type="button"
          className={styles.appName}
          onClick={() => {
            if (authUser) navigateTo(landingPathForUser(authUser));
          }}
          data-testid="header-app-name"
          title={STRINGS.ui.navHome}
          aria-label={`${BRANDING.appName} — ${STRINGS.ui.navHome}`}
        >
          {/* Wordmark collapses at ≤900px so the right-hand cluster fits
              on one row at 360px; `BrandMark` owns the mark itself and
              its own visibility rules. */}
          <span className={styles.appNameText}>{BRANDING.appName}</span>
          <BrandMark />
        </button>
        {(inlineRoutes.length > 0 || renderSecondaryAsMenu) && (
          <div className={styles.viewToggle}>
            {inlineRoutes.map((r) => (
              <button
                key={r.view}
                className={`${styles.viewButton} ${activeView === r.view ? styles.viewButtonActive : ''}`}
                onClick={() => navigateTo(r.path)}
                data-testid={`view-toggle-${r.view}`}
              >
                {r.label}
              </button>
            ))}
            {renderSecondaryAsMenu && (
              <div className={styles.adminMenu}>
                <button
                  className={`${styles.adminTrigger} ${secondaryActive ? styles.adminTriggerActive : ''}`}
                  onClick={() => setAdminMenuOpen((o) => !o)}
                  data-testid="nav-admin-trigger"
                  aria-haspopup="menu"
                  aria-expanded={adminMenuOpen}
                  title={STRINGS.ui.navAdminMenu}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span className={styles.adminTriggerLabel}>{STRINGS.ui.navAdminMenu}</span>
                </button>
                {adminMenuOpen && (
                  <>
                    <MenuBackdrop onClose={() => setAdminMenuOpen(false)} />
                    <div className={styles.adminDropdown} role="menu">
                      {secondaryRoutes.map((r) => (
                        <button
                          key={r.view}
                          role="menuitem"
                          className={`${styles.dropdownItem} ${activeView === r.view ? styles.dropdownItemSelected : ''}`}
                          onClick={() => {
                            setAdminMenuOpen(false);
                            navigateTo(r.path);
                          }}
                          data-testid={`view-toggle-${r.view}`}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Right-side cluster: extract + backup + user. Grouping these
          eliminates the ~row-of-blank-space that the previous layout
          left between the nav group and the user menu on phones —
          `navGroup` wrapped below the user button, leaving the icons
          stranded on their own visual row. All three now share a
          single cluster so they sit on the same line as the user
          button and only wrap together when the viewport is very
          narrow. */}
      <div className={styles.rightCluster}>
        {canExtract && (
          <button
            className={styles.extractButton}
            onClick={() => setExtractOpen(true)}
            data-testid="extract-button"
            title={STRINGS.ui.extractEmail}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
              <path d="M5 3v4" />
              <path d="M19 17v4" />
              <path d="M3 5h4" />
              <path d="M17 19h4" />
            </svg>
          </button>
        )}
        {backupBadgeState && <BackupBadge state={backupBadgeState} variant="inverse" />}
        {authUser && (
          <div className={styles.userMenu}>
            {/*
            Two tests hit this button:
              - `user-menu-trigger` is the push-permission e2e contract
                (e2e/push-permission.spec.ts), where the spec clicks the
                menu trigger to reach the push affordances.
              - `user-indicator` is the legacy auth/kanban contract,
                where specs assert the display name text and/or click
                the element to open the menu.
            HTML forbids duplicate attributes, and a single
            `data-testid` can only carry one value. The click target is
            the button (everything inside the span bubbles up), so the
            inner `user-indicator` span is where the display-name text
            lives and both legacy locators — `.click()` and
            `.toContainText(displayName)` — still resolve against it.
          */}
            <button
              ref={buttonRef}
              className={styles.userButton}
              data-testid="user-menu-trigger"
              onClick={() => setDropdownOpen(!dropdownOpen)}
              title={authUser.displayName}
            >
              {/* Full name holds the legacy test contract (toContainText);
                  mobile collapses to the initials span via CSS. Both live
                  in the DOM so `user-indicator` always contains the text
                  regardless of viewport. */}
              <span data-testid="user-indicator" className={styles.userFullName}>
                {authUser.displayName}
              </span>
              <span className={styles.userInitials} aria-hidden="true">
                {initialsFromName(authUser.displayName)}
              </span>
            </button>
            {dropdownOpen && (
              <>
                <MenuBackdrop onClose={() => setDropdownOpen(false)} />
                <div ref={dropdownRef} className={styles.dropdown}>
                  <div className={styles.dropdownSection}>
                    <div className={styles.dropdownSectionLabel}>{STRINGS.theme.section}</div>
                    {THEME_OPTIONS.map((opt) => {
                      const selected = authUser.themePreference === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          className={`${styles.dropdownItem} ${selected ? styles.dropdownItemSelected : ''}`}
                          aria-pressed={selected}
                          data-testid={`theme-option-${opt.value}`}
                          onClick={() => handleThemeSelect(opt.value)}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <PushSubscriptionControls />
                  <button
                    className={styles.dropdownItem}
                    data-testid="pw-change-button"
                    onClick={() => {
                      setDropdownOpen(false);
                      setPwChangeOpen(true);
                    }}
                  >
                    {STRINGS.password.change}
                  </button>
                  <button
                    className={styles.dropdownItem}
                    data-testid="logout-button"
                    onClick={handleLogout}
                  >
                    {STRINGS.auth.logout}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {extractOpen && <EmailExtractModal onClose={() => setExtractOpen(false)} />}
      {pwChangeOpen && <PasswordChangeModal onClose={() => setPwChangeOpen(false)} />}
    </header>
  );
}
