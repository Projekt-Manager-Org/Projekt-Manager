import { test as setup } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../src/server/db/connection.js';
import { seed } from '../src/server/seed.js';
import { SEED_USERS } from '../src/test/seedAssumptions.js';
import { STORAGE_STATES } from './storage-states';
import { resetE2eBucket } from './storage-reset';
import { loginAndSaveState } from './auth-helpers';

/**
 * Auth setup — Playwright's shared-auth pattern, four roles.
 *
 * Logs in once per role (owner/office/worker/bookkeeper) and saves each
 * authenticated storage state to its own JSON file. Specs pick the role
 * they need via `test.use({ storageState: STORAGE_STATES.<role> })`.
 * Without this, per-test `loginAs` calls across the E2E specs burn
 * through the dev-mode login rate limit (30/min per IP,
 * `src/server/config/index.ts`) and the suite 429s itself around the
 * 30th login.
 *
 * The reseed (first setup test) runs before the logins so every run
 * starts from a known state. Playwright runs tests in a single file
 * serially, so the reseed → owner → office → worker → bookkeeper order
 * is preserved. The four login setups each use the `page` fixture,
 * which inherits the project's `use.baseURL`.
 *
 * The `.auth/` directory is gitignored — the JSON files contain session
 * tokens and are regenerated on every run.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_DIR = path.resolve(__dirname, '.auth');

try {
  process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
} catch {
  // .env missing — rely on existing environment.
}

setup('reseed database and storage', async () => {
  // Force-reseed so every Playwright run starts from a known state. The
  // TRUNCATE CASCADE invalidates any pre-existing sessions, which is
  // why this runs BEFORE the login setups below.
  //
  // Order matters: bucket reset FIRST, then DB seed. The seed's invoice
  // loader calls `InvoiceBinaryService.persistRendered`, which PUTs PDF
  // ciphertext to the bucket as part of issuance — wiping the bucket
  // afterwards would erase those just-uploaded objects, leaving DB rows
  // pointing at 404s. Bucket reset clears prior-run debris (DB-detached
  // orphans the reaper cannot reach since it only sweeps `pending` past
  // TTL); the seed then re-populates both DB and bucket atomically.
  await resetE2eBucket();

  // Runs migrations first so a fresh E2E database (created on-demand
  // for the isolated `projekt_manager_e2e` target — see
  // playwright.config.ts webServer) gets its schema before the seed's
  // TRUNCATE reaches for tables that would not yet exist. Drizzle
  // tracks applied migrations, so this is a no-op on subsequent runs.
  const migrationsFolder = path.resolve(__dirname, '..', 'src/server/db/migrations');
  const { db, pool } = createDatabase();
  try {
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    // Demo recordings only: seed a healthy backup status so the header
    // badge reads green. Dev/e2e otherwise show the "never-run" red state,
    // which would contradict the data-integrity coda. Gated on the demo
    // flag so normal e2e — including the backup-badge specs — keep seeing
    // the real default. The badge reads `meta_backup_status` directly
    // (repositories/backupStatus.ts § getBackupStatus).
    if (process.env.PLAYWRIGHT_RUN_DEMO) {
      await db.execute(sql`
        INSERT INTO meta_backup_status
          (singleton, last_backup_ok, last_backup_at, last_drill_ok, last_drill_at, last_error)
        VALUES (TRUE, TRUE, now() - interval '2 hours', TRUE, now() - interval '1 day', NULL)
        ON CONFLICT (singleton) DO UPDATE SET
          last_backup_ok = TRUE,
          last_backup_at = now() - interval '2 hours',
          last_drill_ok = TRUE,
          last_drill_at = now() - interval '1 day',
          last_error = NULL,
          updated_at = now()
      `);
    }
  } finally {
    await pool.end();
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
});

setup('authenticate owner', async ({ page }) => {
  await loginAndSaveState(page, SEED_USERS.owner, 'kanban-board', STORAGE_STATES.owner);
});

setup('authenticate office', async ({ page }) => {
  await loginAndSaveState(page, SEED_USERS.office, 'kanban-board', STORAGE_STATES.office);
});

setup('authenticate worker', async ({ page }) => {
  // Worker landing is now `/meine-projekte` (the personal list view).
  await loginAndSaveState(page, SEED_USERS.worker1, 'my-projects-view', STORAGE_STATES.worker);
});

setup('authenticate bookkeeper', async ({ page }) => {
  await loginAndSaveState(page, SEED_USERS.bookkeeper, 'invoice-list-view', STORAGE_STATES.bookkeeper);
});
