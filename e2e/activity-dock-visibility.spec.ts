import { test, expect } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';

/**
 * E2E — activity dock visibility per role (AC-319 [crit]).
 *
 * Pins the dock's permission gate from `docs/spec/verification.md §15.32`:
 * the app-shell live activity dock (ui/index.md §8.1.2) renders ONLY to
 * callers holding `audit:read` — owner and office under the default matrix
 * (src/config/permissions.ts) — and worker and bookkeeper NEVER see it.
 *
 * This is the client side of the `audit:read` contract: rendering a feed
 * surface to a caller the server would 403 is misleading state (ADR-0014
 * Tier-1 [crit]). The server gate is authoritative regardless.
 *
 * ── Testid contract (shared with e2e/activity-dock.spec.ts) ───────────
 *   - `activity-dock` — outer container; present ONLY for `audit:read`
 *     holders on desktop. This file asserts presence/absence per role.
 *
 * Scope boundaries (avoid T-REDU):
 *   - AC-180 (src/server/.. audit-log) owns the read-endpoint gate; the
 *     403 cross-check below is a single light browser-level sanity that
 *     audit CONTENT is gated for a non-holder, not a re-derivation of the
 *     per-role read matrix.
 *   - AC-320 (verification.md §15.28) owns the "SSE carries only the
 *     contentless `audit_changed` envelope" claim; it is not re-asserted
 *     here. This file's primary job is dock VISIBILITY per role.
 *
 * Read-only: no mutations, so this runs under the `chromium` project (it
 * is deliberately NOT added to `MUTATING_TESTS`). Each role loads its
 * pre-authenticated storage state (e2e/auth.setup.ts) — no per-test login.
 * Desktop viewport is the project default (1920×1080); the dock's
 * phone-hidden branch is pinned by AC-318 in e2e/activity-dock.spec.ts.
 */

type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

/**
 * Expected dock visibility, derived from `audit:read` in
 * ROLE_PERMISSIONS (src/config/permissions.ts): owner + office hold it,
 * worker + bookkeeper do not. Keep in sync if the matrix changes.
 */
const DOCK_VISIBLE_BY_ROLE: Record<Role, boolean> = {
  owner: true,
  office: true,
  worker: false,
  bookkeeper: false,
};

test.describe('AC-319: activity dock rendered only to audit:read holders', () => {
  for (const [role, dockVisible] of Object.entries(DOCK_VISIBLE_BY_ROLE) as [Role, boolean][]) {
    test.describe(role, () => {
      test.use({ storageState: STORAGE_STATES[role] });
      test(`activity dock is ${dockVisible ? 'present' : 'absent'}`, async ({ page }) => {
        await page.goto('/');
        // Anchor on a rendered shell before asserting on the dock so the
        // absence checks below cannot pass merely because the page has not
        // painted yet — the header is present in the authenticated layout
        // for every role.
        await expect(page.getByTestId('header')).toBeVisible();

        const dock = page.getByTestId('activity-dock');
        if (dockVisible) {
          await expect(dock).toBeVisible();
        } else {
          // Not merely hidden — the container must not be in the DOM at
          // all for callers without `audit:read`.
          await expect(dock).toHaveCount(0);
        }
      });
    });
  }
});

test.describe('AC-319: audit content is gated for a non-holder (browser-level sanity)', () => {
  test.use({ storageState: STORAGE_STATES.worker });
  test('worker GET /api/audit is 403', async ({ page }) => {
    // Worker lacks `audit:read`, so the dock's content endpoint
    // (api.md §14.2.8, the same route the dock would fetch) must 403 the
    // caller. This is the corroborating server gate behind the absent dock
    // above — the full per-role read matrix is AC-180's (src/server/..
    // audit-log); this single case keeps the dock's visibility split
    // honest end-to-end without duplicating that suite.
    const res = await page.request.get('/api/audit');
    expect(res.status()).toBe(403);
  });
});
