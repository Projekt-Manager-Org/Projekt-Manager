import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_RESTORE_PHRASE,
  SEED_DEFAULT_PASSWORD,
  SEED_USERS,
} from '../src/test/seedAssumptions.js';
import { STORAGE_STATES } from './storage-states';
import { clickView } from './nav-helpers';
import { reseedAllStorageStates } from './auth-helpers';
import { createDatabase } from '../src/server/db/connection.js';
import { seed } from '../src/server/seed.js';

/**
 * E2E — Daten job-driven UI roundtrip (AC-335 [vis], AC-328 e2e arm, AC-161).
 *
 * RED-BY-DESIGN. This spec drives the job-endpoint Daten UI that does NOT
 * exist yet: the live DatenView still walks the retiring client-streaming
 * flow (`export-all-*` / `import-all-*`). It therefore fails until step 4
 * lands the export/import job stores + dialog rewire. It REPLACES the
 * retiring `daten-vollstaendiger-export.spec.ts` + `daten-vollstaendiger-import.spec.ts`,
 * which step 5 deletes once the client-streaming machinery is removed.
 *
 * What it pins (the KEY DELTA from the retiring specs: the UI now drives the
 * JOB endpoints, not client-side byte orchestration):
 *
 *   AC-335  Export dialog: POST /api/export-jobs → progress (files / bytes +
 *           current item) → Range download; mobile-warning below the
 *           configured breakpoint; mount-time resume probe re-surfaces a
 *           `ready` job's download after a page reload. Import dialog: file
 *           pick → confirmation-phrase gate → resumable upload progress →
 *           server processing → re-auth after the user-wipe → restored-counts
 *           summary. Both dialogs drive the job endpoints, not client bytes.
 *   AC-328  Full attachment roundtrip via the JOB path — seed (photo +
 *           binary) → export job → import job — restores every row at
 *           byte-equal plaintext, `(id, createdBy, createdAt)` preserved,
 *           photo thumbnail regenerated server-side and decodes.
 *   AC-161  The Import confirmation-phrase input gates the start action: it
 *           stays disabled until the typed value matches the configured
 *           phrase. No client dry-run probe.
 *
 * testids the UI implementation MUST introduce (per
 * `docs/wip/step4-ui-rewire-design.md §testids` — use these EXACT names;
 * the retiring `export-all-*` / `import-all-*` ids are deliberately NOT used):
 *
 *   DatenView (exist): daten-view, data-export-button, data-import-button
 *   Export dialog:  export-job-dialog, export-job-preflight,
 *                   export-job-mobile-warning, export-job-start,
 *                   export-job-progress, export-job-progress-counter,
 *                   export-job-progress-bytes, export-job-current-item,
 *                   export-job-ready, export-job-download
 *   Import dialog:  import-job-confirm, import-job-phrase-input,
 *                   import-job-start, import-job-uploading,
 *                   import-job-upload-bytes, import-job-processing,
 *                   import-job-summary
 *
 * Async job phases run server-side (the build + the restore + per-attachment
 * re-encrypt), so the progress/processing assertions carry generous timeouts.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JPG_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.jpg');
const PDF_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.pdf');

test.describe.configure({ mode: 'serial' });
test.use({ storageState: STORAGE_STATES.owner });

/**
 * Teardown for the destructive roundtrip below.
 *
 * The roundtrip test drives an import JOB that wipes the account (TRUNCATEs
 * `users`, cascading through `sessions` — AC-310) and leaves the seed reshaped
 * (two extra attachments on the first project). The rest of the serial mutating
 * bucket reuses this file's shared `storageState` cookies and a pristine seed,
 * so this spec MUST restore both.
 *
 * Reset is done by re-running the canonical seed — identical to `auth.setup.ts`
 * — rather than snapshotting + restoring through the `/api/export` +
 * `/api/import` text routes. Those were removed when data-exchange moved to the
 * job endpoints (#235); the old snapshot/restore therefore silently no-opped
 * and the re-mint below never ran, landing every later mutating spec on the
 * login screen.
 */
test.afterAll(async ({ browser }) => {
  // 1. Reset the e2e DB to the canonical seed, undoing the roundtrip's wipe +
  //    the two attachments it adds. `process.env.DATABASE_URL` already points
  //    at the isolated e2e database (set in playwright.config.ts, inherited by
  //    every worker) — the same handle `auth.setup.ts` opens to seed.
  const { db, pool } = createDatabase();
  try {
    await seed(db, { force: true });
  } finally {
    await pool.end();
  }

  // 2. Re-mint every role's storageState from a fresh login. The force-seed
  //    above TRUNCATEs `sessions`, so the shared cookies are dead; this re-mint
  //    is the contract that keeps the serial bucket authenticated, and MUST run
  //    unconditionally.
  await reseedAllStorageStates(browser);
});

interface SeededAttachment {
  id: string;
  fileName: string;
  kind: 'photo' | 'binary';
  /** Plaintext bytes the seed uploaded — what the restored row's download must byte-equal. */
  plaintext: Buffer;
  createdAt: string;
  createdBy: string;
}

/**
 * AES-256-GCM encrypt `plaintext` under a fresh 32-byte DEK. Mirrors the
 * browser-side `encryptBlob` shape (`nonce(12) || ct || tag(16)`) so the
 * seeded ciphertext is decryptable by the SAME contract the production code
 * reads (ADR-0024 §Encryption). Node's WebCrypto (Node 22+) is the producer.
 */
async function encryptForUpload(
  plaintext: Buffer,
): Promise<{ dek: Buffer; ciphertext: Buffer }> {
  const dek = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    dek,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const sealed = Buffer.from(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, plaintext),
  );
  // `nonce || ct || tag` — `subtle.encrypt` already appends the auth tag to
  // the ciphertext output, so we just prepend the nonce.
  return { dek, ciphertext: Buffer.concat([nonce, sealed]) };
}

/**
 * RFC 1864 base64 MD5 of `bytes`. Mirrors the browser-side `computeMd5Base64`
 * output that the storage provider verifies against the signed presigned-PUT
 * `Content-MD5`.
 */
function md5Base64(bytes: Buffer): string {
  return crypto.createHash('md5').update(bytes).digest('base64');
}

/**
 * Seed one photo + one binary attachment via the wire init → PUT → complete
 * dance, using the SAME endpoints the standard upload pipeline drives. Avoids
 * the project-detail-page UI selectors (fragile; separate
 * `attachment-photo-input` / `attachment-binary-input` testids, no
 * `attachment-row-*` testid). Mirrors the retiring import spec's seed: API-
 * driven, no UI clicks for fixture setup.
 *
 * Captures `(id, createdAt, createdBy, plaintext)` per-attachment from the
 * init response so the post-restore identity-field cross-check + byte-
 * equality assertions remain unchanged.
 *
 * Plaintext is forwarded verbatim — no client-side image-pipeline re-encode —
 * because the byte-equality assertion at the verify step compares pre-restore
 * plaintext with post-restore download bytes. They must remain bit-identical
 * through the export → import roundtrip. (On the JOB path the server re-
 * encrypts the staged-archive plaintext, so the recovered plaintext is the
 * same bytes that went in.)
 */
async function seedAttachmentsOnFirstProject(page: Page, request: APIRequestContext): Promise<{
  projectId: string;
  attachments: SeededAttachment[];
}> {
  // Pick the first project from the seed via API — the kanban UI is not the
  // load-bearing surface here, just a way to find a valid projectId.
  const projectListRes = await request.get('/api/projects');
  expect(projectListRes.ok()).toBe(true);
  const projectList = (await projectListRes.json()) as { data: Array<{ id: string }> };
  const projectId = projectList.data[0]?.id;
  if (!projectId) throw new Error('seedAttachmentsOnFirstProject: no projects in seed');

  const photoBytes = fs.readFileSync(JPG_FIXTURE);
  const pdfBytes = fs.readFileSync(PDF_FIXTURE);

  // Labels MUST belong to the closed `ATTACHMENT_LABELS` enum
  // (`src/domain/attachments.ts`); the server's `init` schema rejects
  // anything else with 422 VALIDATION_ERROR.
  const fixtures = [
    {
      kind: 'photo' as const,
      fileName: 'sample.jpg',
      mimeType: 'image/jpeg',
      label: 'foto',
      plaintext: photoBytes,
      hasThumbnail: false, // seed-time skip; the import job re-derives thumbs server-side.
    },
    {
      kind: 'binary' as const,
      fileName: 'sample.pdf',
      mimeType: 'application/pdf',
      label: 'sonstiges',
      plaintext: pdfBytes,
      hasThumbnail: false,
    },
  ];

  const seeded: SeededAttachment[] = [];
  for (const f of fixtures) {
    const { dek, ciphertext } = await encryptForUpload(f.plaintext);
    const dekMaterial = dek.toString('base64');
    const ciphertextSizeBytes = ciphertext.byteLength;
    const ciphertextContentMd5 = md5Base64(ciphertext);

    // 1. init — server creates a 'pending' row and signs a presigned PUT for
    //    the ciphertext.
    const initRes = await request.post(`/api/projects/${projectId}/attachments/init`, {
      data: {
        fileName: f.fileName,
        mimeType: f.mimeType,
        sizeBytes: f.plaintext.byteLength,
        label: f.label,
        hasThumbnail: f.hasThumbnail,
        dekMaterial,
        ciphertextSizeBytes,
        ciphertextContentMd5,
      },
    });
    if (!initRes.ok()) {
      const errBody = await initRes.text().catch(() => '<no body>');
      throw new Error(
        `init failed for ${f.fileName}: status=${initRes.status()} body=${errBody}`,
      );
    }
    const initBody = (await initRes.json()) as {
      attachment: {
        id: string;
        createdAt: string;
        createdBy: { id: string } | string | null;
      };
      originalUpload: { url: string; headers: Record<string, string> };
    };
    const id = initBody.attachment.id;
    const createdAt = initBody.attachment.createdAt;
    const createdBy =
      typeof initBody.attachment.createdBy === 'string'
        ? initBody.attachment.createdBy
        : initBody.attachment.createdBy?.id ?? null;
    if (!createdBy) throw new Error(`seed: createdBy null on ${f.fileName}`);

    // 2. PUT presigned URL with the ciphertext bytes. Strip the forbidden
    //    `Content-Length` header — Playwright's `request.put` computes it
    //    itself, matching the browser path. Other signed headers
    //    (Content-Type, Content-MD5) ride verbatim.
    const safeHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(initBody.originalUpload.headers)) {
      if (k.toLowerCase() === 'content-length') continue;
      safeHeaders[k] = v;
    }
    const putRes = await request.put(initBody.originalUpload.url, {
      headers: safeHeaders,
      data: ciphertext,
    });
    expect(putRes.ok(), `PUT presigned URL failed for ${f.fileName}`).toBe(true);

    // 3. complete — server HEADs the storage object + flips status to 'ready'.
    //    After this the row is visible to the export-job build.
    const completeRes = await request.post(
      `/api/projects/${projectId}/attachments/${id}/complete`,
    );
    expect(completeRes.ok(), `complete failed for ${f.fileName}`).toBe(true);

    seeded.push({
      id,
      fileName: f.fileName,
      kind: f.kind,
      plaintext: f.plaintext,
      createdAt,
      createdBy,
    });
  }

  // Sanity: visit the project detail page so a subsequent UI flow has a warm
  // document. Stays UI-driven for the test's actual subject (the dialogs)
  // while the seed stays API-direct.
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByTestId('project-detail-page')).toBeVisible();

  return { projectId, attachments: seeded };
}

/**
 * Drive the Export JOB dialog and return the downloaded zip bytes.
 *
 * The KEY DELTA from the retiring export spec: the dialog drives
 * `POST /api/export-jobs` → progress readout → a Range download `<a>` GETting
 * `/api/export-jobs/:id/download` — NOT a client-assembled blob. A small seed
 * may reach `ready` fast, so the progress readout assertion tolerates a quick
 * transition (it asserts EITHER a progress readout OR an already-`ready`
 * state surfaced).
 */
async function exportJobZip(page: Page): Promise<Buffer> {
  await page.goto('/');
  await clickView(page, 'daten');
  await expect(page.getByTestId('daten-view')).toBeVisible();

  const exportBtn = page.getByTestId('data-export-button');
  await expect(exportBtn).toBeVisible();
  await exportBtn.click();

  // Preflight → start the job (POST /api/export-jobs).
  const dialog = page.getByTestId('export-job-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('export-job-preflight')).toBeVisible();
  await page.getByTestId('export-job-start').click();

  // Progress readout — files-done/total, bytes-done/total, current item. A
  // small seed may flip to `ready` before we can observe `progress`, so each
  // readout accepts `ready` as the alternative.
  //
  // Every assertion carries its own `.or(ready)` rather than sitting inside an
  // `if (await progress.isVisible())` branch: that samples the phase once and
  // then asserts against a state that may already be gone. The phase is short
  // enough for that to matter — the sibling import arm below was measured
  // living 13-32ms, against 1-8ms per round-trip — and each assertion inside
  // such a branch spends more of the remaining budget than the last.
  //
  // A readout missing while `progress` is up would now be masked by `ready`
  // arriving. That is deliberate: whether the three readouts render at all is
  // structural, and `VollstaendigerExportDialog.test.tsx` pins it against a
  // fixed job DTO with no clock involved. What only e2e can show is that the
  // real job walks preflight → progress → ready, which is what stays here.
  const progress = page.getByTestId('export-job-progress');
  const ready = page.getByTestId('export-job-ready');
  await expect(progress.getByTestId('export-job-progress-counter').or(ready).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(progress.getByTestId('export-job-progress-bytes').or(ready).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(progress.getByTestId('export-job-current-item').or(ready).first()).toBeVisible({
    timeout: 60_000,
  });

  // Ready → a download affordance (`<a>` GETting /api/export-jobs/:id/download).
  await expect(ready).toBeVisible({ timeout: 60_000 });
  const downloadLink = page.getByTestId('export-job-download');
  await expect(downloadLink).toBeVisible();

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await downloadLink.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('exportJobZip: download.path() returned null');
  const bytes = fs.readFileSync(downloadPath);
  // Close the dialog so the ready job is dismissed and does not auto-reattach
  // over the import section on the next Daten visit (DatenView dismisses the
  // job on close; a fresh page reload — the resume sub-arm — re-attaches).
  await page.getByTestId('export-job-close').click();
  return bytes;
}

// NOTE — declaration order is load-bearing in this serial file. The two
// read-only export tests run FIRST; the destructive roundtrip below (its
// import job wipes `users`, invalidating the shared `storageState` cookie for
// every later test in the file) runs LAST. `afterAll` re-mints all storage
// states. If the wipe ran before a read-only test, that test would open a
// context with a now-dead cookie and land on the login screen.

test('AC-335: export job surfaces the mobile-warning below the configured breakpoint', async ({
  page,
}) => {
  // Mobile-warning sub-arm. Navigate at the DEFAULT desktop viewport first so
  // `clickView`'s header nav resolves (the mobile layout has no desktop
  // `header`), THEN resize below the configured breakpoint
  // (`exportAllMobileWarningBreakpointPx` = 480; 390 is unambiguously below)
  // before opening the dialog — the dialog's matchMedia probe reads the
  // viewport at mount. The warning is non-blocking (Start stays enabled).
  await page.goto('/');
  await clickView(page, 'daten');
  await expect(page.getByTestId('daten-view')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 800 });

  await page.getByTestId('data-export-button').click();
  const preflight = page.getByTestId('export-job-preflight');
  await expect(preflight).toBeVisible();

  await expect(preflight.getByTestId('export-job-mobile-warning')).toBeVisible();
  // Non-blocking — start stays enabled.
  await expect(page.getByTestId('export-job-start')).toBeEnabled();
});

test('AC-335: export job resume probe re-surfaces the download after a page reload', async ({
  page,
}) => {
  // Resume sub-arm. With a `ready` job present, a page reload must re-attach
  // via the DatenView mount-time resume probe (GET /api/export-jobs latest)
  // and re-surface the download affordance — no re-click of Export needed.
  await page.goto('/');
  await clickView(page, 'daten');
  await expect(page.getByTestId('daten-view')).toBeVisible();

  // Drive a job to `ready` first.
  await page.getByTestId('data-export-button').click();
  await expect(page.getByTestId('export-job-dialog')).toBeVisible();
  await expect(page.getByTestId('export-job-preflight')).toBeVisible();
  await page.getByTestId('export-job-start').click();
  await expect(page.getByTestId('export-job-ready')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('export-job-download')).toBeVisible();

  // Reload — the mount-time resume probe re-attaches to the `ready` job. Per
  // the mirror-export fix a TERMINAL export re-surfaces INLINE
  // (`export-job-status`), never as a re-popped modal over the import action.
  // Asserting the inline container (not the bare `export-job-download`, which
  // lives on BOTH the inline affordance and the dialog's ready view) is what
  // distinguishes the fix from the bug it replaced.
  await page.reload();
  await expect(page.getByTestId('daten-view')).toBeVisible();
  const inlineStatus = page.getByTestId('export-job-status');
  await expect(inlineStatus).toBeVisible({ timeout: 60_000 });
  await expect(inlineStatus.getByTestId('export-job-download')).toBeVisible();
  // No modal re-popped over the surface.
  await expect(page.getByTestId('export-job-dialog')).toHaveCount(0);
});

test('AC-335 / AC-328 / AC-161: job-driven export → import roundtrip preserves (id, createdBy, createdAt) and plaintext bytes', async ({
  page,
  request,
}) => {
  // -------------------------------------------------------------
  // 1. Seed photo + binary attachments via the wire init→PUT→complete
  //    pipeline, capturing source identity + plaintext bytes for the
  //    post-restore byte-equality assertion.
  // -------------------------------------------------------------
  const { projectId, attachments } = await seedAttachmentsOnFirstProject(page, request);
  expect(attachments.length).toBeGreaterThanOrEqual(2);
  const sourcePhoto = attachments.find((a) => a.kind === 'photo');
  const sourceBinary = attachments.find((a) => a.kind === 'binary');
  expect(sourcePhoto).toBeDefined();
  expect(sourceBinary).toBeDefined();

  // -------------------------------------------------------------
  // 2. Export JOB — drain the takeout zip into a Buffer via the
  //    job-endpoint flow (start → progress → Range download).
  // -------------------------------------------------------------
  const zipBytes = await exportJobZip(page);
  expect(zipBytes.byteLength).toBeGreaterThan(0);

  // -------------------------------------------------------------
  // 3. Import JOB — drive the dialog with the exported zip. The flow is:
  //    file pick → confirmation-phrase gate → resumable upload → server
  //    processing. The restore wipes `users`, so the operator session dies
  //    MID-PROCESSING (not after a summary, unlike the retiring flow). The
  //    next poll 401s and the app routes to the login screen automatically.
  // -------------------------------------------------------------
  await page.goto('/');
  await clickView(page, 'daten');
  const importBtn = page.getByTestId('data-import-button');
  await expect(importBtn).toBeVisible();

  // Click the Import button to fire the OS file picker; the chooser-event
  // handshake lets us feed the takeout-zip without an interactive OS dialog.
  const tmpZipPath = path.join(__dirname, '.tmp-daten-job-import.zip');
  fs.writeFileSync(tmpZipPath, zipBytes);
  try {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await importBtn.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(tmpZipPath);

    // Confirmation-phrase gate (AC-161): start disabled until the typed value
    // matches the configured phrase. Assert disabled-before, enabled-after.
    const confirm = page.getByTestId('import-job-confirm');
    await expect(confirm).toBeVisible();
    const phraseInput = confirm.getByTestId('import-job-phrase-input');
    await expect(phraseInput).toBeVisible();
    // The action buttons live in the DialogShell's actions row — a SIBLING of
    // the phase-body (`import-job-confirm`), not inside it — so page-scope the
    // start button (same as the export arm does for `export-job-start`).
    const startBtn = page.getByTestId('import-job-start');
    await expect(startBtn).toBeDisabled();
    await phraseInput.fill(EXPECTED_RESTORE_PHRASE);
    await expect(startBtn).toBeEnabled();
    await startBtn.click();

    // Resumable upload (client→VPS bytes) → server processing. The upload of a
    // small seed archive is fast, so accept `processing` having already
    // surfaced — but when the uploading phase IS caught, its byte readout must
    // be there (it renders unconditionally inside that view).
    //
    // One assertion, not a sampled `if (await uploading.isVisible())` branch:
    // the phase was measured living only 13-32ms against 1-8ms per round-trip,
    // so the view could unmount between the sample and the assertion, leaving
    // it retrying a locator that would never resolve again.
    //
    // As in the export arm, a missing readout would be masked by `processing`
    // arriving; `VollstaendigerImportDialog.test.tsx` is what pins the readout
    // itself, deterministically. Here the point is that the phase progresses.
    const uploading = page.getByTestId('import-job-uploading');
    const processing = page.getByTestId('import-job-processing');
    await expect(
      uploading.getByTestId('import-job-upload-bytes').or(processing).first(),
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath);
  }

  // -------------------------------------------------------------
  // 4. CRITICAL re-auth delta. The restore TRUNCATEs `users` mid-processing
  //    (AC-310), so the operator's session dies; the next poll 401s and the
  //    app routes to the login screen automatically — there is NO client-held
  //    summary before the wipe (unlike the retiring flow, which carried a
  //    minted import token to a client-side summary). Re-login as owner; the
  //    owner row round-trips through the archive with its seed password.
  // -------------------------------------------------------------
  await expect(page.getByTestId('login-username')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('login-username').fill(SEED_USERS.owner.username);
  await page.getByTestId('login-password').fill(SEED_DEFAULT_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('user-indicator')).toContainText(SEED_USERS.owner.displayName);

  // -------------------------------------------------------------
  // 5. The operator is back on the Daten view (the import was running there)
  //    and the mount-time resume probe auto-opens the import dialog onto the
  //    restored-counts summary (ui/daten.md §8.11.2 step 4 — "the view
  //    re-attaches"). No nav is needed; a clickView here would be blocked by
  //    the import-job overlay. Generous timeout — the server-side restore +
  //    per-attachment re-encrypt run after the re-auth.
  // -------------------------------------------------------------
  await expect(page.getByTestId('daten-view')).toBeVisible();
  await expect(page.getByTestId('import-job-summary')).toBeVisible({ timeout: 60_000 });

  // -------------------------------------------------------------
  // 6. Cross-check restored rows (the AC-328 roundtrip verification, identical
  //    in shape to the retiring import spec):
  //    - (id, createdBy, createdAt) per row equals source
  //    - download-URL plaintext byte-equals seed (AC-241)
  //    - photo thumbnail renders via /encrypted-storage/.../thumbnail (AC-243)
  // -------------------------------------------------------------
  // Identity-field cross-check via the project's attachment list, using the
  // page's freshly re-authed session.
  const list = await page.request.get(`/api/projects/${projectId}/attachments`);
  expect(list.ok()).toBe(true);
  const restored = (await list.json()).data as Array<{
    id: string;
    createdAt: string;
    createdBy: { id: string } | string | null;
  }>;
  for (const src of attachments) {
    const match = restored.find((r) => r.id === src.id);
    expect(match, `restored row missing for source id ${src.id}`).toBeDefined();
    expect(new Date(match!.createdAt).toISOString()).toBe(
      new Date(src.createdAt).toISOString(),
    );
    const matchCreatedBy =
      typeof match!.createdBy === 'string' ? match!.createdBy : match!.createdBy?.id ?? null;
    expect(matchCreatedBy).toBe(src.createdBy);
  }

  // Download-URL plaintext byte-equality. The endpoint hands `{ url,
  // expiresAt, dekMaterial }`; fetch the ciphertext, AES-256-GCM-decrypt with
  // the unwrapped DEK, and compare against the source plaintext bytes.
  for (const src of attachments) {
    const dl = await page.request.get(
      `/api/projects/${projectId}/attachments/${src.id}/download-url?variant=original`,
    );
    expect(dl.ok()).toBe(true);
    const { url, dekMaterial } = (await dl.json()) as {
      url: string;
      dekMaterial: string;
    };
    const ctRes = await page.request.get(url);
    expect(ctRes.ok()).toBe(true);
    const ctBuf = await ctRes.body();
    const ciphertext = new Uint8Array(ctBuf);
    // `nonce(12) || ciphertext || authTag(16)` per ADR-0024 §Encryption.
    const nonce = ciphertext.slice(0, 12);
    const body = ciphertext.slice(12);
    const dekBytes = Uint8Array.from(atob(dekMaterial), (c) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      dekBytes,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, body),
    );
    expect(plaintext.byteLength).toBe(src.plaintext.byteLength);
    expect(Buffer.from(plaintext).equals(src.plaintext)).toBe(true);
  }

  // Photo thumbnail render via the SW-intercepted synthetic-origin URL. The
  // import JOB regenerates the thumbnail server-side (AC-328), so the gallery
  // should mount an `<img>` whose `naturalWidth` decodes successfully — same
  // load-bearing assertion shape as the retiring import spec / AC-243.
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByTestId('project-detail-page')).toBeVisible();
  const photoImg = page.locator(
    `img[src*="/encrypted-storage/${projectId}/${sourcePhoto!.id}.thumbnail"]`,
  );
  await expect(photoImg).toBeVisible();
  await expect
    .poll(() => photoImg.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
});
