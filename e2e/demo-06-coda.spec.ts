/**
 * Demo segment 06 — Vertrauen (the coda). Two closing proofs that the
 * data is safe: the green backup badge (automatic, write-once storage)
 * and the one-click full export (your data is yours). The thesis title
 * card is appended by the master encode.
 *
 * owner · desktop. Recorded by the `demo` project. The green badge depends
 * on the demo-gated backup-status seed in e2e/auth.setup.ts.
 */
import { test, expect } from '@playwright/test';
import { startDemo } from './demo-helpers';
import { STORAGE_STATES } from './storage-states';
import { clickView } from './nav-helpers';

test.use({ storageState: STORAGE_STATES.owner });
test.setTimeout(60_000);

test('06 — Vertrauen', async ({ page }) => {
  const demo = await startDemo(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await demo.scene({ name: 'Thomas Berger', role: 'Inhaber', device: 'Desktop' });

  await demo.step(
    'Automatische Sicherung – mehrmals täglich.',
    async () => {
      // A click surfaces the status as a toast (BackupBadge.handleClick) —
      // it reads on camera where the native `title` tooltip does not.
      await demo.click(page.getByTestId('backup-badge'));
    },
    {
      note: 'verschlüsselte Off-Site-Backups · providerseitig gesperrt · auch bei App-Ausfall wiederherstellbar',
      settleMs: 800,
      holdMs: 3200,
    },
  );

  await demo.step(
    'Und alles gehört Ihnen.',
    async () => {
      await clickView(page, 'daten');
      await expect(page.getByTestId('daten-view')).toBeVisible();
    },
    { holdMs: 800 },
  );

  await demo.step(
    'Ein Klick exportiert den ganzen Betrieb.',
    async () => {
      await demo.click(page.getByTestId('data-export-button'));
    },
    {
      note: 'vollständiger Datenexport – alle Daten + Anhänge, jederzeit importierbar',
      settleMs: 700,
      holdMs: 3500,
    },
  );
});
