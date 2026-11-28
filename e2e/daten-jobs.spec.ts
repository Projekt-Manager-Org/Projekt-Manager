import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { unzipSync, zipSync } from 'fflate';
import {
  EXPECTED_RESTORE_PHRASE,
  SEED_DEFAULT_PASSWORD,
  SEED_USERS,
} from '../src/test/seedAssumptions.js';
import { STRINGS } from '../src/config/strings.js';
import { STORAGE_STATES } from './storage-states';
import { clickView } from './nav-helpers';
import { reseedAllStorageStates } from './auth-helpers';
import { createDatabase } from '../src/server/db/connection.js';
import { seed } from '../src/server/seed.js';
import { sweepStagedArtifact } from '../src/server/services/takeout-staging.js';

/**
 * E2E — Daten job-driven UI roundtrip.
 *
 * What it pins (the KEY DELTA from the retiring specs: the UI now drives the
 * JOB endpoints, not client-side byte orchestration):
 *
 *   AC-586, AC-606  Export dialog: POST /api/export-jobs → progress
 *           (files / bytes + current item) → Range download; mobile-warning
 *           below the configured breakpoint; a `ready` job's download after
 *           a page reload. Import dialog: file pick → confirmation-phrase
 *           gate → resumable upload progress → server processing → re-auth
 *           after the user-wipe → result summary (AC-604). Both dialogs drive the job
 *           endpoints, not client bytes.
 *   AC-594  Full attachment roundtrip via the JOB path — seed (photo +
 *           binary) → export job → import job — restores every row at
 *           byte-equal plaintext, `(id, createdBy, createdAt)` preserved,
 *           photo thumbnail regenerated server-side and decodes.
 *   AC-161  The Import confirmation-phrase input gates the start action: it
 *           stays disabled until the typed value matches the configured
 *           phrase.
 *   The Daten view walk — one step per `[vis]` AC of the view's job states:
 *           in progress, advancing, re-opened, interrupted, failed, restored.
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
 * Teardown for the two destructive tests below.
 *
 * The Daten view walk and the roundtrip each drive an import JOB that wipes
 * the account (TRUNCATEs `users`, cascading through `sessions` — AC-597); the
 * roundtrip also leaves the seed reshaped (two extra attachments on the first
 * project). The rest of the serial mutating bucket reuses this file's shared
 * `storageState` cookies and a pristine seed, so this spec MUST restore both:
 * the walk calls `resetToSeed` at its end, this hook after the last test.
 *
 * Reset is done by re-running the canonical seed — identical to `auth.setup.ts`
 * — rather than snapshotting + restoring through the `/api/export` +
 * `/api/import` text routes. Those were removed when data-exchange moved to the
 * job endpoints (#235); the old snapshot/restore therefore silently no-opped
 * and the re-mint below never ran, landing every later mutating spec on the
 * login screen.
 */
test.afterAll(async ({ browser }) => {
  await resetToSeed(browser);
});

async function resetToSeed(browser: Browser): Promise<void> {
  // 1. Reset the e2e DB to the canonical seed, undoing an import's wipe +
  //    the attachments a test adds. `process.env.DATABASE_URL` already points
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
}

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
async function encryptForUpload(plaintext: Buffer): Promise<{ dek: Buffer; ciphertext: Buffer }> {
  const dek = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey('raw', dek, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
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
async function seedAttachmentsOnFirstProject(
  page: Page,
  request: APIRequestContext,
): Promise<{
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
      throw new Error(`init failed for ${f.fileName}: status=${initRes.status()} body=${errBody}`);
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
        : (initBody.attachment.createdBy?.id ?? null);
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
    const completeRes = await request.post(`/api/projects/${projectId}/attachments/${id}/complete`);
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
async function exportJobZip(page: Page, opts?: { afterImport?: boolean }): Promise<Buffer> {
  await page.goto('/');
  await clickView(page, 'daten');
  await expect(page.getByTestId('daten-view')).toBeVisible();

  if (opts?.afterImport) await dismissReattachedImportSummary(page);

  const exportBtn = page.getByTestId('data-export-button');
  await expect(exportBtn).toBeVisible();
  await exportBtn.click();

  // Preflight → start the job (POST /api/export-jobs).
  const dialog = page.getByTestId('export-job-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('export-job-preflight')).toBeVisible();
  // AC-432: the archive carries only `ready` attachments. Said here, where the
  // operator's model of "what is in my backup" forms — not at restore time.
  await expect(page.getByTestId('export-job-papierkorb-notice')).toContainText('Papierkorb');
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

/**
 * Drive the Import dialog with `zipBytes` through to the result
 * summary, including the mid-processing re-auth.
 *
 * Flow: file pick → confirmation-phrase gate (AC-161) → resumable upload →
 * server processing. The restore TRUNCATEs `users` mid-processing (AC-597),
 * so the operator's session dies, the next poll 401s, and the app routes to
 * the login screen — there is NO client-held summary before the wipe. After
 * re-login the mount-time resume probe auto-opens the dialog onto the summary
 * (ui/daten.md §8.11.2 step 4).
 *
 * `tmpName` keeps concurrent cycles from sharing one scratch file.
 */
async function importJobZip(
  page: Page,
  zipBytes: Buffer,
  tmpName: string,
  opts?: { afterImport?: boolean },
): Promise<void> {
  await page.goto('/');
  await clickView(page, 'daten');
  if (opts?.afterImport) await dismissReattachedImportSummary(page);
  const importBtn = page.getByTestId('data-import-button');
  await expect(importBtn).toBeVisible();

  // Click the Import button to fire the OS file picker; the chooser-event
  // handshake lets us feed the takeout-zip without an interactive OS dialog.
  const tmpZipPath = path.join(__dirname, tmpName);
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
    // AC-432: the restore is also a Papierkorb purge, called out separately
    // from the generic destructive notice — "the existing data is deleted"
    // does not tell an operator the archive cannot bring the trash back.
    await expect(confirm.getByTestId('import-job-papierkorb-notice')).toContainText('Papierkorb');
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

    // Re-auth after the mid-processing wipe. The owner row round-trips through
    // the archive with its seed password.
    await expect(page.getByTestId('login-username')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('login-username').fill(SEED_USERS.owner.username);
    await page.getByTestId('login-password').fill(SEED_DEFAULT_PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('user-indicator')).toContainText(SEED_USERS.owner.displayName);

    // Back on the Daten view (the import was running there); no nav is needed —
    // a clickView here would be blocked by the import-job overlay. Generous
    // timeout: the restore + per-attachment re-encrypt run after the re-auth.
    await expect(page.getByTestId('daten-view')).toBeVisible();
    await expect(page.getByTestId('import-job-summary')).toBeVisible({ timeout: 60_000 });
  } finally {
    // The scratch file must outlive the whole upload, not merely the
    // phase-progress guard above. `setFiles` hands the page a LAZY handle to
    // this path — Chromium reads the bytes at send time — and the guard is
    // satisfied by the `0 B` readout, before any chunk has been read. Unlinking
    // there raced the first PATCH, which then failed `net::ERR_FILE_NOT_FOUND`
    // and left the dialog wedged at `0 B` (#400; #401 for why it wedges
    // silently). The summary above is the first point where the bytes are
    // provably drained.
    if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath);
  }
}

/**
 * Clear a re-attached terminal import-job summary on the CURRENT page.
 *
 * `dismissedJobId` lives in the store, not in storage, so every fresh page
 * load loses it and the mount-time resume probe re-opens the summary — whose
 * overlay swallows clicks on both Daten action buttons. Callers pass
 * `afterImport` because only they know a terminal import job exists; this is
 * not sampled with `isVisible()`, which the phase-timing notes elsewhere in
 * this file explain is unsafe.
 */
async function dismissReattachedImportSummary(page: Page): Promise<void> {
  await expect(page.getByTestId('daten-view')).toBeVisible();
  const summary = page.getByTestId('import-job-summary');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('import-job-close').click();
  await expect(page.getByTestId('import-job-overlay')).toHaveCount(0);
}

/**
 * Unzip a takeout archive and pull out the three facts a round-trip
 * comparison needs: the envelope's attachment ids, the manifest's attachment
 * ids, and the per-attachment SHA-256. Raw zip bytes are deliberately NOT
 * compared across cycles — `exportedAt` moves and neither entry order nor
 * compression output is contractually byte-stable.
 */
function readArchive(zipBytes: Buffer): {
  envelopeAttachmentIds: string[];
  manifestAttachmentIds: string[];
  sha256ByAttachmentId: Record<string, string>;
} {
  const decoded = unzipSync(new Uint8Array(zipBytes));
  const envelope = JSON.parse(Buffer.from(decoded['data.json']!).toString('utf-8')) as {
    attachments: Array<{ id: string }>;
  };
  const manifest = JSON.parse(Buffer.from(decoded['manifest.json']!).toString('utf-8')) as {
    files: Array<{ sha256: string; attachmentId?: string }>;
  };
  const sha256ByAttachmentId: Record<string, string> = {};
  for (const f of manifest.files) {
    if (f.attachmentId) sha256ByAttachmentId[f.attachmentId] = f.sha256;
  }
  return {
    envelopeAttachmentIds: envelope.attachments.map((a) => a.id).sort(),
    manifestAttachmentIds: Object.keys(sha256ByAttachmentId).sort(),
    sha256ByAttachmentId,
  };
}

/** A data-exchange job row as `GET /api/{export,import}-jobs` returns it. */
interface JobRow {
  id: string;
  kind: 'export' | 'import';
  status: 'pending' | 'running' | 'ready' | 'failed';
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  currentItem: string | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  archiveAvailable: boolean;
}

function jobRow(kind: JobRow['kind'], status: JobRow['status'], p: Partial<JobRow>): JobRow {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind,
    status,
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    currentItem: null,
    errorDetail: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    archiveAvailable: false,
    ...p,
  };
}

const KIB = 1024;
const BYTE_TIERS = [
  { unit: 'B', size: 1, decimals: 0 },
  { unit: 'KB', size: KIB, decimals: 0 },
  { unit: 'MB', size: KIB ** 2, decimals: 2 },
  { unit: 'GB', size: KIB ** 3, decimals: 2 },
] as const;

/**
 * The byte format of AC-451 on a live count: powers of 1024, B and KB whole,
 * MB and GB with two decimals after a comma. The rounding mode is left open,
 * so the shown value may be off by less than one displayed step.
 */
function expectByteCount(text: string, bytes: number): void {
  const tier = [...BYTE_TIERS].reverse().find((t) => bytes >= t.size) ?? BYTE_TIERS[0];
  const pattern = tier.decimals === 0 ? /^(\d+) (\w+)$/ : /^(\d+,\d{2}) (\w+)$/;
  const match = text.trim().match(pattern);
  const what = `"${text}" for ${bytes} bytes`;
  expect(match, what).not.toBeNull();
  expect(match![2], what).toBe(tier.unit);
  const shown = Number(match![1].replace(',', '.')) * tier.size;
  expect(Math.abs(shown - bytes), what).toBeLessThan(tier.size / 10 ** tier.decimals);
}

/**
 * The archive the upload steps import: a valid zip of exactly 10 MiB with no
 * `data.json`, so its restore fails validation and changes nothing (AC-593).
 * It must span more than one upload chunk: the steps hold and drop the
 * second one.
 */
const UPLOAD_ARCHIVE_BYTES = 10 * KIB ** 2;
function uploadArchive(): { name: string; mimeType: string; buffer: Buffer } {
  const zip = (filler: number) =>
    Buffer.from(zipSync({ 'filler.bin': [new Uint8Array(filler), { level: 0 }] }));
  const buffer = zip(UPLOAD_ARCHIVE_BYTES - zip(0).byteLength);
  expect(buffer.byteLength).toBe(UPLOAD_ARCHIVE_BYTES);
  return { name: 'teil-archiv.zip', mimeType: 'application/zip', buffer };
}

// NOTE — declaration order is load-bearing in this serial file. The read-only
// export tests run FIRST. The two destructive tests (an import job wipes
// `users`, invalidating the shared `storageState` cookie) follow: the Daten
// view walk restores the seed and the storage states at its end, the
// roundtrip runs LAST, and `afterAll` re-mints all storage states. If a wipe
// ran before a read-only test, that test would open a context with a
// now-dead cookie and land on the login screen.

test('AC-606: export job surfaces the mobile-warning below the configured breakpoint', async ({
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

test('AC-586: export job resume probe re-surfaces the download after a page reload', async ({
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

test('AC-608: an export whose archive was swept offers a new export, not its download', async ({
  page,
}) => {
  await page.goto('/');
  await clickView(page, 'daten');
  await expect(page.getByTestId('daten-view')).toBeVisible();

  await page.getByTestId('data-export-button').click();
  await expect(page.getByTestId('export-job-preflight')).toBeVisible();
  await page.getByTestId('export-job-start').click();
  await expect(page.getByTestId('export-job-ready')).toBeVisible({ timeout: 60_000 });

  // Sweep the archive the way the staging reaper does once its TTL passed
  // (AC-589); the reaper runs in the server process, so this test calls the
  // same helper instead of waiting a day.
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`
      SELECT id, archive_ref FROM data_exchange_job
      WHERE kind = 'export' AND status = 'ready' AND archive_ref IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `);
    const job = res.rows[0] as { id: string; archive_ref: string } | undefined;
    if (!job) throw new Error('no ready export with a staged archive');
    await sweepStagedArtifact(
      db,
      { id: job.id, archiveRef: job.archive_ref },
      { info: () => {}, error: () => {} },
    );
  } finally {
    await pool.end();
  }

  await page.reload();
  await expect(page.getByTestId('daten-view')).toBeVisible();
  const inlineStatus = page.getByTestId('export-job-status');
  await expect(inlineStatus).toHaveText(
    'Das Archiv ist nicht mehr verfügbar. Starten Sie einen neuen Export.',
  );
  await expect(page.getByTestId('export-job-download')).toHaveCount(0);
  await expect(page.getByTestId('data-export-button')).toBeEnabled();
});

test('AC-585: an unreadable attachment fails the export in the UI — no download is offered', async ({
  page,
}) => {
  // A `ready` attachment whose wrapped DEK cannot be unwrapped must abort the
  // build, not be quietly omitted from the archive. The old contract skipped
  // it and still offered the download, handing the operator a backup its own
  // importer rejects (#387). Unwrap fails before any storage fetch, so the row
  // needs no backing object.
  //
  // Seeded directly — there is no supported way to mint an unreadable row
  // through the product — and removed in `finally` so the destructive
  // roundtrip below still gets a clean export.
  const { db, pool } = createDatabase();
  const badId = crypto.randomUUID();
  try {
    const projectRes = await page.request.get('/api/projects');
    expect(projectRes.ok()).toBe(true);
    const projectId = ((await projectRes.json()) as { data: Array<{ id: string }> }).data[0]?.id;
    if (!projectId) throw new Error('no projects in seed');

    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes, original_key, has_thumbnail,
         wrapped_dek, wrapped_dek_version)
      VALUES (${badId}, ${projectId}, 'ready', 'binary', 'sonstiges',
              'unreadable.pdf', 'application/pdf', 512, 540,
              ${`attachments/${projectId}/${badId}.orig`}, FALSE,
              ${crypto.randomBytes(192).toString('base64')}, 1)
    `);

    await page.goto('/');
    await clickView(page, 'daten');
    await expect(page.getByTestId('daten-view')).toBeVisible();

    await page.getByTestId('data-export-button').click();
    await expect(page.getByTestId('export-job-dialog')).toBeVisible();
    await expect(page.getByTestId('export-job-preflight')).toBeVisible();
    await page.getByTestId('export-job-start').click();

    // The job terminates `failed`; the dialog shows the error phase and names
    // the offending row so the operator can act on it.
    const error = page.getByTestId('export-job-error');
    await expect(error).toBeVisible({ timeout: 60_000 });
    await expect(error).toContainText(badId);

    // The load-bearing assertion: NOTHING downloadable is offered anywhere.
    await expect(page.getByTestId('export-job-ready')).toHaveCount(0);
    await expect(page.getByTestId('export-job-download')).toHaveCount(0);

    // Nor after a reload — the inline terminal affordance shows the error,
    // not a download link.
    await page.reload();
    await expect(page.getByTestId('daten-view')).toBeVisible();
    await expect(page.getByTestId('export-job-download')).toHaveCount(0);
  } finally {
    await db.execute(sql`DELETE FROM attachments WHERE id = ${badId}`);
    await pool.end();
  }
});

test('walks the Daten view ACs', async ({ page, browser }) => {
  // Four real exports, two real imports, a 10 MiB upload and a reseed:
  // ~10 s locally, too close to the default 30 s on a slower runner.
  test.setTimeout(60_000);

  const latestJob = async (kind: JobRow['kind']): Promise<JobRow | null> => {
    // `page.request` bypasses `page.route`: this is the server's row.
    const res = await page.request.get(`/api/${kind}-jobs`);
    expect(res.ok(), `GET /api/${kind}-jobs returned ${res.status()}`).toBe(true);
    return ((await res.json()) as { job: JobRow | null }).job;
  };
  const expectNoneActive = async (kind: JobRow['kind']) => {
    const job = await latestJob(kind);
    expect(['pending', 'running'], `no ${kind} in progress`).not.toContain(job?.status);
  };
  const pickImportFile = async (file: { name: string; mimeType: string; buffer: Buffer }) => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('data-import-button').click();
    await (await chooser).setFiles(file);
  };

  await expectNoneActive('export');
  await expectNoneActive('import');

  // --- Export: the live build of a small seed ends within milliseconds, so
  // the view reads scripted job rows. `page.request` stays unrouted.
  let exportLatest: JobRow | null = null;
  await page.route('**/api/export-jobs', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          json: { code: 'EXPORT_JOB_ACTIVE', message: STRINGS.errors.exportJobActive },
        })
      : route.fulfill({ json: { job: exportLatest } }),
  );
  let importLatest: JobRow | null = null;
  await page.route('**/api/import-jobs', (route) => route.fulfill({ json: { job: importLatest } }));
  const exportProgress = page.getByRole('dialog', { name: 'Export läuft', exact: true });
  /** Both halves of a `<done> / <total>` byte readout, on a live or rounded value. */
  const expectByteCounts = async (readout: Locator, done: number, total: number) => {
    await expect(async () => {
      const [shownDone, shownTotal] = (await readout.innerText()).split(' / ');
      expectByteCount(shownDone!, done);
      expectByteCount(shownTotal!, total);
    }).toPass({ timeout: 5_000 });
  };
  /** A real export started through the API: the server's job-changed frame. */
  const sendJobChangedFrame = async () => {
    const res = await page.request.post('/api/export-jobs');
    expect(res.status(), await res.text()).toBe(201);
    await expect.poll(async () => (await latestJob('export'))?.status).toBe('ready');
  };
  const expectExportProgress = async (row: JobRow, bytes: string) => {
    await expect(exportProgress).toBeVisible();
    await expect(exportProgress.getByTestId('export-job-progress-counter')).toHaveText(
      STRINGS.dataExchange.exportProgressCounter(row.filesDone, row.filesTotal),
    );
    await expect(exportProgress.getByTestId('export-job-progress-bytes')).toHaveText(bytes);
    await expect(exportProgress.getByTestId('export-job-current-item')).toHaveText(
      STRINGS.dataExchange.exportProgressCurrentFile(row.currentItem!),
    );
  };

  await test.step('AC-601 starting an export while one is in progress shows that one', async () => {
    await page.goto('/daten');
    await page.getByTestId('data-export-button').click();
    await expect(page.getByRole('dialog', { name: 'Daten exportieren' })).toBeVisible();
    // Another export started after this page last looked: the start
    // answers 409 and the latest row is that one.
    exportLatest = jobRow('export', 'running', {
      filesTotal: 4,
      filesDone: 1,
      bytesTotal: 8 * KIB,
      bytesDone: 2 * KIB,
      currentItem: 'Angebot.pdf',
    });
    await page.getByRole('button', { name: 'Export starten' }).click();
    await expectExportProgress(exportLatest, '2 KB / 8 KB');
  });

  await test.step('AC-603 opening the Daten view shows the export in progress', async () => {
    exportLatest = jobRow('export', 'running', {
      filesTotal: 5,
      filesDone: 2,
      bytesTotal: 10 * KIB,
      bytesDone: 3 * KIB,
      currentItem: 'Aufmaß Küche.pdf',
    });
    await page.goto('/daten');
    await expectExportProgress(exportLatest, '3 KB / 10 KB');
  });

  await test.step('AC-602 the export progress advances while the view is open', async () => {
    exportLatest = {
      ...exportLatest!,
      filesDone: 3,
      bytesDone: 7 * KIB,
      currentItem: 'Foto Bad.jpg',
    };
    // The view refetches on the server's job-changed frame.
    await sendJobChangedFrame();
    await expectExportProgress(exportLatest, '7 KB / 10 KB');
  });

  // The import's second progress phase, the restore, runs on the server
  // after the upload and ends within milliseconds on a live archive.
  const restoring = page.getByRole('dialog', { name: 'Wiederherstellung läuft', exact: true });
  const expectRestoreProgress = async (row: JobRow) => {
    await expect(restoring).toBeVisible();
    await expect(restoring.getByTestId('import-job-processing-counter')).toHaveText(
      STRINGS.dataExchange.importProgressCounter(row.filesDone, row.filesTotal),
    );
    await expect(restoring.getByTestId('import-job-current-item')).toHaveText(
      STRINGS.dataExchange.importProgressCurrentFile(row.currentItem!),
    );
  };

  await test.step('AC-603 opening the Daten view shows the restore in progress', async () => {
    exportLatest = null;
    importLatest = jobRow('import', 'running', {
      filesTotal: 6,
      filesDone: 2,
      bytesTotal: 10 * KIB,
      bytesDone: 10 * KIB,
      currentItem: 'Aufmaß Bad.pdf',
    });
    await page.goto('/daten');
    await expectRestoreProgress(importLatest);
  });

  await test.step('AC-602 the restore progress advances while the view is open', async () => {
    importLatest = { ...importLatest!, filesDone: 5, currentItem: 'Rechnung 2026-014.pdf' };
    await sendJobChangedFrame();
    await expectRestoreProgress(importLatest);
  });

  await test.step('AC-451 Export and Import progress byte counts are shown in powers of 1024', async () => {
    // Each tier and its boundaries on exact values the live jobs cannot
    // reach, then fractional KB values, whose rounding mode is open.
    const exportBytes = exportProgress.getByTestId('export-job-progress-bytes');
    const importBytes = page.getByTestId('import-job-upload-bytes');
    for (const [done, total, text] of [
      [1023, KIB, '1023 B / 1 KB'],
      [1023 * KIB, KIB ** 2, '1023 KB / 1,00 MB'],
      [1.5 * KIB ** 2, 2.25 * KIB ** 3, '1,50 MB / 2,25 GB'],
      [1500, 2.5 * KIB, null],
    ] as const) {
      exportLatest = jobRow('export', 'running', {
        filesTotal: 2,
        bytesTotal: total,
        bytesDone: done,
        currentItem: 'Rechnung.pdf',
      });
      importLatest = jobRow('import', 'pending', { bytesTotal: total, bytesDone: done });
      await page.goto('/daten');
      for (const readout of [exportBytes, importBytes]) {
        if (text) await expect(readout).toHaveText(text);
        else await expectByteCounts(readout, done, total);
      }
    }
  });
  await page.unroute('**/api/import-jobs');
  await page.unroute('**/api/export-jobs');

  // --- Import: the live server throughout.
  const archive = uploadArchive();
  const archiveTotal = '10,00 MB';
  const confirm = page.getByRole('dialog', { name: 'Daten importieren' });
  const uploading = page.getByRole('dialog', { name: 'Hochladen …', exact: true });
  const interrupted = page.getByRole('dialog', {
    name: 'Upload unterbrochen. Zum Fortsetzen das Archiv über „Import“ erneut wählen.',
    exact: true,
  });
  const uploadBytes = page.getByTestId('import-job-upload-bytes');
  const expectUploadBytes = async (bytesDone: number) => {
    await expect(async () => {
      const [done, total] = (await uploadBytes.innerText()).split(' / ');
      expectByteCount(done!, bytesDone);
      expect(total).toBe(archiveTotal);
    }).toPass({ timeout: 5_000 });
  };
  const sizeMismatch = 'Diese Datei gehört nicht zum laufenden Import.';
  let uploadJob: JobRow;

  await test.step('AC-607 a successful import shows the number of files it restored', async () => {
    const zip = await exportJobZip(page);
    const restorable = readArchive(zip).manifestAttachmentIds.length;
    expect(restorable, 'the archive holds attachments').toBeGreaterThan(0);
    await importJobZip(page, zip, '.tmp-daten-view-import.zip');
    const job = await latestJob('import');
    expect(job).toMatchObject({ status: 'ready', filesDone: restorable });
    const result = page.getByRole('dialog', { name: 'Import abgeschlossen' });
    await expect(result.getByTestId('import-job-restored')).toHaveText(
      `${restorable} Anhänge wiederhergestellt`,
    );
  });

  // The upload's chunk requests are held or dropped on cue, to stop it at a
  // known point.
  type Decision = 'send' | 'drop';
  const patches: Array<{ offset: number; decide: (d: Decision) => void }> = [];
  const archiveUrl = '**/api/import-jobs/*/archive';
  await page.route(archiveUrl, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const decision = await new Promise<Decision>((decide) =>
      patches.push({ offset: Number(route.request().headers()['upload-offset']), decide }),
    );
    return decision === 'send' ? route.continue() : route.abort();
  });

  await test.step('AC-605 picking an archive shows its confirmation, not the earlier result', async () => {
    await page.goto('/daten');
    const result = page.getByRole('dialog', { name: 'Import abgeschlossen' });
    await expect(result).toBeVisible();
    await result.getByRole('button', { name: 'Schließen' }).click();
    await pickImportFile(archive);
    await expect(confirm).toBeVisible();
    await expect(result).toHaveCount(0);
  });

  await test.step('AC-602 the upload progress advances while the view is open', async () => {
    await page.getByTestId('import-job-phrase-input').fill(EXPECTED_RESTORE_PHRASE);
    await page.getByRole('button', { name: 'Import starten' }).click();
    await expect.poll(() => patches.length).toBe(1);
    await expect(uploading).toBeVisible();
    await expect(uploadBytes).toHaveText(`0 B / ${archiveTotal}`);

    patches[0]!.decide('send');
    await expect.poll(() => patches.length).toBe(2);
    uploadJob = (await latestJob('import'))!;
    expect(uploadJob).toMatchObject({ status: 'pending', bytesTotal: UPLOAD_ARCHIVE_BYTES });
    expect(uploadJob.bytesDone, 'the first chunk landed').toBeGreaterThan(0);
    expect(uploadJob.bytesDone).toBe(patches[1]!.offset);
    await expect(uploading).toBeVisible();
    await expectUploadBytes(uploadJob.bytesDone);
  });

  await test.step('AC-611 an upload this page stopped sending says how to continue it', async () => {
    // A lost connection: the next chunk never reaches the server.
    patches[1]!.decide('drop');
    await expect(interrupted).toBeVisible();
    await expectUploadBytes(uploadJob.bytesDone);
    expect(await latestJob('import')).toMatchObject({
      id: uploadJob.id,
      status: 'pending',
      bytesDone: uploadJob.bytesDone,
    });
  });

  await test.step('AC-603 opening the Daten view shows the upload in progress', async () => {
    await page.goto('/daten');
    // A fresh page holds no upload state: what it shows is the server's.
    await expect(interrupted).toBeVisible();
    await expectUploadBytes(uploadJob.bytesDone);
    expect(patches, 'opening the view sends nothing').toHaveLength(2);
  });

  await test.step('AC-610 a file of another size does not continue the upload', async () => {
    await interrupted.getByRole('button', { name: 'Schließen' }).click();
    await pickImportFile({
      name: 'anderes.zip',
      mimeType: 'application/zip',
      buffer: archive.buffer.subarray(0, KIB),
    });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('alert')).toHaveText(sizeMismatch);
    await page.getByTestId('import-job-phrase-input').fill(EXPECTED_RESTORE_PHRASE);
    await expect(page.getByRole('button', { name: 'Import starten' })).toBeDisabled();
    expect(patches, 'nothing uploaded').toHaveLength(2);
    expect(await latestJob('import')).toMatchObject({
      id: uploadJob.id,
      status: 'pending',
      bytesDone: uploadJob.bytesDone,
    });
    await page.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(confirm).toHaveCount(0);
  });

  await test.step('AC-601 starting an import while one is in progress shows that one', async () => {
    // The upload began after this page last looked: it loads without it, so
    // only the start's 409 can lead it there.
    await page.route('**/api/import-jobs', (route) => route.fulfill({ json: { job: null } }));
    await page.goto('/daten');
    await pickImportFile(archive);
    await expect(confirm).toBeVisible();
    await page.unroute('**/api/import-jobs');
    await page.getByTestId('import-job-phrase-input').fill(EXPECTED_RESTORE_PHRASE);
    await page.getByRole('button', { name: 'Import starten' }).click();
    await expect.poll(() => patches.length).toBe(3);
    // It continues the upload where the server stopped (AC-609)…
    expect(patches[2]!.offset).toBe(uploadJob.bytesDone);
    // …and shows that upload's progress, not a new one's.
    await expect(uploading).toBeVisible();
    await expectUploadBytes(uploadJob.bytesDone);
    expect((await latestJob('import'))?.id, 'no second import').toBe(uploadJob.id);
  });

  await test.step('AC-587 a failed export or import shows the failure reason', async () => {
    // Import: the completed upload fails validation (no data.json).
    patches[2]!.decide('send');
    await expect.poll(async () => (await latestJob('import'))?.status).toBe('failed');
    const failedImport = (await latestJob('import'))!;
    expect(failedImport.id).toBe(uploadJob.id);
    expect(failedImport.errorDetail, 'the server names a reason').toBeTruthy();
    await expect(page.getByTestId('import-job-error')).toHaveText(failedImport.errorDetail!);
    await page.getByTestId('import-job-error-close').click();
    await page.unroute(archiveUrl);

    // Export: a `ready` attachment whose key cannot be unwrapped (AC-585).
    // Seeded directly — the product offers no way to mint one.
    const { db, pool } = createDatabase();
    const badId = crypto.randomUUID();
    try {
      const projects = await page.request.get('/api/projects');
      expect(projects.ok()).toBe(true);
      const projectId = ((await projects.json()) as { data: Array<{ id: string }> }).data[0]?.id;
      expect(projectId, 'a project to attach to').toBeDefined();
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes, original_key, has_thumbnail,
           wrapped_dek, wrapped_dek_version)
        VALUES (${badId}, ${projectId}, 'ready', 'binary', 'sonstiges',
                'unlesbar.pdf', 'application/pdf', 512, 540,
                ${`attachments/${projectId}/${badId}.orig`}, FALSE,
                ${crypto.randomBytes(192).toString('base64')}, 1)
      `);
      await page.getByTestId('data-export-button').click();
      await page.getByRole('button', { name: 'Export starten' }).click();
      await expect.poll(async () => (await latestJob('export'))?.status).toBe('failed');
      const failedExport = (await latestJob('export'))!;
      expect(failedExport.errorDetail, 'the server names a reason').toBeTruthy();
      await expect(page.getByTestId('export-job-error')).toHaveText(failedExport.errorDetail!);
      // Once the dialog is closed, the Export section shows it inline.
      await page.getByTestId('export-job-error-close').click();
      await expect(page.getByTestId('export-job-status')).toHaveText(failedExport.errorDetail!);
    } finally {
      await db.execute(sql`DELETE FROM attachments WHERE id = ${badId}`);
      await pool.end();
    }
  });

  // The import replaced every session; the roundtrip below needs fresh ones.
  await resetToSeed(browser);
});

test('AC-586 / AC-594 / AC-161 / AC-584 / AC-604: export → import → export → import round preserves identity, bytes, and archive parity', async ({
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
  // 3. CYCLE 1 — import the archive the export just produced.
  // -------------------------------------------------------------
  await importJobZip(page, zipBytes, '.tmp-daten-job-import.zip');

  // -------------------------------------------------------------
  // 4. CYCLE 2 — re-export the restored state and compare. This is the leg
  //    that makes the round CLOSED rather than one-way: an export→import
  //    that "succeeds" but leaves a state which no longer exports to the
  //    same artifact is still data loss, just deferred. The archive
  //    contents (not the raw zip bytes — `exportedAt` moves and zip
  //    entry order/compression need not be byte-stable) must match: same
  //    attachment id set in BOTH envelope and manifest, and the same
  //    SHA-256 per attachment entry.
  // -------------------------------------------------------------
  const zipBytes2 = await exportJobZip(page, { afterImport: true });
  const cycle1 = readArchive(zipBytes);
  const cycle2 = readArchive(zipBytes2);

  expect(cycle2.envelopeAttachmentIds).toEqual(cycle1.envelopeAttachmentIds);
  expect(cycle2.manifestAttachmentIds).toEqual(cycle1.manifestAttachmentIds);
  // Parity within each archive — the invariant the importer enforces
  // pre-wipe (AC-584). Asserted on both cycles, not just the first.
  expect(cycle1.manifestAttachmentIds).toEqual(cycle1.envelopeAttachmentIds);
  expect(cycle2.manifestAttachmentIds).toEqual(cycle2.envelopeAttachmentIds);
  // Every attachment this test seeded survives both cycles. Containment,
  // not equality — the base seed carries attachments on other projects and
  // they ride the same archive.
  for (const src of attachments) {
    expect(cycle1.envelopeAttachmentIds, `cycle 1 dropped ${src.fileName}`).toContain(src.id);
    expect(cycle2.envelopeAttachmentIds, `cycle 2 dropped ${src.fileName}`).toContain(src.id);
  }
  // Plaintext digests survive cycle 2 unchanged.
  expect(cycle2.sha256ByAttachmentId).toEqual(cycle1.sha256ByAttachmentId);

  // -------------------------------------------------------------
  // 5. Import the SECOND archive. A restored state that cannot itself be
  //    restored is a broken backup chain; this closes the loop.
  // -------------------------------------------------------------
  await importJobZip(page, zipBytes2, '.tmp-daten-job-import-2.zip', { afterImport: true });

  // -------------------------------------------------------------
  // 6. Cross-check restored rows after TWO full cycles (the AC-594
  //    roundtrip verification, identical in shape to the retiring import
  //    spec) — the byte-equality is against the ORIGINAL seed plaintext:
  //    - (id, createdBy, createdAt) per row equals source
  //    - download-URL plaintext byte-equals seed (AC-416)
  //    - photo thumbnail renders via /encrypted-storage/.../thumbnail (AC-416)
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
    expect(new Date(match!.createdAt).toISOString()).toBe(new Date(src.createdAt).toISOString());
    const matchCreatedBy =
      typeof match!.createdBy === 'string' ? match!.createdBy : (match!.createdBy?.id ?? null);
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
    const cryptoKey = await crypto.subtle.importKey('raw', dekBytes, { name: 'AES-GCM' }, false, [
      'decrypt',
    ]);
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, body),
    );
    expect(plaintext.byteLength).toBe(src.plaintext.byteLength);
    expect(Buffer.from(plaintext).equals(src.plaintext)).toBe(true);
  }

  // Photo thumbnail render via the SW-intercepted synthetic-origin URL. The
  // import JOB regenerates the thumbnail server-side (AC-596), so the gallery
  // should mount an `<img>` whose `naturalWidth` decodes successfully — same
  // load-bearing assertion shape as the retiring import spec / AC-416.
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
