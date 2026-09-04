import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  test('AC-243: photo upload renders a decoded thumbnail (SW decrypt path)', async ({ page }) => {
    // AC-243 (verification.md §15.26) — the Service Worker installed by
    // the SPA intercepts `/encrypted-storage/<projectId>/<attachmentId>.<variant>`,
    // calls `download-url` for the wrapped DEK material, fetches the
    // ciphertext from object storage, AES-256-GCM-decrypts, and returns
    // plaintext through the Fetch response. The traceability row points
    // at this E2E for the visible-render outcome: a successful `<img>`
    // decode is the only browser-observable signal that the SW returned
    // correctly-decrypted plaintext bytes (a decrypt failure would
    // surface as a broken-image fallback — `naturalWidth === 0`).
    //
    // The SW intercept itself cannot be asserted from the test page —
    // Playwright's page-side `route` API runs in the page's network
    // stack, not the SW's. The SW unit test (`src/sw/__tests__/sw-decrypt.test.ts`,
    // per traceability.md AC-243 row) carries the
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
    // synthetic-origin SW path (ui/project-detail.md §8.15.4 + AC-222).
    const gallery = page.getByTestId('project-detail-photos');
    const thumb = gallery.getByTestId('attachment-thumbnail').first();
    await expect(thumb).toBeVisible({ timeout: 15_000 });

    // AC-243 assertion: the `<img>` decoded successfully. `naturalWidth`
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

test.describe('Attachment upload preserves EXIF / GPS through the pipeline', () => {
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
  test('AC-223: Auswahl als ZIP dispatches bulk-fetch with per-file payloads and triggers a download', async ({
    page,
  }) => {
    // AC-223 (verification.md §15.26) — `Auswahl als ZIP` calls
    // `POST /api/projects/:id/attachments/bulk-fetch` (api.md §14.2.11),
    // receives one entry per requested attachment with per-file presigned
    // GET URL + unwrapped DEK material, and the browser assembles a
    // streaming zip locally so the user sees a single download.
    //
    // E2E observability boundary: zip-content validation against the
    // assembled bytes is brittle (streaming-zip output ordering,
    // central-directory layout, in-memory decoding from a Node test
    // process) and the library choice is implementation-defined. The
    // task spec asks for the stable variant: assert the network sequence
    // (bulk-fetch issued, response per-file with ≥ 2 entries) and the
    // browser-level download event. Zip-payload assembly is pinned by
    // the component-level test (`BinaryList.test.tsx` per
    // traceability.md AC-223 row).
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
    //    (api.md §14.2.11 — the route was rewritten as part of ADR-0024).
    const bulkFetchResponse = await bulkFetchPromise;
    expect(bulkFetchResponse.ok()).toBe(true);

    // 2. Response is `{ data: BulkFetchEntry[] }` (api.md §14.2.11) with
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
  });
});

test.describe('Attachment placeholder for unwrappable wrapped envelope', () => {
  test('AC-244: download-url DEK_UNWRAP_FAILED renders "Schlüssel nicht verfügbar" and disables download', async ({
    page,
  }) => {
    // AC-244 (verification.md §15.26 + ui/project-detail.md §8.15.7) —
    // a `status = 'ready'` row whose wrapped envelope cannot be
    // unwrapped at render time renders the German label
    // `"Schlüssel nicht verfügbar"` and disables the download action.
    // Trigger is a 422 `DEK_UNWRAP_FAILED` from `download-url`
    // (api.md §14.2.11 — Error paths under "Download-URL").
    //
    // Detection is lazy per spec §8.15.7: the SW issues the
    // `download-url` call and surfaces the unwrap error to the UI on
    // the in-flight fetch. For binaries that means the click on
    // `attachment-download` triggers the lazy probe; this test mocks
    // the API endpoint upstream of the SW so the SW (or the direct-
    // fetch fallback path during pre-SW implementation steps) sees the
    // 422 and the row flips to the placeholder.
    //
    // Mirrors AC-244's component-level coverage in `PhotoGallery.test.tsx`
    // and `BinaryList.test.tsx` (traceability.md AC-244 row); pinned
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
    // `Herunterladen` is the documented detection point
    // (ui/project-detail.md §8.15.7 — "the trigger is the user's
    // download click").
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
    //    in the existing `missing` set (ui/project-detail.md §8.15.7).
    //    Asserts disabled-state on the checkbox; the row's id is
    //    embedded in the testid suffix, so a partial CSS attribute
    //    match avoids hardcoding the runtime-generated id.
    await expect(pdfRow.locator('[data-testid^="binary-select-"]')).toBeDisabled();
  });
});
