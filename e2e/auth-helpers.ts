import { expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../src/test/seedAssumptions.js';
import { STORAGE_STATES } from './storage-states';

/**
 * Shared auth helpers for the E2E suite.
 *
 * Lives in a plain module (not `auth.setup.ts`) because Playwright rejects
 * test-file → test-file imports — see the note in `storage-states.ts`. Both
 * `auth.setup.ts` (initial minting) and specs that destroy the shared
 * session (e.g. `daten-vollstaendiger-import.spec.ts`) import from here so
 * there is exactly one definition of "how a storage state is minted".
 */

/**
 * Chrome marks localhost cookies Secure (localhost is a "secure context"),
 * but Playwright won't send Secure cookies over plain HTTP when restoring
 * state into a fresh context. Strip the flag so the session cookie survives
 * the handoff into the next context that loads the saved state.
 */
function stripSecureFlag(statePath: string): void {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const cookie of state.cookies) cookie.secure = false;
  fs.writeFileSync(statePath, JSON.stringify(state));
}

/**
 * Log in as `user` through the UI and save the authenticated context to
 * `statePath`. The role-specific landing testid is the ready signal — see
 * `src/config/routes.ts` for the canonical per-role default: owner/office →
 * `/kanban` (`kanban-board`), worker → `/meine-projekte` (`my-projects-view`),
 * bookkeeper → `/rechnungen` (`invoice-list-view`).
 *
 * Used by `auth.setup.ts` to mint the initial states. It exercises the real
 * login form (and captures localStorage), so it doubles as a per-role login
 * smoke. The 15 s landing wait absorbs vite's cold-start cost on the first
 * navigation of a fresh `reuseExistingServer: false` server.
 */
export async function loginAndSaveState(
  page: Page,
  user: { username: string; displayName: string },
  landingTestId: 'kanban-board' | 'my-projects-view' | 'invoice-list-view',
  statePath: string,
): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(user.username);
  await page.getByTestId('login-password').fill(SEED_DEFAULT_PASSWORD);
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId(landingTestId)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('user-indicator')).toContainText(user.displayName);

  await page.context().storageState({ path: statePath });
  stripSecureFlag(statePath);
}

/** Every seed role paired with its storage-state path. */
const ROLE_STATES: ReadonlyArray<{ user: { username: string }; statePath: string }> = [
  { user: SEED_USERS.owner, statePath: STORAGE_STATES.owner },
  { user: SEED_USERS.office, statePath: STORAGE_STATES.office },
  { user: SEED_USERS.worker1, statePath: STORAGE_STATES.worker },
  { user: SEED_USERS.bookkeeper, statePath: STORAGE_STATES.bookkeeper },
];

/**
 * Re-mint every role's storage-state file via a direct API login.
 *
 * Needed after a destructive `POST /api/import?override=true` TRUNCATEs
 * `users`, cascading through `sessions.user_id` (AC-310) and killing EVERY
 * session — including the shared storageState cookies the rest of the serial
 * mutating bucket reuses. Without this, every mutating spec ordered after the
 * destructive one lands on the login screen. The override-import re-inserts
 * users with identical credentials (passwordHash round-trips through the
 * envelope, issue #230), so the seed password logs in again.
 *
 * Uses the API endpoint rather than the UI form on purpose: four UI logins
 * (each up to a 15 s landing wait) blow the 30 s `afterAll` hook budget,
 * whereas the login round-trip is sub-second. The session `Set-Cookie` lands
 * in the context's cookie jar, which `storageState()` then serialises — same
 * artifact the UI path produces, minus the (default-anyway) theme localStorage.
 */
export async function reseedAllStorageStates(browser: Browser): Promise<void> {
  for (const { user, statePath } of ROLE_STATES) {
    const context = await browser.newContext();
    try {
      const res = await context.request.post('/api/auth/login', {
        data: { username: user.username, password: SEED_DEFAULT_PASSWORD },
      });
      if (!res.ok()) {
        throw new Error(
          `reseedAllStorageStates: login failed for ${user.username} — ` +
            `${res.status()} ${await res.text()}`,
        );
      }
      await context.storageState({ path: statePath });
      stripSecureFlag(statePath);
    } finally {
      await context.close();
    }
  }
}
