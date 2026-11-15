import { test, expect } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';

/**
 * Structural E2E for the backup-freshness badge surface (AC-612 [crit], AC-613 [vis]).
 *
 * AC-612 and AC-613 pin two visibility claims:
 *
 *   1. The badge is NOT rendered on the unauthenticated login screen.
 *      The login surface is auth-only — health affordances belong on
 *      authenticated views where the operator can act on them.
 *   2. On every authenticated surface, the badge is visible only to
 *      callers with role `owner`. Other authenticated roles never see
 *      the badge on any route.
 *
 * Verified structurally (presence / absence of `[data-testid="backup-badge"]`),
 * never by pixel-diff. Structural assertions are the project convention
 * for `[vis]` ACs.
 */

type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

/**
 * Expected badge visibility per role. Owner is the only role that
 * sees the badge — AC-612 for the owner, AC-613 for the rest. Checked on the
 * landing view; the owner also keeps the badge on non-landing routes
 * (separate assertion below).
 */
const BADGE_ON_LANDING: Record<Role, boolean> = {
  owner: true,
  office: false,
  worker: false,
  bookkeeper: false,
};

test.describe('AC-613: backup-freshness badge — unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login screen does not render the badge', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('backup-badge')).toHaveCount(0);
  });
});

test.describe('AC-612, AC-613: backup-freshness badge — authenticated landing per role', () => {
  for (const [role, visible] of Object.entries(BADGE_ON_LANDING) as [Role, boolean][]) {
    test.describe(role, () => {
      test.use({ storageState: STORAGE_STATES[role] });
      test(`badge ${visible ? 'visible' : 'hidden'} on landing`, async ({ page }) => {
        await page.goto('/');

        // Assert-against-the-claim: owner's landing shows the badge;
        // every other role's landing does not render it at all.
        // `toHaveCount(0 | 1)` instead of `toBeVisible` / `toBeHidden`
        // to make "not rendered" (absent from the DOM) explicit — a
        // CSS-hidden badge would still pass `toBeHidden` and would
        // violate AC-613's "show no backup badge" wording.
        const badge = page.getByTestId('backup-badge');
        await expect(badge).toHaveCount(visible ? 1 : 0);
      });
    });
  }
});

test.describe('AC-612: backup-freshness badge — owner non-landing surface', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  test('non-landing authenticated surface renders the badge for owner', async ({ page }) => {
    // Owner sees the badge on every authenticated surface. Navigating
    // to another authenticated route (here: customers) must keep the
    // badge rendered.
    await page.goto('/');

    // Navigate to Kunden — any non-landing route is valid; Kunden is
    // stable for owner across role-matrix changes.
    await page.getByTestId('view-toggle-kunden').click();
    await page.getByTestId('customer-table').waitFor();

    // Badge stays rendered on this surface for owner.
    await expect(page.getByTestId('backup-badge')).toHaveCount(1);
  });
});
