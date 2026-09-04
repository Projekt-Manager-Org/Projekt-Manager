import { test, expect } from '@playwright/test';
import { STRINGS } from '../src/config/strings';
import { STORAGE_STATES } from './storage-states';
import { clickView, expectViewReachable } from './nav-helpers';

/**
 * Permission-based UI visibility (AC-121 [crit]) + forbidden-URL smoke
 * (AC-149 [vis]).
 *
 * Verifies that every action-triggering UI control is hidden for users
 * whose roles do not grant the backing permission. This is the client
 * side of the `requirePermission` contract — the server is always
 * authoritative, but rendering an affordance that always 403s is
 * misleading state (ADR-0014 Tier-1).
 *
 * Per-role nav matrix (AC-75) is pinned at the table/component layer by
 * `src/config/__tests__/routes.test.ts` and
 * `src/ui/layout/__tests__/Header.test.tsx`; not re-asserted here. The
 * AC-149 forbidden-path matrix is pinned by
 * `src/ui/common/__tests__/NotPermittedView.test.tsx`; this spec keeps
 * a single representative case as the browser-level smoke.
 *
 * Each role consumes a pre-authenticated storage state saved by
 * `e2e/auth.setup.ts` — no per-test login, so the suite does not burn
 * through the dev-mode login rate limit (30/min per IP,
 * `src/server/config/index.ts`).
 *
 * Asserts with toHaveCount / toBeVisible / toHaveURL — NOT screenshots —
 * because AC-121 / AC-149 are critical-ish behavior.
 */

type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

interface RoleCase {
  username: string;
  /** Access to the Kanban view (ui/index.md §8.7.1 — owner/office/worker). */
  canSeeKanban: boolean;
  /** Access to the Projekte/Kunden management views (owner/office/bookkeeper). */
  canSeeManagement: boolean;
  canReadUsers: boolean;
  canManageUsers: boolean;
  canDeleteUsers: boolean;
  canExtract: boolean;
  canCreateProject: boolean;
  canUpdateProject: boolean;
  canDeleteProject: boolean;
  canTransition: boolean;
  canUpdateDates: boolean;
  canCreateCustomer: boolean;
  canDeleteCustomer: boolean;
  /** `data:export` — gates Daten tab visibility and the export action. */
  canExportData: boolean;
  /** `data:restore` — gates the import form inside the Daten view. */
  canRestoreData: boolean;
  /** `notifications:manage` — gates Benachrichtigungen tab visibility (AC-198). */
  canManageNotifications: boolean;
  /** `invoice:read` — gates Rechnungen tab visibility (ui/invoices.md §8.16.1). */
  canReadInvoices: boolean;
}

/**
 * Expected visibility derived from ROLE_PERMISSIONS in
 * `src/config/permissions.ts` AND the nav matrix in
 * `docs/spec/ui/index.md §8.7.1` (AC-75). Keep in sync when either changes.
 */
const roleCases: Record<Role, RoleCase> = {
  owner: {
    username: 'inhaber',
    canSeeKanban: true,
    canSeeManagement: true,
    canReadUsers: true,
    canManageUsers: true,
    canDeleteUsers: true,
    canExtract: true,
    canCreateProject: true,
    canUpdateProject: true,
    canDeleteProject: true,
    canTransition: true,
    canUpdateDates: true,
    canCreateCustomer: true,
    canDeleteCustomer: true,
    canExportData: true,
    canRestoreData: true,
    canManageNotifications: true,
    canReadInvoices: true,
  },
  office: {
    username: 'buero',
    canSeeKanban: true,
    canSeeManagement: true,
    // Per the nav matrix in `docs/spec/ui/index.md §8.7.1` (AC-75), the
    // Benutzer tab is owner-only even though office holds `user:read`
    // in `permissions.ts`. The client-side route predicate gates
    // Benutzer on `user:manage` (owner-only) to make the nav match
    // the spec. See `src/config/routes.ts` for the rationale.
    canReadUsers: false,
    canManageUsers: false,
    canDeleteUsers: false,
    canExtract: true,
    canCreateProject: true,
    canUpdateProject: true,
    canDeleteProject: true,
    canTransition: true,
    canUpdateDates: true,
    canCreateCustomer: true,
    canDeleteCustomer: false,
    canExportData: true,
    canRestoreData: false,
    canManageNotifications: false,
    canReadInvoices: true,
  },
  worker: {
    username: 'arbeiter1',
    canSeeKanban: true,
    canSeeManagement: false,
    canReadUsers: false,
    canManageUsers: false,
    canDeleteUsers: false,
    canExtract: false,
    canCreateProject: false,
    canUpdateProject: false,
    canDeleteProject: false,
    canTransition: false,
    canUpdateDates: false,
    canCreateCustomer: false,
    canDeleteCustomer: false,
    canExportData: false,
    canRestoreData: false,
    canManageNotifications: false,
    canReadInvoices: false,
  },
  bookkeeper: {
    username: 'buchhalter',
    canSeeKanban: false,
    canSeeManagement: true,
    canReadUsers: false,
    canManageUsers: false,
    canDeleteUsers: false,
    canExtract: false,
    canCreateProject: false,
    canUpdateProject: false,
    canDeleteProject: false,
    canTransition: false,
    canUpdateDates: false,
    canCreateCustomer: false,
    canDeleteCustomer: false,
    canExportData: false,
    canRestoreData: false,
    canManageNotifications: false,
    canReadInvoices: true,
  },
};

test.describe('AC-121: permission-based UI visibility', () => {
  for (const [role, c] of Object.entries(roleCases) as [Role, RoleCase][]) {
    test.describe(role, () => {
      test.use({ storageState: STORAGE_STATES[role] });
      test('action controls match ROLE_PERMISSIONS', async ({ page }) => {
        await page.goto('/');

        // -- Header navigation and extract button --------------------------
        // Nav visibility is driven by the central route table (§8.7.1).
        // `expectViewReachable` handles both inline and admin-menu renderings.
        await expectViewReachable(page, 'kanban', c.canSeeKanban);
        await expectViewReachable(page, 'projekte', c.canSeeManagement);
        await expectViewReachable(page, 'kunden', c.canSeeManagement);
        await expectViewReachable(page, 'rechnungen', c.canReadInvoices);
        await expectViewReachable(page, 'benutzer', c.canReadUsers);
        // AC-198 — Notification Rules view (Benachrichtigungen tab)
        // gated on notifications:manage (owner only under default matrix).
        await expectViewReachable(page, 'benachrichtigungen', c.canManageNotifications);
        await expect(page.getByTestId('extract-button')).toHaveCount(c.canExtract ? 1 : 0);

        // -- Footer storage badge (AC-271) ---------------------------------
        // `data:export` gate mirrors the server gate on /api/storage-usage;
        // worker and bookkeeper see brand text alone. Desktop viewport
        // (default 1920×1080 in this project) — phones hide the Footer
        // entirely via the existing footer media query, and that branch
        // is unobservable without mobile emulation. The tooltip's plaintext
        // labels (Sichtbar / Im Papierkorb) are pinned at unit level by
        // `src/ui/layout/__tests__/Footer.test.tsx`.
        await expect(page.getByTestId('storage-usage-badge')).toHaveCount(c.canExportData ? 1 : 0);

        // -- Kanban view: transition controls on cards and detail panel ----
        // Only reachable when Kanban is in the role's nav matrix. Roles
        // without Kanban access (bookkeeper) cannot navigate there at all;
        // the server-side scoping for transitions is covered by unit tests.
        if (c.canSeeKanban) {
          await clickView(page, 'kanban');
          await page.getByTestId('kanban-board').waitFor();
          // Wait until at least one card has rendered — the subsequent
          // `forward-button-*` count assertion races the initial fetch
          // otherwise and reports 0 before any card mounts.
          await page.locator('[data-testid^="project-card-"]').first().waitFor();

          // Transition arrows live on the Kanban cards now (not in the
          // detail panel). The card renders `forward-button-*` /
          // `backward-button-*` gated on both `canTransition` and the
          // per-state eligibility; at least one direction is available in
          // every workflow state, so the sum is ≥ 1 for permitted callers.
          const cardForwardCount = await page.locator('[data-testid^="forward-button-"]').count();
          const cardBackwardCount = await page.locator('[data-testid^="backward-button-"]').count();
          if (c.canTransition) {
            expect(cardForwardCount + cardBackwardCount).toBeGreaterThan(0);
          } else {
            expect(cardForwardCount).toBe(0);
            expect(cardBackwardCount).toBe(0);
          }

          // Project detail panel (open first card).
          await page.locator('[data-testid^="project-card-"]').first().click();
          await page.getByTestId('detail-panel').waitFor();

          await expect(page.getByTestId('detail-date-start')).toHaveCount(c.canUpdateDates ? 1 : 0);
          await expect(page.getByTestId('detail-date-end')).toHaveCount(c.canUpdateDates ? 1 : 0);

          await page.getByTestId('detail-close').click();
        }

        // -- Projekte management view --------------------------------------
        // Only owner / office / bookkeeper see the Projekte tab (ui/index.md
        // §8.7.1 — worker is excluded). Skip the management assertions
        // entirely for worker since the view is not navigable.
        if (c.canSeeManagement) {
          await clickView(page, 'projekte');
          await page.getByTestId('project-table').locator('tbody tr').first().waitFor();

          await expect(page.getByTestId('project-create-button')).toHaveCount(
            c.canCreateProject ? 1 : 0,
          );

          const projectArchiveBtns = page
            .getByTestId('project-table')
            .getByTestId('project-archive-button');
          if (c.canDeleteProject) {
            expect(await projectArchiveBtns.count()).toBeGreaterThan(0);
          } else {
            expect(await projectArchiveBtns.count()).toBe(0);
          }

          // Click into the first row: navigation is to the detail page.
          // The title input is read-only for callers without
          // `project:update` (hidden-control parity).
          await page.getByTestId('project-table').locator('tbody tr').first().click();
          const titleEdit = page.getByTestId('project-title-edit');
          await titleEdit.waitFor({ state: 'visible' });
          if (c.canUpdateProject) {
            await expect(titleEdit).not.toHaveAttribute('readonly', '');
          } else {
            await expect(titleEdit).toHaveAttribute('readonly', '');
          }
          await clickView(page, 'projekte');

          // -- Kunden management view --------------------------------------
          await clickView(page, 'kunden');
          await page.getByTestId('customer-table').locator('tbody tr').first().waitFor();

          await expect(page.getByTestId('customer-create-button')).toHaveCount(
            c.canCreateCustomer ? 1 : 0,
          );

          const customerDeleteBtns = page
            .getByTestId('customer-table')
            .locator('tbody button', { hasText: /löschen/i });
          if (c.canDeleteCustomer) {
            expect(await customerDeleteBtns.count()).toBeGreaterThan(0);
          } else {
            expect(await customerDeleteBtns.count()).toBe(0);
          }
        }

        // -- Daten (unified data-exchange) view ----------------------------
        // AC-142: the Daten tab itself is gated on `data:export`. Roles
        // without it must not see the nav toggle at all. Inside the view,
        // the import sub-form is gated on `data:restore` (owner only).
        await expectViewReachable(page, 'daten', c.canExportData);
        if (c.canExportData) {
          await clickView(page, 'daten');
          await page.getByTestId('daten-view').waitFor();

          await expect(page.getByTestId('data-export-button')).toHaveCount(1);
          await expect(page.getByTestId('data-import-file-input')).toHaveCount(
            c.canRestoreData ? 1 : 0,
          );

          // AC-272 — Speichernutzung row at the top of DatenView is pinned
          // by `src/ui/management/__tests__/DatenView.storageRow.test.tsx`.
        }

        // -- Benutzer management view (only if user:read) ------------------
        if (c.canReadUsers) {
          await clickView(page, 'benutzer');
          await page.getByTestId('user-table').locator('tbody tr').first().waitFor();

          await expect(page.getByTestId('user-create-button')).toHaveCount(
            c.canManageUsers ? 1 : 0,
          );

          // Open a user detail to check the management action buttons.
          // Target `buchhalter` — always active and never the logged-in
          // user (owner or office), so deactivate visibility reflects
          // `user:manage` and delete visibility reflects `user:delete`,
          // without interference from the self-delete guard or the
          // inactive-user reactivate branch. Picked by content because
          // the list API does not guarantee row order (repositories/user.ts
          // has no ORDER BY — tracked separately).
          const targetRow = page
            .getByTestId('user-table')
            .locator('tbody tr', { hasText: 'buchhalter' });
          await expect(targetRow).toHaveCount(1);
          await targetRow.click();

          await expect(page.getByTestId('user-deactivate-button')).toHaveCount(
            c.canManageUsers ? 1 : 0,
          );
          await expect(page.getByTestId('user-reset-pw-button')).toHaveCount(
            c.canManageUsers ? 1 : 0,
          );
          await expect(page.getByTestId('user-delete-button')).toHaveCount(
            c.canDeleteUsers ? 1 : 0,
          );
        }
      });
    });
  }
});

/**
 * AC-149 — manual URL entry to a forbidden path presents the explicit
 * not-permitted error surface (`NotPermittedView`), the URL stays put,
 * and no other view-level content renders.
 *
 * The component test `src/ui/common/__tests__/NotPermittedView.test.tsx`
 * pins the full role × path matrix at the component level (MemoryRouter).
 * This E2E keeps a single representative case (worker → /customers) as
 * the browser-level smoke for the same contract: URL stays,
 * not-permitted view renders, no landing view mounts.
 */
// Landing-view testids that should NOT render when the guard is active.
// Any of these rendering alongside `not-permitted-view` would indicate
// the guard leaked content for the forbidden path.
const VIEW_TESTIDS: readonly string[] = [
  'kanban-board',
  'calendar-view',
  'project-table',
  'customer-table',
  'user-table',
  'daten-view',
];

test.describe('AC-149: forbidden URL probe → NotPermittedView, URL unchanged', () => {
  test.use({ storageState: STORAGE_STATES.worker });
  test('worker direct nav to /customers sees not-permitted surface and URL stays', async ({
    page,
  }) => {
    // Storage state authenticates the caller (see auth.setup.ts);
    // navigating directly to the forbidden path simulates a user
    // typing a URL or following a bookmark to an off-matrix view.
    await page.goto('/customers');

    // The not-permitted surface renders with the German copy sourced
    // from STRINGS (no hardcoded strings in the spec).
    const surface = page.getByTestId('not-permitted-view');
    await expect(surface).toBeVisible();
    await expect(surface).toContainText(STRINGS.ui.notPermittedHeading);
    await expect(surface).toContainText(STRINGS.ui.notPermittedBody);

    // AC-149 clause: "URL in the address bar remains unchanged".
    // Playwright's auto-waiting toHaveURL handles the navigation
    // settling; no raw waitForTimeout required.
    await expect(page).toHaveURL(/\/customers$/);

    // No landing view mounts alongside the guard. Any of these
    // testids appearing would indicate the guard leaked content.
    for (const testid of VIEW_TESTIDS) {
      await expect(page.getByTestId(testid)).toHaveCount(0);
    }
  });
});
