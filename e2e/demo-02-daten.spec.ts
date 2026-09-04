/**
 * Demo segment 02 — Daten (the heart of the operation). The one segment
 * whose subject has no UI: the backend guarantees that keep the business
 * data alive. We establish the live board (a day's worth of real data),
 * then blur it behind frosted glass and float the invisible engineering on
 * top — encryption at rest, provider-enforced immutability the app itself
 * cannot bypass, and multi-level backups that are tested, not hoped.
 *
 * Carries the project's core thesis: the app is treated as unreliable, so
 * it prepares for the worst in every domain — and thereby survives it.
 *
 * owner · desktop (1920×1080). Recorded by the `demo` project; the numeric
 * filename prefix fixes its position in the concatenated master.
 */
import { test, expect } from '@playwright/test';
import { startDemo } from './demo-helpers';
import { STORAGE_STATES } from './storage-states';

test.use({ storageState: STORAGE_STATES.owner });
test.setTimeout(60_000);

test('02 — Daten', async ({ page }) => {
  const demo = await startDemo(page);
  await page.goto('/');
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await demo.scene({ name: 'Thomas Berger', role: 'Inhaber', device: 'Desktop' });

  // Establish the live operation — the data the rest of the segment is
  // about — before it dissolves behind the glass.
  await demo.step(
    'Jeden Tag wächst Ihr Betrieb – und mit ihm Ihre Daten.',
    async () => {
      await expect(page.getByTestId('kanban-board')).toBeVisible();
    },
    { settleMs: 600, holdMs: 1600 },
  );

  await demo.revealFacts({
    title: 'Daten – das Herzstück des Betriebs',
    subtitle: 'Die App geht vom Schlimmsten aus – und sorgt vor.',
    facts: [
      {
        melody: 'Nichts verlässt die App im Klartext.',
        bassline: 'Anhänge Ende-zu-Ende verschlüsselt · AES-256-GCM · Schlüssel nie auf der Platte',
      },
      {
        melody: 'Was bleiben muss, löscht niemand – auch die App nicht.',
        bassline: 'WORM-Objektspeicher · Object-Lock providerseitig · App-Key ohne Löschrecht',
      },
      {
        melody: 'Ransomware, Absturz, Bedienfehler – einkalkuliert.',
        bassline:
          'mehrstufig & verschlüsselt · providerseitig gesperrt · mit App-Zugang nicht löschbar',
      },
      {
        melody: 'Sicherung automatisch – und automatisch erprobt.',
        bassline: 'DB-Dump mehrmals täglich · Restore-Drill gegen Echtdaten, nicht gegen Hoffnung',
      },
    ],
    close: 'Wir rechnen mit dem Ausfall. Darum hält Ihr Betrieb.',
  });
});
