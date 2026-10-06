import { test, expect, type Locator } from '@playwright/test';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../src/server/db/connection.js';
import { INVOICE_BACKUP_WATCH_INTERVAL_MS } from '../src/config/invoiceBackupWatch.js';
import { STORAGE_STATES } from './storage-states';

/**
 * E2E — backup-pending invoice surfaces (AC-376 [vis], ui/invoices.md
 * §8.16.6).
 *
 * A backup-pending invoice withholds its PDF on every surface that
 * offers the download — list row, per-invoice viewer, per-project block:
 * the affordance renders disabled with the `Wird gesichert…` label and
 * its tooltip, and the list row's export checkbox is disabled too.
 * Releasing the mark (what a successful backup run does, AC-373) enables
 * the download within 15 seconds, without a reload — the app observes
 * the release and emits `invoice_changed` (architecture.md §11.13).
 *
 * The E2E backend runs with the backup feature disabled, so issuance
 * never marks a row here. Withholding and the release watch follow the
 * marks alone (architecture.md §11.14), so the spec writes and deletes
 * the mark directly on the E2E database — exactly the row the issuance
 * and the backup service would write and delete.
 *
 * Structural assertions only (project convention for `[vis]` ACs); the
 * visual judgement is the UI-mode review.
 */

test.use({ storageState: STORAGE_STATES.owner });
test.describe.configure({ mode: 'serial' });

const LABEL = 'Wird gesichert…';
const TOOLTIP =
  'Die Rechnung wird zuerst extern gesichert, damit sie bei einem Systemausfall nicht verloren geht. Das PDF steht in der Regel nach wenigen Minuten bereit.';

async function expectWithheld(button: Locator): Promise<void> {
  await expect(button).toBeDisabled();
  await expect(button).toHaveText(LABEL);
  await expect(button).toHaveAttribute('title', TOOLTIP);
}

test.describe('Backup-pending invoice (AC-376)', () => {
  let db: ReturnType<typeof createDatabase>['db'];
  let pool: ReturnType<typeof createDatabase>['pool'];
  let invoiceId: string;
  let projectId: string;
  let markedAt: number;

  test.beforeAll(async () => {
    ({ db, pool } = createDatabase());
    const r = await db.execute<{ id: string; project_id: string }>(
      sql`SELECT id, project_id FROM invoices
          WHERE status = 'issued' AND cancellation_of IS NULL
          ORDER BY id LIMIT 1`,
    );
    const row = r.rows[0];
    if (!row) throw new Error('E2E seed carries no issued invoice');
    invoiceId = row.id;
    projectId = row.project_id;
    await db.execute(sql`DELETE FROM invoice_backup_pending WHERE invoice_id = ${invoiceId}`);
    await db.execute(sql`INSERT INTO invoice_backup_pending (invoice_id) VALUES (${invoiceId})`);
    markedAt = Date.now();
  });

  test.afterAll(async () => {
    await db.execute(sql`DELETE FROM invoice_backup_pending WHERE invoice_id = ${invoiceId}`);
    await pool.end();
  });

  test('list row: download and export checkbox are withheld', async ({ page }) => {
    await page.goto(`/rechnungen?projectId=${projectId}`);
    const row = page.getByTestId(`invoice-row-${invoiceId}`);
    await expectWithheld(row.getByTestId('invoice-download-pdf'));
    const checkbox = row.getByTestId('invoice-select');
    await expect(checkbox).toBeDisabled();
    await expect(checkbox).toHaveAttribute('title', TOOLTIP);
  });

  test('per-invoice viewer: download is withheld', async ({ page }) => {
    await page.goto(`/rechnungen/${invoiceId}`);
    await expectWithheld(page.getByTestId('invoice-detail-download-pdf'));
  });

  test('per-project block: download is withheld, then enabled on release without a reload', async ({
    page,
  }) => {
    // One watcher interval with the mark standing, then up to 15 s for the release.
    test.setTimeout(INVOICE_BACKUP_WATCH_INTERVAL_MS + 30_000);
    await page.goto(`/projects/${projectId}`);
    const button = page
      .getByTestId('project-invoice-section')
      .getByTestId(`invoice-row-${invoiceId}`)
      .getByTestId('invoice-download-pdf');
    await expectWithheld(button);

    // The watcher emits only for a mark it has seen on an earlier sweep,
    // so give it one full interval with the mark standing first.
    const seen = markedAt + INVOICE_BACKUP_WATCH_INTERVAL_MS + 1_000 - Date.now();
    if (seen > 0) await page.waitForTimeout(seen);
    await db.execute(sql`DELETE FROM invoice_backup_pending WHERE invoice_id = ${invoiceId}`);

    await expect(button).toBeEnabled({ timeout: 15_000 });
    await expect(button).not.toHaveText(LABEL);
    await expect(button).not.toHaveAttribute('title', TOOLTIP);
  });
});
