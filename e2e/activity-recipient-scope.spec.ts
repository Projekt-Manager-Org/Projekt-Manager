import { test, expect, type APIRequestContext } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';
import { clickView } from './nav-helpers';

/**
 * E2E — Aktivität view's recipient-scoped default + "Alles anzeigen" toggle.
 *
 * Pins AC-200 from `docs/spec/verification.md §15.24` and the default
 * rendering rules in `docs/spec/ui/management.md §8.13.1`.
 *
 * Default view: only rows where the caller is a resolved notification-
 * rule recipient. `Alles anzeigen` toggle switches to the full RBAC-
 * scoped feed. Toggle state is local-only; navigation away and back
 * restores the default.
 *
 * Empty-state copy differs from AC-185:
 *   - Rules exist + caller is not a recipient → `"Keine
 *     Benachrichtigungen für Sie. `Alles anzeigen` für den vollständigen
 *     Aktivitätsverlauf."`
 *   - `Alles anzeigen` toggled on + RBAC feed empty → `"Keine Aktivität"`.
 *
 * Uses `chromium-mutating` because the spec seeds rules via the API to
 * drive the recipient-scoping observation.
 */

test.describe.configure({ mode: 'serial' });

/**
 * Remove every pre-existing rule for a given eventClass. This is
 * required for fixture isolation: the DB seed installs a
 * `project.archived → roles: ['owner']` rule, and earlier specs may
 * archive projects that match it — producing audit rows the
 * recipient-scoped view renders for owner. Deleting the seed rule
 * before posting a bookkeeper-only rule makes the "caller is not a
 * recipient" premise structurally true regardless of prior mutations.
 */
async function clearRulesForEvent(request: APIRequestContext, eventClass: string): Promise<void> {
  const listRes = await request.get('/api/notification-rules');
  expect(listRes.ok(), `GET /api/notification-rules failed: ${listRes.status()}`).toBe(true);
  // The endpoint returns a paginated envelope: { data: [...], total: N }.
  const body = (await listRes.json()) as { data: Array<{ id: string; eventClass: string }> };
  const rules = body.data ?? [];
  for (const rule of rules) {
    if (rule.eventClass === eventClass) {
      const delRes = await request.delete(`/api/notification-rules/${rule.id}`);
      expect(
        delRes.ok(),
        `DELETE /api/notification-rules/${rule.id} failed: ${delRes.status()}`,
      ).toBe(true);
    }
  }
}

// ---------------------------------------------------------------
// AC-200 — Default is recipient-scoped; toggle switches to full view
// ---------------------------------------------------------------
test.describe('AC-200: Aktivität defaults to recipient-scoped; Alles anzeigen switches to full feed', () => {
  test.describe('owner', () => {
    test.use({ storageState: STORAGE_STATES.owner });

    // Restore the seed rule for `project.archived → owner` that the
    // 'distinctive empty-state' test clears for fixture isolation.
    // Without this, specs that run after this file (e.g. activity-feed.spec.ts)
    // find no owner-recipient rule and see 0 rows in the default view.
    test.afterAll(async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: STORAGE_STATES.owner });
      try {
        await ctx.request.post('/api/notification-rules', {
          data: {
            eventClass: 'project.archived',
            recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
            enabled: true,
          },
        });
      } finally {
        await ctx.close();
      }
    });

    test('toggle state is local-only: navigation returns to the default', async ({ page }) => {
      await page.goto('/');
      await clickView(page, 'aktivitaet');

      // Default view — toggle reads "Alles anzeigen" unchecked.
      const toggle = page.getByTestId('activity-recipient-toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).not.toBeChecked();

      // Activate — full RBAC feed.
      await toggle.check();
      await expect(toggle).toBeChecked();

      // Navigate away and back — toggle resets to default (unchecked).
      await clickView(page, 'kanban');
      await page.getByTestId('kanban-board').waitFor();
      await clickView(page, 'aktivitaet');
      await expect(page.getByTestId('activity-recipient-toggle')).not.toBeChecked();
    });

    test('distinctive empty-state when rules exist but caller is not a recipient', async ({
      page,
    }) => {
      // Fixture isolation: remove every existing `project.archived` rule
      // so the seed rule (owner) and any rules left by prior specs do not
      // bleed rows into the recipient-scoped view for owner. Then POST a
      // bookkeeper-only rule so the premise "rules exist but caller is not
      // a recipient" is structurally true — independent of what earlier
      // specs archived.
      await clearRulesForEvent(page.request, 'project.archived');

      const fixtureRes = await page.request.post('/api/notification-rules', {
        data: {
          eventClass: 'project.archived',
          recipientSpec: {
            roles: ['bookkeeper'],
            includeAssignedWorkers: false,
            userIds: [],
          },
          enabled: true,
        },
      });
      expect(fixtureRes.status()).toBe(201);

      await page.goto('/');
      await clickView(page, 'aktivitaet');

      // Default recipient-scoped view empty → the distinctive copy
      // appears. The exact German literal is spec-pinned by AC-200.
      const empty = page.getByTestId('activity-recipient-empty-state');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText('Keine Benachrichtigungen für Sie');
      await expect(empty).toContainText('Alles anzeigen');
    });

    test('Alles anzeigen switches to the full feed; empty copy reverts to "Keine Aktivität"', async ({
      page,
    }) => {
      await page.goto('/');
      await clickView(page, 'aktivitaet');

      // Toggle to "Alles anzeigen".
      await page.getByTestId('activity-recipient-toggle').check();

      // Apply a far-future `from` filter so the RBAC feed is empty —
      // the full-feed empty state MUST read "Keine Aktivität", not
      // the recipient-scoped variant.
      await page.getByTestId('audit-filter-from').fill('2099-01-01');

      const list = page.getByTestId('audit-list');
      const empty = list.getByTestId('audit-empty-state');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText('Keine Aktivität');
    });
  });
});
