import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../src/config/strings';
import { STORAGE_STATES } from './storage-states';

/**
 * AC-450 — multi-user storage-usage invalidation over the SSE channel.
 *
 * Three actors on the same install: an office session (the
 * observer, with the Footer badge + DatenView row visible), a worker
 * session, and an owner-authenticated request. The worker uploads a
 * photo and hides it via Papierkorb; the owner restores it (Papierkorb
 * restore is owner / office only per the permission matrix in
 * `src/config/permissions.ts` — workers hold `attachment:hide` but NOT
 * `attachment:trash`, so the route preHandler 403s a worker restore
 * before the service runs, so the owner restores).
 *
 * Each mutation must propagate to the office session within 2 seconds
 * with NO manual refresh — driven by the `storage_usage_changed` event
 * over `/api/events` (api.md §14.2.13) and the shared storage-usage
 * subscription (its SSE refresh, `src/state/storageUsageStore.ts`).
 *
 * This is the value test the realtime channel exists to deliver — the
 * "always-open observer" gap that mount + `visibilitychange` +
 * post-mutation refresh alone leave open (ADR-0025). The `expect.poll()`
 * with a 2-second timeout is the contractual gate: a polling assertion
 * fails fast on success and surfaces a clean error on timeout, so a
 * regression to long-poll or a 30 s SSE reconnect would surface here as
 * a 2 s timeout failure rather than a silent slow path.
 *
 * Two long-lived browser contexts (office, worker) plus a one-shot
 * request context for the owner restore — the office tab does NOT
 * initiate any of the three mutations, so the SSE propagation is what
 * this test exercises end-to-end.
 *
 * Runs under `chromium-mutating` (multi-context attachment mutations
 * persist rows + bucket objects). The `MUTATING_TESTS` regex in
 * `playwright.config.ts` is updated to match this filename.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JPG_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.jpg');

/**
 * AC-450 budget — both Footer and DatenView mirror the same
 * subscription, so the same window applies to either surface.
 */
const SSE_PROPAGATION_TIMEOUT_MS = 2_000;

/**
 * Open the worker's project detail page via /kanban → first card →
 * Öffnen — matches the path `attachment-upload.spec.ts` walks the
 * worker through. The `-007` project is the worker's seeded assignment
 * (`src/server/seed/business.ts` ASSIGNMENT_SPECS) and is in `geplant`,
 * so the panel + Öffnen affordance are reachable. Returns the
 * `projectId` parsed from the card's testid for downstream API calls.
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
 * Snapshot the office session's storage-usage signal — the Footer badge
 * value plus the DatenView "Sichtbar" bucket. Returned together so the
 * propagation poll can assert on either surface using a single read.
 *
 * Both surfaces consume the same subscription (`src/state/storageUsageStore.ts`),
 * so they must change in lockstep; reading both rather than one pins the
 * shared-subscription contract end-to-end.
 */
interface StorageReadout {
  footer: string;
  datenSichtbar: string;
}

async function readStorageReadout(officePage: Page): Promise<StorageReadout> {
  const footer = await officePage
    .getByTestId('storage-usage-badge')
    .getByTestId('storage-usage-badge-value')
    .innerText();
  const datenSichtbar = await officePage
    .getByTestId('daten-storage-row')
    .getByTestId('daten-storage-row-sichtbar')
    .innerText();
  return { footer, datenSichtbar };
}

/**
 * Parse a formatBytes-rendered string ("0 B", "12 KB", "2,50 MB", "1,20 GB")
 * back to a byte count. The directional asserts below need numeric ordering;
 * a "value-changed" gate alone (T-ACBS) would let a regression that flips the
 * readout in the wrong direction pass the test.
 */
function parseBytes(displayed: string): number {
  const m = displayed.match(/(?:^|\s)(\d+(?:,\d{2})?) (B|KB|MB|GB)\b/);
  if (!m) throw new Error(`unparseable byte display: "${displayed}"`);
  const value = Number(m[1].replace(',', '.'));
  const unit = m[2];
  const multiplier =
    unit === 'B' ? 1 : unit === 'KB' ? 1024 : unit === 'MB' ? 1024 ** 2 : 1024 ** 3;
  return value * multiplier;
}

/**
 * Assert the office session's readout changes — both surfaces — within
 * the AC-450 propagation budget. The poll's 2 s timeout is the gate; a
 * passing implementation resolves on the first subscription tick after
 * the SSE frame lands.
 *
 * The previous (`before`) readout is snapshotted by the caller before
 * the mutation; we compare the live read to it and resolve when EITHER
 * surface diverges. The shared-subscription contract guarantees both
 * surfaces flip together; checking either as the trigger and the other
 * as a follow-up assertion would race the React commit cycle.
 */
async function expectOfficeReadoutChanges(
  officePage: Page,
  before: StorageReadout,
): Promise<StorageReadout> {
  await expect
    .poll(
      async () => {
        const now = await readStorageReadout(officePage);
        return now.footer !== before.footer || now.datenSichtbar !== before.datenSichtbar;
      },
      {
        message: 'office storage readout did not change within the AC-450 propagation budget',
        timeout: SSE_PROPAGATION_TIMEOUT_MS,
      },
    )
    .toBe(true);
  return readStorageReadout(officePage);
}

/**
 * Resolve the worker's just-uploaded attachment id by computing the
 * delta against a pre-upload snapshot of `data-testid` values inside
 * `container`. Mirrors `papierkorb.spec.ts`'s `waitForNewId` shape so
 * the hide / restore steps below can target the row deterministically
 * (the worker's project may carry stale rows from earlier mutating
 * specs in the same run).
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

test.describe('AC-450: storage usage propagates from worker mutations to office observer over SSE', () => {
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

  test('office observer sees worker upload + hide + cross-session restore reflected within 2s, no manual refresh', async ({
    browser,
  }) => {
    // The office observer parks on DatenView so both surfaces (Footer
    // badge in the chrome, storage row in the view) are visible
    // simultaneously. The whole point of AC-450 is "without a
    // reload" — every assertion below is allowed to consume only the
    // SSE-driven invalidation; no `goto`, `reload`, or visibility-change
    // after this initial mount.
    await officePage.goto('/daten');
    await expect(officePage.getByTestId('daten-view')).toBeVisible();
    await expect(officePage.getByTestId('storage-usage-badge')).toBeVisible();
    await expect(officePage.getByTestId('daten-storage-row')).toBeVisible();

    // Worker opens the project detail page in their own context. The
    // upload pipeline below mirrors `attachment-upload.spec.ts`.
    const projectId = await openWorkerProjectDetail(workerPage);

    // -- Upload (worker, UI) --------------------------------------------
    const beforeUpload = await readStorageReadout(officePage);

    const uploadCta = workerPage.getByTestId('project-detail-upload-cta');
    await expect(uploadCta).toBeVisible();
    const gallery = workerPage.getByTestId('project-detail-photos');
    const galleryBefore = await captureExistingIds(gallery, 'photo-thumb-');

    await uploadCta.getByTestId('attachment-photo-input').setInputFiles(JPG_FIXTURE);

    // The worker's upload-complete orchestrator (AttachmentService.completeUpload)
    // emits `storage_usage_changed`
    // post-commit (AC-270). The OFFICE session is the AC-450 gate — its
    // surfaces must reflect the change without a manual refresh.
    const attachmentId = await waitForNewId(gallery, 'photo-thumb-', galleryBefore);
    const afterUpload = await expectOfficeReadoutChanges(officePage, beforeUpload);
    // Directional invariant: upload moves bytes pending → ready, so the
    // visible (Sichtbar) total must INCREASE. A regression that fires the
    // refetch on the wrong project (or flips the wrong bucket) would
    // change the value but not in this direction.
    expect(parseBytes(afterUpload.footer)).toBeGreaterThan(parseBytes(beforeUpload.footer));
    expect(parseBytes(afterUpload.datenSichtbar)).toBeGreaterThan(
      parseBytes(beforeUpload.datenSichtbar),
    );

    // -- Hide (worker, UI grace-window self-delete) ---------------------
    // Worker holds `attachment:hide` and authored the row inside the
    // configured grace window — the row-level delete affordance is the
    // worker's UI path to the `hide` mutation. Same SSE event downstream
    // (AC-270 covers `hide` regardless of who triggers it).
    const beforeHide = afterUpload;

    const ourThumbItem = gallery
      .getByTestId('attachment-thumbnail')
      .filter({ has: workerPage.getByTestId(`photo-thumb-${attachmentId}`) });
    await ourThumbItem.getByTestId('attachment-delete').click();
    const confirm = workerPage.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(STRINGS.attachments.tabPapierkorb);
    await workerPage.getByTestId('confirm-ok').click();
    await expect(workerPage.getByTestId(`photo-thumb-${attachmentId}`)).toHaveCount(0);

    const afterHide = await expectOfficeReadoutChanges(officePage, beforeHide);
    // Hide moves bytes ready → hidden — the visible (Sichtbar) total
    // must DECREASE.
    expect(parseBytes(afterHide.footer)).toBeLessThan(parseBytes(beforeHide.footer));
    expect(parseBytes(afterHide.datenSichtbar)).toBeLessThan(parseBytes(beforeHide.datenSichtbar));

    // -- Restore (cross-session, owner request context) -----------------
    // Workers do not hold `attachment:trash` — the restore route 403s
    // them at the preHandler (see file-level permission note). To
    // preserve the AC-450 gate ("office session reflects the change
    // driven from another session"), the restore is issued from an
    // owner-authenticated request context. The OFFICE browser session
    // does not initiate the mutation; it must observe the resulting SSE
    // frame just as it did for the upload + hide steps above.
    const beforeRestore = afterHide;

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

    const afterRestore = await expectOfficeReadoutChanges(officePage, beforeRestore);
    // Restore moves bytes hidden → ready — the visible (Sichtbar) total
    // must INCREASE back.
    expect(parseBytes(afterRestore.footer)).toBeGreaterThan(parseBytes(beforeRestore.footer));
    expect(parseBytes(afterRestore.datenSichtbar)).toBeGreaterThan(
      parseBytes(beforeRestore.datenSichtbar),
    );
  });
});
