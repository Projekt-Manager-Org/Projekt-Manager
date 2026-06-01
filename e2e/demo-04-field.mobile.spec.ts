/**
 * Demo segment 04 — Im Einsatz (field worker, mobile). The worker opens
 * their own jobs on the phone and uploads a photo straight from the site.
 * Shows RBAC by absence (only their projects — no board, no dock, no admin)
 * and data captured in the field. The phone clip is composited onto a
 * jobsite backdrop by the master encode.
 *
 * worker · mobile (Pixel 7). Recorded by the `demo-mobile` project only
 * (filename carries the `.mobile` infix).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { startDemo } from './demo-helpers';
import { STORAGE_STATES } from './storage-states';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_PHOTO = path.resolve(__dirname, 'fixtures', 'demo', 'site-1.jpg');

test.use({ storageState: STORAGE_STATES.worker });
test.setTimeout(60_000);

test('04 — Im Einsatz', async ({ page }) => {
  const demo = await startDemo(page);
  await page.goto('/');
  await expect(page.getByTestId('my-projects-view')).toBeVisible();
  await demo.scene({ name: 'Jan Nowak', role: 'Mitarbeiter', device: 'Handy' });

  await demo.step(
    'Unterwegs: nur die eigenen Einsätze.',
    async () => {
      await expect(page.getByTestId('my-projects-view')).toBeVisible();
    },
    { note: 'rollenbasiert – serverseitig erzwungen, nicht nur ausgeblendet', settleMs: 1000, holdMs: 1800 },
  );

  await demo.step('Ein Projekt antippen – alle Details dabei.', async () => {
    await demo.click(page.locator('[data-testid^="my-project-row-"]').first());
    await expect(page.getByTestId('project-detail-page')).toBeVisible();
  });

  await demo.step('Ein Foto vom Einsatzort – direkt vom Handy.', async () => {
    const cta = page.getByTestId('project-detail-upload-cta');
    await expect(cta).toBeVisible();
    // The file input itself is hidden; glide to the CTA, then attach.
    await demo.moveTo(cta);
    await cta.getByTestId('attachment-photo-input').setInputFiles(SITE_PHOTO);
  });

  await demo.step(
    'Verschlüsselt gespeichert, sofort sichtbar.',
    async () => {
      const thumb = page
        .getByTestId('project-detail-photos')
        .getByTestId('attachment-thumbnail')
        .first();
      await expect(thumb).toBeVisible({ timeout: 20_000 });
    },
    { note: 'pro Datei AES-256-GCM – Schlüssel nie im Klartext', holdMs: 3500 },
  );
});
