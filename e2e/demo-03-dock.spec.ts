/**
 * Demo segment 03 — Live-Überblick (the activity dock). The owner leaves
 * the dock open on the board; a field worker (a second, unrecorded
 * session) uploads a site photo, and the `Datei hinzugefügt` row appears
 * in the owner's dock live — no refresh. This is the field→office moment
 * that today goes through Dropbox + a WhatsApp to the office; here it just
 * shows up. The killer feature: the whole company, in real time. Mirrors
 * the verified AC-317 two-context mechanic (e2e/activity-dock.spec.ts).
 *
 * owner · desktop. Recorded by the `demo` project.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { startDemo } from './demo-helpers';
import { STORAGE_STATES } from './storage-states';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A different site photo than the field segment (04) uploads, so the two
// uploads stay visually distinct in the stitched film.
const SITE_PHOTO = path.resolve(__dirname, 'fixtures', 'demo', 'site-2.jpg');

test.use({ storageState: STORAGE_STATES.owner });
test.setTimeout(60_000);

test('03 — Live-Überblick', async ({ page, browser }) => {
  const demo = await startDemo(page);
  await page.goto('/');
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await demo.scene({ name: 'Thomas Berger', role: 'Inhaber', device: 'Desktop' });

  const rows = page
    .getByTestId('activity-dock-panel')
    .locator('[data-testid^="activity-feed-row-"]');
  let beforeIds: (string | null)[] = [];

  await demo.step(
    'Alle Aktivitäten – die ganze Firma auf einen Blick.',
    async () => {
      await demo.click(page.getByTestId('activity-dock-toggle'));
      await expect(page.getByTestId('activity-dock-panel')).toBeVisible();
      beforeIds = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    },
    { note: 'Live-Audit über SSE – jede Änderung, jeder Nutzer', holdMs: 1500 },
  );

  await demo.step(
    'Ein Mitarbeiter lädt ein Foto von der Baustelle hoch …',
    async () => {
      // A second, unrecorded WORKER session uploads a site photo through the
      // real (browser-side encrypted) attachment pipeline — the dock is
      // driven purely by the server's `audit_changed` push, exactly as in
      // production. Targets the worker's SECOND assigned project (`.nth(1)`)
      // so it does NOT touch the project the field segment (04) records
      // against (`.first()`): MyProjectsView sorts by plannedStart, which an
      // upload never changes, so the two positions stay stable + distinct.
      const worker = await browser.newContext({
        storageState: STORAGE_STATES.worker,
        baseURL: new URL(page.url()).origin,
      });
      try {
        const wPage = await worker.newPage();
        await wPage.goto('/');
        await expect(wPage.getByTestId('my-projects-view')).toBeVisible();
        await wPage.locator('[data-testid^="my-project-row-"]').nth(1).click();
        await expect(wPage.getByTestId('project-detail-page')).toBeVisible();
        await wPage
          .getByTestId('project-detail-upload-cta')
          .getByTestId('attachment-photo-input')
          .setInputFiles(SITE_PHOTO);
        // Wait until the upload actually lands (thumbnail rendered) so the
        // `attachment:add` audit event has fired before we assert the dock.
        await expect(
          wPage.getByTestId('project-detail-photos').getByTestId('attachment-thumbnail').first(),
        ).toBeVisible({ timeout: 20_000 });
      } finally {
        await worker.close();
      }
    },
    { holdMs: 0 },
  );

  await demo.step(
    '… und es ist im selben Moment im Büro – ohne Umweg, ohne Nachfragen.',
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
    { note: 'serverseitige Push-Events (SSE) – kein Neuladen', settleMs: 300, holdMs: 3500 },
  );
});
