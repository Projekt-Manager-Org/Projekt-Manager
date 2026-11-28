import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { STORAGE_STATES } from './storage-states';

/**
 * Happy-path attachment upload — worker on an assigned project opens
 * the project detail page via the quick-glance panel's `Öffnen`
 * affordance, uploads one photo and one PDF, then confirms the gallery
 * and binary list render each attachment. The PDF download is exercised
 * via the `Herunterladen` action.
 *
 * Runs under `chromium-mutating` because the upload flow persists
 * `attachment` rows plus backing objects in MinIO — a parallel reader
 * of the same project would observe those rows mid-flight.
 *
 * Worker `arbeiter1` (Jan Nowak) is assigned to project suffix `-007`
 * per `src/server/seed/business.ts` (ASSIGNMENT_SPECS). The project is
 * in `geplant`, so the worker can open the quick-glance panel, hit the
 * `Öffnen` affordance, and land on `/projects/:id`.
 *
 * Fixture bytes live under `e2e/fixtures/` — a ~28 KB 3840×2160 JPEG
 * with EXIF (including synthetic GPS) and a 594-byte PDF. The JPEG is
 * sized so the client-side resize branch is exercised end-to-end
 * (longest edge > `imageMaxDimension`), while staying well under the
 * 1 MB per-file cap (architecture.md §12.2) so the upload itself cannot
 * trip the size validation gate.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JPG_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.jpg');
const PDF_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.pdf');

test.use({ storageState: STORAGE_STATES.worker });

/**
 * Open the Kanban quick-glance panel for the `-007` project (worker is
 * assigned), hit `Öffnen`, and wait for the project detail page to
 * render. Centralized here because both the gallery and binary flows
 * start from the same navigation sequence.
 *
 * Worker landing is now `/meine-projekte` (the personal list). The
 * upload-from-kanban flow this helper exercises still exists, so we
 * navigate to /kanban explicitly rather than chasing the landing.
 */
async function openProjectDetailViaPanel(page: Page): Promise<string> {
  await page.goto('/kanban');
  await expect(page.getByTestId('kanban-board')).toBeVisible();

  // Pick the -007 geplant card (assigned to arbeiter1 per seed data).
  const geplantColumn = page.getByTestId('kanban-column-geplant');
  const assignedCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
  await assignedCard.click();

  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();

  const cardTestId = await assignedCard.getAttribute('data-testid');
  const projectId = cardTestId!.replace('project-card-', '');

  // The `Öffnen` affordance is present whenever the panel is and
  // navigates to /projects/:id. Testid shared with the component-level
  // panel test (`ProjectDetailPanel.test.tsx`) so the same affordance
  // satisfies both layers.
  const openAffordance = panel.getByTestId('detail-open-page');
  await expect(openAffordance).toBeVisible();
  await openAffordance.click();

  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}(?:\\?|$)`));
  await expect(page.getByTestId('project-detail-page')).toBeVisible();

  return projectId;
}

test.describe('Attachment happy-path upload (worker on assigned project)', () => {
  test('AC-397 / AC-416: photo upload renders a decoded thumbnail (SW decrypt path)', async ({
    page,
  }) => {
    // AC-416 (verification.md §15.26) — the Service Worker installed by
    // the SPA intercepts `/encrypted-storage/<projectId>/<attachmentId>.<variant>`,
    // calls `download-url` for the wrapped DEK material, fetches the
    // ciphertext from object storage, AES-256-GCM-decrypts, and returns
    // plaintext through the Fetch response. This E2E covers the
    // visible-render outcome: a successful `<img>`
    // decode is the only browser-observable signal that the SW returned
    // correctly-decrypted plaintext bytes (a decrypt failure would
    // surface as a broken-image fallback — `naturalWidth === 0`).
    //
    // The SW intercept itself cannot be asserted from the test page —
    // Playwright's page-side `route` API runs in the page's network
    // stack, not the SW's. The SW unit test (`src/sw/__tests__/sw-decrypt.test.ts`,
    // AC-416) carries the
    // intercept-and-decrypt contract; this test pins the user-visible
    // outcome that proves the path worked end-to-end.
    await openProjectDetailViaPanel(page);

    // Upload surface is gated on `attachment:write`; worker holds it per
    // the default matrix. `project-detail-upload-cta` is the section
    // wrapper. The `Foto aufnehmen` CTA (ui/project-detail.md §8.15.4)
    // plus a drag-drop zone live inside it; either entry point lands in
    // the same presigned-POST init flow.
    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await expect(uploadCta).toBeVisible();

    // Drag-drop zones expose a hidden file input for Playwright to
    // target directly — matches the pattern used elsewhere in the suite
    // (e.g. data-exchange.spec.ts for the import file input).
    const photoInput = uploadCta.getByTestId('attachment-photo-input');
    await photoInput.setInputFiles(JPG_FIXTURE);

    // After init → POST to storage → complete resolves, the gallery row
    // flips from "uploading" to a thumbnail rendered through the
    // synthetic-origin SW path (ui/project-detail.md §8.15.4, AC-409).
    const gallery = page.getByTestId('project-detail-photos');
    const thumb = gallery.getByTestId('attachment-thumbnail').first();
    await expect(thumb).toBeVisible({ timeout: 15_000 });

    // AC-416 assertion: the `<img>` decoded successfully. `naturalWidth`
    // is non-zero only when the browser successfully decoded the bytes
    // returned through the synthetic origin — for ciphertext that means
    // the SW must have decrypted correctly. A decrypt failure (wrong
    // DEK, wrong nonce, GCM tag mismatch) returns garbage to `<img>`,
    // which fires `error` and leaves `naturalWidth === 0`.
    //
    // `expect.poll` handles the SW-fetch + decode latency without a
    // hardcoded sleep. The img is already rendered (visibility above);
    // we are waiting for the network round-trip + decrypt + decode.
    const img = thumb.locator('img').first();
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
  });

  test('PDF upload renders in the binary list and can be downloaded', async ({ page }) => {
    await openProjectDetailViaPanel(page);

    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await expect(uploadCta).toBeVisible();

    const binaryInput = uploadCta.getByTestId('attachment-binary-input');
    await binaryInput.setInputFiles(PDF_FIXTURE);

    // The PDF lands in the binary list with filename, label, uploader,
    // timestamp, and a download action (ui/project-detail.md §8.15.5).
    const binaryList = page.getByTestId('project-detail-binaries');
    // Each row has `data-testid="attachment-binary-row-<id>"`, so
    // `getByTestId('attachment-binary-row')` would require an exact
    // match and never hit. Use a CSS prefix selector and filter by
    // the filename text. `.first()` tolerates leftover sample.pdf
    // rows from earlier runs in the same mutating-test file — the
    // describe block's TRUNCATE only runs once at auth-setup time,
    // so upload fixtures accumulate within a single Playwright run.
    const pdfRow = binaryList
      .locator('[data-testid^="attachment-binary-row-"]')
      .filter({ hasText: 'sample.pdf' })
      .first();
    await expect(pdfRow).toBeVisible({ timeout: 15_000 });

    // Exercise the download action — pin that the browser actually
    // receives the file, not just that the action renders. Download is
    // the browser-level observable and `waitForEvent('download')` is
    // Playwright's native hook for it.
    const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
    await pdfRow.getByTestId('attachment-download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('sample.pdf');
  });

  test('worker can delete their own photo within the grace window', async ({ page }) => {
    // The worker who authored the attachment may delete it within the
    // configured self-delete grace window (default 15 min). The click
    // path goes through the row-level delete affordance + a Yes/No
    // confirmation dialog (ui/project-detail.md §8.15.6).
    await openProjectDetailViaPanel(page);

    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await uploadCta.getByTestId('attachment-photo-input').setInputFiles(JPG_FIXTURE);

    const gallery = page.getByTestId('project-detail-photos');
    const thumb = gallery.getByTestId('attachment-thumbnail').first();
    await expect(thumb).toBeVisible({ timeout: 15_000 });

    // Row-level delete affordance — only rendered for the caller who
    // authored the row, within the grace window.
    const deleteButton = thumb.getByTestId('attachment-delete');
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    // Confirmation dialog — generic `confirm-dialog` testid matches the
    // pattern used by the transition + archive flows.
    const confirmDialog = page.getByTestId('confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await page.getByTestId('confirm-ok').click();

    await expect(thumb).toHaveCount(0);
  });
});

test.describe('AC-404: Attachment upload preserves EXIF / GPS through the pipeline', () => {
  test('photo lightbox blob retains the source APP1 segment and Make tag', async ({ page }) => {
    // Regression guard for #126. The previous library
    // (`browser-image-compression@2.0.2`) had an EXIF copier that
    // rejected JPEGs whose Orientation tag was encoded as LONG; our
    // fallback dropped the entire APP1 segment, breaking the worker-
    // view promise that GPS survives the upload pipeline. The
    // replacement (`@uploadcare/image-shrink`) byte-splices APP1
    // back into the re-encoded blob — this test pins that guarantee
    // end-to-end against a real upload + presigned GET.
    //
    // The fixture's APP1 segment contains an EXIF magic ("Exif\\0\\0"),
    // a Make tag with the ASCII bytes "vitest-fixture", and a GPSIFD
    // pointer (tag 0x8825). Asserting both magic + Make in the served
    // bytes proves the segment survived re-encode byte-for-byte; if a
    // future regression strips EXIF, both checks fail together.
    await openProjectDetailViaPanel(page);

    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await uploadCta.getByTestId('attachment-photo-input').setInputFiles(JPG_FIXTURE);

    const gallery = page.getByTestId('project-detail-photos');
    const thumb = gallery.getByTestId('attachment-thumbnail').first();
    await expect(thumb).toBeVisible({ timeout: 15_000 });

    // Open the lightbox — that's the only surface that loads the
    // original (full-EXIF) blob; the gallery tile is a stripped WebP
    // thumbnail by design.
    await thumb.locator('button').first().click();
    const lightbox = page.getByTestId('photo-lightbox');
    await expect(lightbox).toBeVisible();
    const originalUrl = await lightbox.locator('img').getAttribute('src');
    expect(originalUrl).toBeTruthy();

    // Fetch the bytes the worker would see. Under ADR-0024 the lightbox
    // `<img src>` is a synthetic same-origin URL (`/encrypted-storage/...`)
    // intercepted by the in-page Service Worker, which fetches the
    // ciphertext from B2 and decrypts it before handing plaintext back to
    // the page. Playwright's `request` context bypasses the SW entirely,
    // so it would either 404 or see ciphertext. The fetch must therefore
    // happen inside the page context — that's the only seam where the
    // SW decrypt path runs end-to-end.
    const bytes = await page.evaluate(async (url: string) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, originalUrl!);
    const body = Buffer.from(bytes);
    // EXIF magic — the 6-byte "Exif\\0\\0" header at the start of any
    // APP1/EXIF segment. Present in the fixture; must survive re-encode.
    expect(body.includes(Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]))).toBe(true);
    // The fixture's Make tag — a recognisable ASCII string inside the
    // APP1 segment. Surviving the re-encode proves the segment was
    // copied verbatim, not just that some EXIF magic exists somewhere.
    expect(body.includes(Buffer.from('vitest-fixture', 'ascii'))).toBe(true);

    // Dimension regression guard. `@uploadcare/image-shrink`'s `size`
    // setting is a target *pixel area*, not a longest-edge dimension —
    // a previous build passed `imageMaxDimension` (2560) directly,
    // which the library interpreted as ~50×40 pixels and shipped
    // unusable thumbnails as the "original". The fixture is 3840×2160
    // (16:9), so the re-encoded longest edge should land near
    // imageMaxDimension. Assert it's at least half — anything below
    // means the area/edge confusion regressed. Decoding via the page's
    // own Image constructor avoids pulling a Node JPEG decoder into
    // the e2e bundle.
    const dims = await page.evaluate(async (url: string) => {
      const blob = await fetch(url).then((r) => r.blob());
      const objectUrl = URL.createObjectURL(blob);
      try {
        return await new Promise<{ width: number; height: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error('decode failed'));
          img.src = objectUrl;
        });
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }, originalUrl!);
    const longest = Math.max(dims.width, dims.height);
    // Floor rather than equality — the library's sqrt-based rounding
    // can shave a pixel or two off the configured edge. 1280 is the
    // half-baseEdge floor; anything below means the size parameter is
    // being misinterpreted as an area again (~58×43 for a 4:3 photo).
    expect(longest).toBeGreaterThanOrEqual(1280);
  });
});

test.describe('Attachment bulk-fetch + browser-side streaming zip', () => {
  test('AC-433, AC-434: Auswahl als ZIP bulk-fetches per-file payloads and downloads one archive with distinct entry names', async ({
    page,
  }) => {
    // AC-433 (verification.md §15.26) — `Auswahl als ZIP` calls
    // `POST /api/projects/:id/attachments/bulk-fetch`,
    // receives one entry per requested attachment with per-file presigned
    // GET URL + unwrapped DEK material, and the browser assembles a
    // streaming zip locally so the user sees a single download.
    //
    // AC-434 — both uploads are `sample.pdf`, so the archive must rename
    // one. Only entry names are asserted: the renaming scheme and entry
    // order are implementation-defined, and payload assembly is pinned
    // by `attachmentStore.test.ts` (`requestBulkZipBlob`).
    await openProjectDetailViaPanel(page);

    // Upload two PDFs so bulk-selection is meaningful. Re-uses the
    // fixture; the binary list filters by `kind = 'binary'` so prior
    // uploads from earlier tests in the same run also count, but
    // explicitly uploading two here keeps the test self-contained and
    // avoids ordering dependencies on the other tests in this file.
    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await expect(uploadCta).toBeVisible();
    const binaryInput = uploadCta.getByTestId('attachment-binary-input');
    await binaryInput.setInputFiles(PDF_FIXTURE);
    await binaryInput.setInputFiles(PDF_FIXTURE);

    const binaryList = page.getByTestId('project-detail-binaries');
    // Wait until at least two PDF rows are present. The list is
    // re-queried on each upload's complete, so this can take a couple
    // of round trips — same 15 s budget as the single-file test.
    await expect
      .poll(
        async () =>
          binaryList
            .locator('[data-testid^="attachment-binary-row-"]')
            .filter({ hasText: 'sample.pdf' })
            .count(),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(2);

    // Select via the "select all" header checkbox — the per-row
    // checkboxes have ids tied to attachment IDs, but selectAll covers
    // every selectable row regardless of count.
    await binaryList.getByTestId('binary-select-all').check();

    // Capture the bulk-fetch network round trip. The waiter is set up
    // BEFORE the click so the fulfillment race is impossible.
    const bulkFetchPromise = page.waitForResponse(
      (resp) =>
        /\/api\/projects\/[^/]+\/attachments\/bulk-fetch$/.test(resp.url()) &&
        resp.request().method() === 'POST',
      { timeout: 10_000 },
    );
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });

    await binaryList.getByTestId('binary-bulk-download').click();

    // 1. The wire endpoint is `bulk-fetch`, not the retired `bulk-download`
    //    (the route was rewritten as part of ADR-0024).
    const bulkFetchResponse = await bulkFetchPromise;
    expect(bulkFetchResponse.ok()).toBe(true);

    // 2. Response is `{ data: BulkFetchEntry[] }` with
    //    per-file payloads `{ attachmentId, originalUrl, originalDekMaterial,
    //    ciphertextSizeBytes, thumbUrl?, thumbDekMaterial?, ciphertextThumbSizeBytes? }`.
    //    ≥ 2 entries given two selected rows.
    const body = (await bulkFetchResponse.json()) as {
      data: Array<{ attachmentId: string; originalUrl: string; originalDekMaterial: string }>;
    };
    const entries = body.data;
    expect(Array.isArray(entries), 'bulk-fetch returns { data: BulkFetchEntry[] }').toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(entry.attachmentId, 'each entry carries the attachmentId').toBeTruthy();
      expect(entry.originalUrl, 'each entry carries a presigned-GET URL').toBeTruthy();
      expect(
        entry.originalDekMaterial,
        'each entry carries the unwrapped DEK material (base64)',
      ).toBeTruthy();
    }

    // 3. A user-visible download fires after the streaming zip is
    //    assembled. The browser sees one download — the zip — even
    //    though the SW pulled multiple ciphertext objects under the
    //    hood.
    const download = await downloadPromise;
    expect(download.suggestedFilename().endsWith('.zip')).toBe(true);

    // 4. One archive entry per selected file, no two names equal
    //    ignoring case (AC-434). `filter` sees every entry; the
    //    returned map would collapse duplicates.
    const downloadPath = await download.path();
    const entryNames: string[] = [];
    unzipSync(fs.readFileSync(downloadPath), {
      filter: (file) => {
        entryNames.push(file.name);
        return false;
      },
    });
    expect(entryNames.length).toBe(entries.length);
    expect(new Set(entryNames.map((name) => name.toLowerCase())).size).toBe(entryNames.length);
  });
});

test.describe('Attachment placeholder for unwrappable wrapped envelope', () => {
  test('AC-244: download-url DEK_UNWRAP_FAILED renders "Schlüssel nicht verfügbar" and disables download', async ({
    page,
  }) => {
    // AC-244 (verification.md §15.26) —
    // a `status = 'ready'` row whose wrapped envelope cannot be
    // unwrapped at render time renders the German label
    // `"Schlüssel nicht verfügbar"` and disables the download action.
    // Trigger is a 422 `DEK_UNWRAP_FAILED` from `download-url`
    // (docs/api/README.md § Error Codes).
    //
    // Detection is lazy: the SW issues the
    // `download-url` call and surfaces the unwrap error to the UI on
    // the in-flight fetch. For binaries that means the click on
    // `attachment-download` triggers the lazy probe; this test mocks
    // the API endpoint upstream of the SW so the SW (or the direct-
    // fetch fallback path during pre-SW implementation steps) sees the
    // 422 and the row flips to the placeholder.
    //
    // Mirrors AC-244's component-level coverage in `PhotoGallery.test.tsx`
    // and `BinaryList.test.tsx`; pinned
    // here end-to-end so the German string + disabled-button contract
    // survives across the wire path, not just inside the component
    // unit boundary.
    await openProjectDetailViaPanel(page);

    // Upload a single binary so we have a row to address. Uses the
    // PDF fixture — the binary path is the cleanest for "download
    // disabled" because the row carries an explicit
    // `attachment-download` button (the photo gallery exposes a
    // lightbox click, not a download button).
    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await expect(uploadCta).toBeVisible();
    await uploadCta.getByTestId('attachment-binary-input').setInputFiles(PDF_FIXTURE);

    const binaryList = page.getByTestId('project-detail-binaries');
    const pdfRow = binaryList
      .locator('[data-testid^="attachment-binary-row-"]')
      .filter({ hasText: 'sample.pdf' })
      .last();
    await expect(pdfRow).toBeVisible({ timeout: 15_000 });

    // Install the route AFTER the upload so init/complete/list are not
    // intercepted (those calls happen on different paths). Match every
    // download-url request and return the spec-pinned 422.
    //
    // Use `context().route` rather than `page.route`: under ADR-0024
    // the download-url call is issued by the Service Worker (not the
    // page), and `page.route` only intercepts page-originated fetches.
    // `context().route` matches at the BrowserContext level, which
    // covers SW-originated requests too.
    await page.context().route('**/api/projects/*/attachments/*/download-url**', async (route) => {
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'DEK_UNWRAP_FAILED',
          message: 'Schlüssel nicht verfügbar.',
        }),
      });
    });

    // Trigger the lazy probe. For binaries the click on
    // `Herunterladen` is the detection point — the user's download
    // click.
    await pdfRow.getByTestId('attachment-download').click();

    // 1. The German placeholder label is rendered for the affected row.
    //    Asserted on text rather than a testid because the testid for
    //    the new placeholder is implementation-defined; the label is
    //    spec-pinned (AC-244 + STRINGS.attachments.keyUnavailable in
    //    config catalogue once added).
    await expect(pdfRow).toContainText('Schlüssel nicht verfügbar', { timeout: 5_000 });

    // 2. The download action is disabled — the user cannot retry-loop
    //    against an unwrap failure that is rooted in operator
    //    key-state, not a transient network error.
    await expect(pdfRow.getByTestId('attachment-download')).toBeDisabled();

    // 3. The row is excluded from `bulk-fetch` selection — the per-row
    //    checkbox is disabled, mirroring the `"Datei fehlt"` exclusion
    //    in the existing `missing` set (AC-436).
    //    Asserts disabled-state on the checkbox; the row's id is
    //    embedded in the testid suffix, so a partial CSS attribute
    //    match avoids hardcoding the runtime-generated id.
    await expect(pdfRow.locator('[data-testid^="binary-select-"]')).toBeDisabled();
  });
});

/** The labels of data-model.md §5.13 with their German names (architecture.md §12.2). */
const ATTACHMENT_LABEL_NAMES = {
  angebot: 'Angebot',
  auftragsbestaetigung: 'Auftragsbestätigung',
  rechnung: 'Rechnung',
  aufmass: 'Aufmaß',
  foto: 'Foto',
  sonstiges: 'Sonstiges',
} as const;

/**
 * Default `[C]` caps of architecture.md §12.2. The client takes them from
 * source constants (src/config/attachmentPipeline.ts, attachmentDefaults.ts),
 * not an endpoint, and the e2e server sets no override.
 */
const PER_FILE_CAP_BYTES = 1024 * 1024;
const BULK_MAX_FILES = 20;
const BULK_MAX_MB = 20;

const KIB = 1024;
const BYTE_TIERS = [
  { unit: 'B', size: 1, decimals: 0 },
  { unit: 'KB', size: KIB, decimals: 0 },
  { unit: 'MB', size: KIB ** 2, decimals: 2 },
  { unit: 'GB', size: KIB ** 3, decimals: 2 },
] as const;

/**
 * The byte format of verification.md §15.29 on a live total: powers of
 * 1024, B and KB whole, MB and GB with two decimals after a comma. The
 * rounding mode is left open, so the shown value may be off by less than
 * one displayed step.
 */
function expectByteText(text: string, bytes: number): void {
  const tier = [...BYTE_TIERS].reverse().find((t) => bytes >= t.size) ?? BYTE_TIERS[0];
  const pattern = tier.decimals === 0 ? /^(\d+) (\w+)$/ : /^(\d+,\d{2}) (\w+)$/;
  const match = text.trim().match(pattern);
  const what = `"${text}" for ${bytes} bytes`;
  expect(match, what).not.toBeNull();
  expect(match![2], what).toBe(tier.unit);
  const shown = Number(match![1].replace(',', '.')) * tier.size;
  expect(Math.abs(shown - bytes), what).toBeLessThan(tier.size / 10 ** tier.decimals);
}

interface ApiAttachment {
  id: string;
  fileName: string;
  label: string;
  kind: string;
}

interface StorageUsage {
  ready: { plaintext: number };
  hidden: { plaintext: number };
}

test.describe('Attachment and storage flows (owner on a fresh project)', () => {
  // Owner: holds `data:export` (the storage totals) and may delete any
  // attachment. A project of its own keeps the 21-file selection below
  // out of the seeded project the other tests share.
  test.use({ storageState: STORAGE_STATES.owner });

  test('walks the attachment and storage ACs', async ({ page }) => {
    const stamp = Date.now() % 1_000_000_000;
    const customer = await page.request.post('/api/customers', {
      data: { name: `Anhang-Kunde ${stamp}` },
    });
    expect(customer.status(), await customer.text()).toBe(201);
    const project = await page.request.post('/api/projects', {
      data: { number: `AT-${stamp}`, title: 'Anhänge', customerId: (await customer.json()).id },
    });
    expect(project.status(), await project.text()).toBe(201);
    const projectId = (await project.json()).id as string;

    const listAttachments = async (): Promise<ApiAttachment[]> => {
      const res = await page.request.get(`/api/projects/${projectId}/attachments`);
      expect(res.ok(), `GET attachments returned ${res.status()}`).toBe(true);
      return ((await res.json()) as { data: ApiAttachment[] }).data;
    };
    const storageUsage = async (): Promise<StorageUsage> => {
      const res = await page.request.get('/api/storage-usage');
      expect(res.ok(), `GET /api/storage-usage returned ${res.status()}`).toBe(true);
      return (await res.json()) as StorageUsage;
    };
    const inits: string[] = [];
    const bulkFetches: string[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/attachments/init')) inits.push(req.url());
      if (req.url().endsWith('/attachments/bulk-fetch')) bulkFetches.push(req.url());
    });

    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId('project-detail-page')).toBeVisible();
    // Downloads run through the Service Worker's decrypt path.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    const uploadCta = page.getByTestId('project-detail-upload-cta');
    const binaryInput = uploadCta.getByTestId('attachment-binary-input');
    const photoInput = uploadCta.getByTestId('attachment-photo-input');
    const labelSelect = uploadCta.getByLabel('Beschriftung');
    const binaryList = page.getByTestId('project-detail-binaries');
    const binaryRows = binaryList.locator('[data-testid^="attachment-binary-row-"]');
    const rowNamed = (fileName: string) => binaryRows.filter({ hasText: fileName });
    const pdf = fs.readFileSync(PDF_FIXTURE);
    const pdfFile = (name: string, buffer = pdf) => ({ name, mimeType: 'application/pdf', buffer });

    await test.step('AC-446 document label control offers the labels except foto', async () => {
      // A closed choice: a select, not a text field.
      expect(await labelSelect.evaluate((el) => el.tagName)).toBe('SELECT');
      const { foto: _photoOnly, ...documentLabels } = ATTACHMENT_LABEL_NAMES;
      const options = await labelSelect.locator('option').allTextContents();
      expect([...options].sort()).toEqual(Object.values(documentLabels).sort());
    });

    const measured = 'Aufmaß Küche (2026).pdf';

    await test.step('AC-417 a download is saved under its file name', async () => {
      await labelSelect.selectOption({ label: ATTACHMENT_LABEL_NAMES.aufmass });
      await binaryInput.setInputFiles(pdfFile(measured));
      const row = rowNamed(measured);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row).toContainText(ATTACHMENT_LABEL_NAMES.aufmass);
      const stored = (await listAttachments()).filter((a) => a.fileName === measured);
      expect(stored.map((a) => a.label)).toEqual(['aufmass']);
      // Positive control: the listener sees uploads, so "no upload started" below means it.
      expect(inits.length, 'the init listener sees an upload').toBeGreaterThan(0);

      const download = page.waitForEvent('download');
      await row.getByRole('button', { name: 'Herunterladen' }).click();
      expect((await download).suggestedFilename()).toBe(measured);
    });

    await test.step('AC-437 a failed load keeps download and delete available', async () => {
      const row = rowNamed(measured);
      // A download-url server fault: neither the missing-file nor the
      // key-unavailable verdict. The Service Worker issues the call, so
      // the route sits on the context.
      const downloadUrl = '**/api/projects/*/attachments/*/download-url**';
      await page.context().route(downloadUrl, (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Interner Fehler.' }),
        }),
      );
      await row.getByRole('button', { name: 'Herunterladen' }).click();
      await expect(row).toContainText('Datei konnte nicht geladen werden');
      await expect(row.getByRole('button', { name: 'Herunterladen' })).toBeEnabled();
      await expect(row.getByRole('button', { name: 'Löschen' })).toBeEnabled();

      await page.context().unroute(downloadUrl);
      const download = page.waitForEvent('download');
      await row.getByRole('button', { name: 'Herunterladen' }).click();
      expect((await download).suggestedFilename()).toBe(measured);

      // Delete works too; the file goes to the Papierkorb, which gives the
      // storage steps below a non-zero Papierkorb total.
      await row.getByRole('button', { name: 'Löschen' }).click();
      await page.getByTestId('confirm-ok').click();
      await expect(row).toHaveCount(0);
      // The list drops the row optimistically; wait for the server.
      await expect
        .poll(async () => (await listAttachments()).some((a) => a.fileName === measured))
        .toBe(false);
    });

    await test.step('AC-406 a type outside the whitelist is blocked, naming the types', async () => {
      const before = await listAttachments();
      const initsBefore = inits.length;
      const banner = uploadCta.getByTestId('upload-validation-banner');
      for (const [input, file] of [
        [binaryInput, { name: 'notiz.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }],
        [photoInput, { name: 'bild.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') }],
      ] as const) {
        await input.setInputFiles(file);
        await expect(banner, file.name).toBeVisible();
        // The whitelist of data-model.md §5.13.
        for (const type of ['JPEG', 'PNG', 'WebP', 'PDF', 'DOCX']) {
          await expect(banner, file.name).toContainText(type);
        }
        await banner.getByRole('button', { name: 'Verwerfen' }).click();
        await expect(banner).toHaveCount(0);
      }
      expect(inits.length, 'no upload started').toBe(initsBefore);
      expect(await listAttachments()).toEqual(before);
    });

    // The document half of the per-file cap AC (§15.26 Upload). Its ID joins
    // this step once an e2e also asserts a photo measured after re-encoding:
    // a cited AC counts as covered (scripts/check-traceability.sh).
    await test.step('a document over the per-file cap is blocked, without retry', async () => {
      const before = await listAttachments();
      const initsBefore = inits.length;
      const tooLarge = Buffer.concat([pdf, Buffer.alloc(PER_FILE_CAP_BYTES)]);
      await binaryInput.setInputFiles(pdfFile('zu-gross.pdf', tooLarge));
      const banner = uploadCta.getByTestId('upload-error-banner');
      await expect(banner).toContainText('Datei zu groß');
      await expect(banner.getByRole('button', { name: 'Erneut versuchen' })).toHaveCount(0);
      expect(inits.length, 'no upload started').toBe(initsBefore);
      expect(await listAttachments()).toEqual(before);
      await banner.getByRole('button', { name: 'Verwerfen' }).click();
      await expect(banner).toHaveCount(0);
    });

    await test.step('AC-435 a ZIP selection over a cap is blocked, naming both caps', async () => {
      const binaries = async () => (await listAttachments()).filter((a) => a.kind === 'binary');
      const missing = BULK_MAX_FILES + 1 - (await binaries()).length;
      for (let i = 1; i <= missing; i++) {
        await binaryInput.setInputFiles(pdfFile(`stapel-${String(i).padStart(2, '0')}.pdf`));
      }
      // 21 uploads: more than the default 5 s, below the 30 s test timeout.
      await expect
        .poll(async () => (await binaries()).length, { timeout: 20_000 })
        .toBeGreaterThan(BULK_MAX_FILES);
      await expect(binaryRows).toHaveCount((await binaries()).length);

      await binaryList.getByRole('checkbox', { name: 'Alle auswählen' }).check();
      const downloads: string[] = [];
      page.on('download', (d) => downloads.push(d.suggestedFilename()));
      await binaryList.getByRole('button', { name: 'Auswahl als ZIP' }).click();
      const message = binaryList.getByTestId('binary-bulk-limit-error');
      await expect(message).toContainText(`${BULK_MAX_FILES} Dateien`);
      await expect(message).toContainText(`${BULK_MAX_MB} MB`);
      expect(bulkFetches, 'blocked before any request').toEqual([]);
      expect(downloads, 'no download').toEqual([]);
    });

    await page.goto('/daten');
    await expect(page.getByTestId('daten-storage-row')).toBeVisible();
    const badge = page.getByTestId('storage-usage-badge');
    const badgeValue = badge.getByTestId('storage-usage-badge-value');
    const tooltip = badge.getByTestId('storage-usage-badge-tooltip');
    const tooltipLines = tooltip.locator(':scope > span');
    const visibleRow = page.getByTestId('daten-storage-row-sichtbar');
    const trashRow = page.getByTestId('daten-storage-row-papierkorb');
    const after = (prefix: string) => (text: string) => {
      expect(text.startsWith(prefix), `"${text}" starts with "${prefix}"`).toBe(true);
      return text.slice(prefix.length);
    };
    const visibleTotal = after('Sichtbar: ');
    const trashTotal = after('Im Papierkorb: ');

    await test.step('AC-449 hovering the storage badge shows both totals, labeled', async () => {
      const usage = await storageUsage();
      expect(usage.ready.plaintext, 'needs a visible total').toBeGreaterThan(0);
      expect(usage.hidden.plaintext, 'needs a Papierkorb total').toBeGreaterThan(0);
      await expect(tooltip).toBeHidden();
      await badge.hover();
      await expect(tooltip).toBeVisible();
      await expect(tooltipLines).toHaveCount(2);
      await expect(async () => {
        const { ready, hidden } = await storageUsage();
        const [visible, trash] = await tooltipLines.allInnerTexts();
        expectByteText(visibleTotal(visible), ready.plaintext);
        expectByteText(trashTotal(trash), hidden.plaintext);
      }).toPass({ timeout: 5_000 });
    });

    // The storage-totals half; daten-jobs.spec.ts asserts the progress byte counts.
    await test.step('AC-451 storage totals are shown in powers of 1024', async () => {
      await expect(async () => {
        const { ready, hidden } = await storageUsage();
        expectByteText(await badgeValue.innerText(), ready.plaintext);
        expectByteText(visibleTotal(await visibleRow.innerText()), ready.plaintext);
        expectByteText(trashTotal(await trashRow.innerText()), hidden.plaintext);
      }).toPass({ timeout: 5_000 });

      // Each tier and its boundaries on exact values. The live totals
      // cannot reach them, so the totals the views read are replaced. A
      // fractional KB value stays whole; its rounding mode is left open.
      const labeled = (prefix: string, text: string | RegExp) =>
        typeof text === 'string'
          ? `${prefix}${text}`
          : new RegExp(`^${prefix}${text.source.slice(1)}`);
      for (const [ready, hidden] of [
        [
          { bytes: 1023, text: '1023 B' },
          { bytes: KIB, text: '1 KB' },
        ],
        [
          { bytes: 1023 * KIB, text: '1023 KB' },
          { bytes: KIB ** 2, text: '1,00 MB' },
        ],
        [
          { bytes: 1.5 * KIB ** 2, text: '1,50 MB' },
          { bytes: 2.25 * KIB ** 3, text: '2,25 GB' },
        ],
        [
          { bytes: 1500, text: /^\d+ KB$/ },
          { bytes: 2.5 * KIB, text: /^\d+ KB$/ },
        ],
      ] as const) {
        await page.route('**/api/storage-usage', (route) =>
          route.fulfill({
            json: {
              ready: { plaintext: ready.bytes, ciphertext: ready.bytes },
              hidden: { plaintext: hidden.bytes, ciphertext: hidden.bytes },
            },
          }),
        );
        await page.reload();
        await expect(badgeValue).toHaveText(ready.text);
        await expect(visibleRow).toHaveText(labeled('Sichtbar: ', ready.text));
        await expect(trashRow).toHaveText(labeled('Im Papierkorb: ', hidden.text));
        await badge.hover();
        await expect(tooltipLines).toHaveText([
          labeled('Sichtbar: ', ready.text),
          labeled('Im Papierkorb: ', hidden.text),
        ]);
        await page.unroute('**/api/storage-usage');
      }
    });
  });
});
