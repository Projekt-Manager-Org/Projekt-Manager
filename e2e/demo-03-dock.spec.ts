/**
 * Demo segment 03 — Live-Überblick (the activity dock). The owner leaves
 * the dock open on the board; a colleague (a second, unrecorded session)
 * creates a project, and the row appears in the dock live — no refresh.
 * The killer feature: the whole company, in real time. Mirrors the
 * verified AC-317 two-context mechanic (e2e/activity-dock.spec.ts).
 *
 * owner · desktop. Recorded by the `demo` project.
 */
import { test, expect } from '@playwright/test';
import { startDemo } from './demo-helpers';
import { STORAGE_STATES } from './storage-states';

test.use({ storageState: STORAGE_STATES.owner });
test.setTimeout(60_000);

test('03 — Live-Überblick', async ({ page, browser }) => {
  const demo = await startDemo(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await demo.scene({ name: 'Thomas Berger', role: 'Inhaber', device: 'Desktop' });

  const rows = page
    .getByTestId('activity-dock-panel')
    .locator('[data-testid^="activity-feed-row-"]');
  let beforeIds: (string | null)[] = [];

  await demo.step(
    'Der Aktivitäts-Dock – die ganze Firma auf einen Blick.',
    async () => {
      await demo.click(page.getByTestId('activity-dock-toggle'));
      await expect(page.getByTestId('activity-dock-panel')).toBeVisible();
      beforeIds = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    },
    { note: 'Live-Audit über SSE – jede Änderung, jeder Nutzer', holdMs: 1500 },
  );

  await demo.step(
    'Ein Kollege legt gerade ein Projekt an …',
    async () => {
      // A second, unrecorded session performs the mutation — the dock is
      // driven purely by the server's push, exactly as in production.
      const colleague = await browser.newContext({ storageState: STORAGE_STATES.office });
      try {
        const custRes = await colleague.request.get('/api/customers?limit=1');
        const body = (await custRes.json()) as { customers?: { id: string }[] };
        const customerId = (body.customers ?? (body as unknown as { id: string }[]))[0].id;
        const projRes = await colleague.request.post('/api/projects', {
          data: { number: '2026-100', title: 'Dachsanierung Koch', customerId },
        });
        expect(projRes.ok(), `project POST failed: ${projRes.status()}`).toBe(true);
      } finally {
        await colleague.close();
      }
    },
    { holdMs: 0 },
  );

  await demo.step(
    '… und es erscheint sofort – ganz ohne Aktualisieren.',
    async () => {
      await expect
        .poll(
          async () => {
            const ids = await rows.evaluateAll((els) =>
              els.map((e) => e.getAttribute('data-testid')),
            );
            return ids.some((id) => id !== null && !beforeIds.includes(id));
          },
          { timeout: 5_000 },
        )
        .toBe(true);
    },
    { note: 'kein Polling-Hack – serverseitige Push-Events (SSE)', settleMs: 300, holdMs: 3500 },
  );
});
