import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../src/config/strings';
import { STORAGE_STATES } from './storage-states';

/**
 * AC-337 — multi-user attachment invalidation over the SSE channel (#237).
 *
 * The gallery cross-user view-sync gap: before `attachment_changed`
 * existed and `attachmentStore` subscribed to it, an always-open gallery
 * never reflected another user's add / hide / restore. This is the value
 * test that the fix closes it.
 *
 * Three actors on the same install (mirrors AC-273's storage spec): an
 * office session (the observer, parked on the SAME project-detail page
 * with the photo gallery visible), a worker session that uploads then
 * hides a photo, and an owner-authenticated request context that restores
 * it (Papierkorb restore is owner / office only — workers hold
 * `attachment:hide` but not `attachment:trash`, so the restore route 403s
 * a worker before the service runs).
 *
 * Each mutation must propagate to the office gallery within 2 seconds with
 * NO manual refresh — driven by the `attachment_changed` event over
 * `/api/events` (api.md §14.2.13, AC-336) and `attachmentStore`'s SSE
 * refresh trigger (AC-337). The office tab mounts the project page once
 * and is never reloaded; the 2-second `toHaveCount` budget is the gate —
 * a regression to mount-only fetch (the original bug) leaves the count
 * unchanged and times out here.
 *
 * Runs under `chromium-mutating` (multi-context attachment mutations
 * persist rows + bucket objects); the filename is listed in the
 * `MUTATING_TESTS` regex in `playwright.config.ts`.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JPG_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.jpg');

/** AC-337 propagation budget — same 2 s window as the AC-273 storage spec. */
const SSE_PROPAGATION_TIMEOUT_MS = 2_000;

/**
 * Open the worker's assigned project detail page via /kanban → first
 * `geplant` card → Öffnen (the `-007` seeded assignment, reachable by the
 * worker). Returns the `projectId` parsed from the card testid so the
 * office observer can open the SAME project by URL. Mirrors
 * `storage-usage-multi-user.spec.ts`.
 */
async function openWorkerProjectDetail(page: Page): Promise<string> {
  await page.goto('/kanban');
  await expect(page.getByTestId('kanban-board')).toBeVisible();

  const geplantColumn = page.getByTestId('kanban-column-geplant');
  const assignedCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
  const cardTestId = await assignedCard.getAttribute('data-testid');
  const projectId = cardTestId!.replace('project-card-', '');
  await assignedCard.click();

  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('detail-open-page').click();

  await expect(page.getByTestId('project-detail-page')).toBeVisible();
  return projectId;
}

/**
 * Delta-capture the gallery's `photo-thumb-<id>` testids so the upload
 * step can resolve the just-created attachment id even when the project
 * carries stale rows from sibling mutating specs. Mirrors the
 * `waitForNewId` shape in `storage-usage-multi-user.spec.ts`.
 */
async function captureExistingIds(container: Locator, prefix: string): Promise<Set<string>> {
  const handles = await container.locator(`[data-testid^="${prefix}"]`).all();
  const ids = new Set<string>();
  for (const handle of handles) {
    const testId = await handle.getAttribute('data-testid');
    if (testId) ids.add(testId.slice(prefix.length));
  }
  return ids;
}

async function waitForNewId(
  container: Locator,
  prefix: string,
  before: Set<string>,
  timeout = 15_000,
): Promise<string> {
  let newId: string | null = null;
  await expect
    .poll(
      async () => {
        const handles = await container.locator(`[data-testid^="${prefix}"]`).all();
        for (const handle of handles) {
          const testId = await handle.getAttribute('data-testid');
          if (!testId) continue;
          const id = testId.slice(prefix.length);
          if (!before.has(id)) {
            newId = id;
            return true;
          }
        }
        return false;
      },
      {
        message: `expected a new ${prefix}<id> not present in baseline of ${before.size} ids`,
        timeout,
      },
    )
    .toBe(true);
  return newId!;
}

/**
 * Assert the office observer's gallery holds `expected` copies of a
 * specific attachment thumbnail within the AC-337 propagation budget —
 * 1 = present, 0 = gone. `toHaveCount` auto-retries against the live DOM
 * with NO navigation/reload, so a passing implementation resolves on the
 * first React commit after the `attachment_changed`-driven refetch lands.
 */
async function expectOfficeGalleryCount(
  officePage: Page,
  attachmentId: string,
  expected: number,
): Promise<void> {
  await expect(
    officePage.getByTestId('project-detail-photos').getByTestId(`photo-thumb-${attachmentId}`),
    `office gallery did not reach count=${expected} for ${attachmentId} within the AC-337 budget`,
  ).toHaveCount(expected, { timeout: SSE_PROPAGATION_TIMEOUT_MS });
}

test.describe('AC-337: attachment list changes propagate from worker mutations to office observer over SSE', () => {
  let officeContext: BrowserContext;
  let workerContext: BrowserContext;
  let officePage: Page;
  let workerPage: Page;

  test.beforeAll(async ({ browser }) => {
    officeContext = await browser.newContext({ storageState: STORAGE_STATES.office });
    workerContext = await browser.newContext({ storageState: STORAGE_STATES.worker });
    officePage = await officeContext.newPage();
    workerPage = await workerContext.newPage();
  });

  test.afterAll(async () => {
    await officeContext.close();
    await workerContext.close();
  });

  test('office observer sees worker upload + hide + cross-session restore in the gallery within 2s, no manual refresh', async ({
    browser,
  }) => {
    // Worker opens their assigned project detail page; the office observer
    // opens the SAME project by URL and parks there. After this initial
    // mount the office tab is never reloaded — every assertion below may
    // consume ONLY the SSE-driven invalidation.
    const projectId = await openWorkerProjectDetail(workerPage);

    await officePage.goto(`/projects/${projectId}`);
    await expect(officePage.getByTestId('project-detail-page')).toBeVisible();
    await expect(officePage.getByTestId('project-detail-photos')).toBeVisible();

    // -- Upload (worker, UI) --------------------------------------------
    const uploadCta = workerPage.getByTestId('project-detail-upload-cta');
    await expect(uploadCta).toBeVisible();
    const workerGallery = workerPage.getByTestId('project-detail-photos');
    const galleryBefore = await captureExistingIds(workerGallery, 'photo-thumb-');

    await uploadCta.getByTestId('attachment-photo-input').setInputFiles(JPG_FIXTURE);

    // Confirm the worker's upload pipeline committed (its thumb landed),
    // then assert the OFFICE gallery gains the same thumb over SSE — the
    // #237 gap was exactly this never happening.
    const attachmentId = await waitForNewId(workerGallery, 'photo-thumb-', galleryBefore);
    await expectOfficeGalleryCount(officePage, attachmentId, 1);

    // -- Hide (worker, grace-window self-delete) ------------------------
    const ourThumbItem = workerGallery
      .getByTestId('attachment-thumbnail')
      .filter({ has: workerPage.getByTestId(`photo-thumb-${attachmentId}`) });
    await ourThumbItem.getByTestId('attachment-delete').click();
    const confirm = workerPage.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(STRINGS.attachments.tabPapierkorb);
    await workerPage.getByTestId('confirm-ok').click();
    await expect(workerPage.getByTestId(`photo-thumb-${attachmentId}`)).toHaveCount(0);

    // The office gallery must drop the hidden row over SSE.
    await expectOfficeGalleryCount(officePage, attachmentId, 0);

    // -- Restore (cross-session, owner request context) -----------------
    // Workers cannot reach the restore route; issue it from an owner
    // request context. The office browser session does not initiate the
    // mutation — it must observe the resulting `attachment_changed` frame.
    const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      const restoreResp = await ownerContext.request.post(
        `/api/projects/${projectId}/attachments/${attachmentId}/restore`,
      );
      expect(
        restoreResp.ok(),
        `restore POST failed: ${restoreResp.status()} ${await restoreResp.text()}`,
      ).toBe(true);
    } finally {
      await ownerContext.close();
    }

    // The office gallery must regain the restored row over SSE.
    await expectOfficeGalleryCount(officePage, attachmentId, 1);
  });
});
