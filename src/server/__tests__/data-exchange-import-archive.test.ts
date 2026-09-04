/**
 * API integration tests — import-job ARCHIVE processing: validate-before-
 * wipe, restore fidelity, session invalidation, and the staging reaper's
 * import leg (TDD red).
 *
 * Drives the server-side full-account IMPORT job (api.md §14.2.4 "Import
 * job — *" design notes) + data-model.md §5.18 / §6.15. The happy-path
 * arms produce a REAL archive by running the WORKING export job
 * (`POST /api/export-jobs` → poll `ready` → `GET :id/download`), then
 * upload that archive to an import job over the resumable protocol. This
 * avoids hand-building a manifest + envelope + per-attachment SHA-256s
 * (which would re-encode, and risk diverging from, the export builder).
 *
 *   - AC-327 / AT-141 — validate before wipe. An archive whose
 *     `data.json` carries a wrong `schema_version` (sibling arms: a broken
 *     `manifest.json` per-entry sha256, an out-of-enum mimeType, an unsafe
 *     fileName, two attachment ids sharing one `zipPath`) terminates the
 *     job `failed` with `error_detail` and performs ZERO writes — the
 *     pre-existing target rows are UNTOUCHED. The destructive wipe never
 *     runs on a corrupt / tampered / wrong-version archive.
 *   - AC-328 / AT-142 — restore + server re-encrypt + byte-equal
 *     roundtrip + idempotency. seed (with a ready attachment) → export job
 *     → import job (override + phrase) restores the business rows with IDs
 *     preserved AND each attachment row at byte-equal plaintext: the row
 *     preserves `id` / `createdBy` / `createdAt`, the ciphertext at
 *     `originalKey` AES-256-GCM-decrypts (via the row's freshly-wrapped
 *     DEK) to the SOURCE plaintext, and re-running the job is idempotent
 *     on attachment `id` (no duplicate rows).
 *   - AC-330 / AT-144 — session invalidation + re-auth. The restore wipes
 *     `users`, CASCADE-dropping the operator's session mid-job; a status
 *     poll on the OLD cookie returns `401`; the `data_exchange_job` row
 *     survives with `created_by = NULL` (FK `ON DELETE SET NULL`); after
 *     re-auth, `GET /api/import-jobs` (latest) re-attaches to the same
 *     job. No bearer token anywhere in the flow.
 *   - AC-334 / AT-148 — the staging reaper sweeps an ABANDONED/terminal
 *     IMPORT upload (not just `ready` export artifacts), deleting the
 *     staged file and nulling `archiveRef`.
 *
 * SEEDING REAL CIPHERTEXT (AC-328): the export builder unwraps each ready
 * attachment's `wrappedDek` against the per-fork binary `age` identity,
 * fetches the ciphertext from object storage, and AES-256-GCM-decrypts —
 * so a fixture needs a real ciphertext object in storage AND a real
 * wrapped DEK on the row. `seedReadyAttachment` builds both inline (the
 * same helper shape as data-exchange-export-archive.test.ts): nonce(12)||
 * ct||tag(16) wire shape, uploaded to `originalKey`, DEK wrapped via the
 * production KeyEnvelopeService. The post-restore fidelity check runs that
 * decrypt path in reverse against the RESTORED row.
 *
 * STATUS: implemented + green. `routes/import-jobs.ts` +
 * `takeout-import-runner.ts` are wired in app.ts, and the staging reaper
 * sweeps `kind='import'` terminal/abandoned uploads. This file pins the
 * live contract: validate-before-wipe (zero destructive writes on a
 * corrupt/tampered/wrong-version archive), restore + server re-encrypt at
 * byte-equal fidelity, session invalidation + re-auth, and the reaper's
 * import leg.
 *
 * Confirmation phrase [C]: `EXPECTED_RESTORE_PHRASE` ('LOESCHEN').
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { unzipSync, zipSync } from 'fflate';
import sharp from 'sharp';
import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

import { startApp, stopApp, getApp, login, authGet, authPost } from '../../test/api-helpers.js';
import {
  SEED_DEFAULT_PASSWORD,
  SEED_USERS,
  EXPECTED_RESTORE_PHRASE,
} from '../../test/seedAssumptions.js';
import { createDatabase, type Database } from '../db/connection.js';
import { createStorageClient, type StorageClient } from '../storage/client.js';
import { KeyEnvelopeService } from '../services/KeyEnvelopeService.js';
import { stagedArtifactPath } from '../services/takeout-staging.js';
import { getEnv } from '../config/env.js';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
);

// ---------------------------------------------------------------------
// Job row wire shapes (camelCase, §5.18) — only the fields these arms read.
// ---------------------------------------------------------------------
interface JobRow {
  id: string;
  status: 'pending' | 'running' | 'ready' | 'failed';
  errorDetail: string | null;
}

const UPLOAD_OCTET_STREAM = 'application/offset+octet-stream';

const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;

// ---------------------------------------------------------------------
// Takeout staging reaper — contract surface (AC-334 / data-model §6.15).
// The module EXISTS (shipped with the export job, 8f40f1d) but today
// sweeps only `kind='export'`/`status='ready'`; it is resolved lazily via
// dynamic import for parity with the export-job test's resolver shape.
// This arm hits the prior red-state gate first (POST /api/import-jobs is
// unregistered → 404) and, once that lands, requires the reaper widened to
// also sweep `kind='import'` uploads on a terminal/abandoned job. Shape +
// the ttlMinutes injection convention match the export file exactly.
// ---------------------------------------------------------------------
type ReaperLogFn = (ctx: Record<string, unknown>, event: string) => void;

interface TakeoutStagingReaperOptions {
  db: Database;
  storage: StorageClient;
  logger: { info: ReaperLogFn; error: ReaperLogFn };
  ttlMinutes: number;
  now?: Date;
}

async function runTakeoutStagingReaper(opts: TakeoutStagingReaperOptions): Promise<void> {
  // Specifier held in a variable (not a literal) so `tsc` cannot statically
  // resolve — and thus cannot error on — a module that does not exist yet.
  const p = '../services/takeout-staging-reaper.js';
  const mod = (await import(/* @vite-ignore */ p)) as {
    runTakeoutStagingReaper: (opts: TakeoutStagingReaperOptions) => Promise<void>;
  };
  return mod.runTakeoutStagingReaper(opts);
}

function storageClient(): StorageClient {
  const env = getEnv();
  return createStorageClient({
    endpoint: env.STORAGE_ENDPOINT!,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY!,
    secretKey: env.STORAGE_SECRET_KEY!,
  });
}

describe('Import job — archive validation, restore fidelity, session, reaper', () => {
  let db: Database;
  let pool: pg.Pool;
  let storage: StorageClient;
  let identity: string;
  let recipient: string;
  let ownerToken: string;
  let projectId: string;

  // -------------------------------------------------------------------
  // Seed one `status='ready'` attachment with REAL backing ciphertext so
  // the export job decrypts and bundles it (and the restore re-creates
  // it). Mirrors data-exchange-export-archive.test.ts's helper. Returns
  // the row id + the original plaintext for the byte-equality check.
  // Raw-SQL attachment seeding is allowlisted under __tests__/ per the
  // AC-179 architecture check.
  // -------------------------------------------------------------------
  async function seedReadyAttachment(opts: {
    plaintext: Buffer;
    fileName: string;
    /** Default 'binary' (application/pdf); pass 'photo' to seed an image row. */
    kind?: 'photo' | 'binary';
    mimeType?: string;
    label?: string;
  }): Promise<{ id: string; plaintext: Buffer; fileName: string }> {
    const kind = opts.kind ?? 'binary';
    const label = opts.label ?? 'sonstiges';
    const mimeType = opts.mimeType ?? 'application/pdf';
    const id = crypto.randomUUID();
    const dek = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
    const body = Buffer.concat([cipher.update(opts.plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([nonce, body, tag]); // nonce(12)||ct||tag(16)

    const originalKey = `attachments/${projectId}/${id}.orig`;
    await storage.upload(originalKey, ciphertext, 'application/octet-stream');

    const svc = new KeyEnvelopeService({ recipient, identity });
    let wrapped: string;
    try {
      wrapped = Buffer.from(await svc.wrap(dek)).toString('base64');
    } finally {
      svc.close();
    }

    // Seeded WITHOUT a thumbnail (has_thumbnail FALSE, thumb columns null):
    // the export carries only originals (EnvelopeAttachment has no thumb), so
    // a thumbnail on the RESTORED row can only come from server-side regen.
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes, original_key, has_thumbnail,
         wrapped_dek, wrapped_dek_version)
      VALUES (${id}, ${projectId}, 'ready', ${kind}, ${label},
              ${opts.fileName}, ${mimeType}, ${opts.plaintext.length},
              ${ciphertext.length}, ${originalKey}, FALSE, ${wrapped}, 1)
    `);
    return { id, plaintext: opts.plaintext, fileName: opts.fileName };
  }

  /** Build a REAL takeout archive via the working export job; return its bytes. */
  async function buildExportArchive(token: string): Promise<Buffer> {
    const created = await authPost(token, '/api/export-jobs');
    expect(created.statusCode).toBe(201);
    const jobId = (created.json() as JobRow).id;

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let status = 'pending';
    while (Date.now() < deadline) {
      const res = await authGet(token, `/api/export-jobs/${jobId}`);
      expect(res.statusCode).toBe(200);
      status = (res.json() as JobRow).status;
      if (status === 'ready' || status === 'failed') break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    expect(status).toBe('ready');

    const dl = await authGet(token, `/api/export-jobs/${jobId}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('application/zip');
    return dl.rawPayload as Buffer;
  }

  // -------------------------------------------------------------------
  // Resumable-upload helpers (header + binary body + HEAD verb need raw
  // inject()). Identical to the protocol helpers in the sibling job file.
  // -------------------------------------------------------------------
  function createImportJob(
    token: string,
    uploadLength: number,
    body?: { override?: boolean; confirmation_phrase?: string },
  ) {
    return getApp().inject({
      method: 'POST',
      url: '/api/import-jobs',
      headers: {
        cookie: `session=${token}`,
        'upload-length': String(uploadLength),
        'content-type': 'application/json',
      },
      payload: body ?? {},
    });
  }

  function patchArchive(token: string, jobId: string, offset: number, chunk: Buffer) {
    return getApp().inject({
      method: 'PATCH',
      url: `/api/import-jobs/${jobId}/archive`,
      headers: {
        cookie: `session=${token}`,
        'upload-offset': String(offset),
        'content-type': UPLOAD_OCTET_STREAM,
      },
      payload: chunk,
    });
  }

  /**
   * Create an import job over the (non-empty) seeded target, then upload
   * `archive` in two chunks (exercising the multi-chunk append path). The
   * final chunk reaching Upload-Length transitions the job to `running`.
   * Returns the job id.
   */
  async function uploadArchiveToNewJob(token: string, archive: Buffer): Promise<string> {
    const created = await createImportJob(token, archive.length, {
      override: true,
      confirmation_phrase: EXPECTED_RESTORE_PHRASE,
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json() as JobRow).id;

    const mid = Math.floor(archive.length / 2);
    const r1 = await patchArchive(token, jobId, 0, archive.subarray(0, mid));
    expect(r1.headers['upload-offset']).toBe(String(mid));
    const r2 = await patchArchive(token, jobId, mid, archive.subarray(mid));
    expect(r2.headers['upload-offset']).toBe(String(archive.length));
    return jobId;
  }

  /** Poll an import job to a terminal status. */
  async function pollImportTerminal(token: string, jobId: string): Promise<JobRow> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let last: JobRow | null = null;
    while (Date.now() < deadline) {
      const res = await authGet(token, `/api/import-jobs/${jobId}`);
      expect(res.statusCode).toBe(200);
      last = res.json() as JobRow;
      if (last.status === 'ready' || last.status === 'failed') return last;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(
      `import job ${jobId} did not reach a terminal status within ${POLL_TIMEOUT_MS}ms ` +
        `(last status: ${last?.status ?? 'unknown'})`,
    );
  }

  /**
   * The restore wipes `users` partway through the (async) job, CASCADE-
   * dropping the upload session mid-job (AC-330). For an arm that must poll
   * to `ready`, the upload token therefore dies before the job finishes.
   * Mirror the spec's documented re-auth flow: poll the OLD token until it
   * 401s (the wipe committed), then re-authenticate against the restored
   * user set and return the fresh token. Falls back to a plain re-login if
   * no wipe is observed within the window (e.g. a validation failure that
   * never wipes), so the helper is safe on every path.
   */
  async function awaitWipeAndReauth(oldToken: string, jobId: string): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await authGet(oldToken, `/api/import-jobs/${jobId}`);
      if (res.statusCode === 401) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  }

  /** Count rows in an importable table (post-wipe assertions, AC-327). */
  async function countRows(table: string): Promise<number> {
    const res = await db.execute(sql.raw(`SELECT COUNT(*)::int AS c FROM ${table}`));
    return (res.rows[0] as { c: number }).c;
  }

  beforeAll(async () => {
    await startApp();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });

    storage = storageClient();

    recipient = process.env.BINARY_AGE_RECIPIENT!;
    const identityPath = process.env.BINARY_AGE_IDENTITY_PATH;
    if (!recipient || !identityPath) {
      throw new Error(
        'BINARY_AGE_RECIPIENT / BINARY_AGE_IDENTITY_PATH unset — per-fork ' +
          'identity is provisioned in src/test/integration-setup.ts',
      );
    }
    identity = readFileSync(identityPath, 'utf-8').trim();

    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    // Pin a concrete seeded project to seed attachments against.
    const pr = await authGet(ownerToken, '/api/projects?limit=200');
    const projects = (pr.json() as { data: { id: string }[] }).data;
    const project = projects[0];
    if (!project) throw new Error('seed produced no projects');
    projectId = project.id;
  });

  afterAll(async () => {
    await stopApp();
    await pool.end();
  });

  beforeEach(async () => {
    // No leftover jobs (one-active-per-kind determinism). The seed's
    // business data is the NON-EMPTY target the override roundtrip needs;
    // arms that seed attachments clean them first.
    await db.execute(sql`DELETE FROM data_exchange_job`);
    await db.execute(sql`DELETE FROM attachments`);
    // A prior arm's restore wipes `users` (dropping ownerToken's session);
    // re-authenticate so every arm starts from a live token regardless of
    // what ran before. The owner round-trips through the archive with its
    // passwordHash, so login succeeds against the restored user set.
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  // -------------------------------------------------------------------
  // AC-328 / AT-142 — restore + server re-encrypt + byte-equal roundtrip
  // + idempotency. The richest arm: a true seed → export → import → verify
  // loop. Encodes the FINAL fidelity contract; in the red state it fails
  // at `POST /api/import-jobs` (the export half + archive build succeed).
  // -------------------------------------------------------------------
  describe('AC-328: full roundtrip restores business rows + attachment bytes', () => {
    it('restores the attachment row (id/createdBy/createdAt preserved) at byte-equal plaintext', async () => {
      const plaintext = crypto.randomBytes(2048);
      const seeded = await seedReadyAttachment({ plaintext, fileName: 'angebot.pdf' });

      // Capture the source row's preserved fields for the post-restore
      // comparison (AC-328: id / createdBy / createdAt preserved).
      const srcRow = (
        await db.execute(sql`
          SELECT id, created_by, created_at FROM attachments WHERE id = ${seeded.id}
        `)
      ).rows[0] as { id: string; created_by: string | null; created_at: string };

      // Build a real archive carrying this attachment's plaintext.
      const archive = await buildExportArchive(ownerToken);
      // Sanity: the archive actually embeds the attachment (so a green
      // run is exercising the real restore path, not an empty archive).
      const entries = unzipSync(new Uint8Array(archive));
      const attachmentEntry = Object.keys(entries).find((k) =>
        k.includes(`${seeded.id}-angebot.pdf`),
      );
      expect(attachmentEntry, 'export archive lacks the seeded attachment').toBeDefined();

      // Upload it to an import job over the seeded (non-empty) target with
      // override + phrase, and drive to terminal.
      const jobId = await uploadArchiveToNewJob(ownerToken, archive);
      // The restore wipes `users` mid-job (dropping the upload session). Wait
      // for that (old cookie → 401), then re-auth and poll to ready (AC-330).
      const reauth = await awaitWipeAndReauth(ownerToken, jobId);
      const terminal = await pollImportTerminal(reauth, jobId);
      expect(terminal.status).toBe('ready');

      // The attachment row was re-created with its source id + preserved
      // audit fields (server re-encrypt is transparent to the row id).
      const restored = (
        await db.execute(sql`
          SELECT id, status, project_id, original_key, wrapped_dek, created_by, created_at
          FROM attachments WHERE id = ${seeded.id}
        `)
      ).rows as {
        id: string;
        status: string;
        project_id: string;
        original_key: string;
        wrapped_dek: string;
        created_by: string | null;
        created_at: string;
      }[];
      expect(restored.length).toBe(1);
      const row = restored[0]!;
      expect(row.status).toBe('ready');
      expect(row.created_by).toBe(srcRow.created_by);
      expect(new Date(row.created_at).getTime()).toBe(new Date(srcRow.created_at).getTime());

      // Byte-equal plaintext: the ciphertext at the restored key
      // AES-256-GCM-decrypts (via the row's freshly-wrapped DEK) to the
      // SOURCE plaintext. This is the re-encrypted-server-side proof —
      // a fresh DEK was wrapped under the instance recipient and the
      // ciphertext PUT to storage (AC-328).
      const dl = await storage.download(row.original_key);
      const ct = Buffer.from(dl.data);
      const svc = new KeyEnvelopeService({ recipient, identity });
      let dek: Buffer;
      try {
        dek = Buffer.from(await svc.unwrap(Buffer.from(row.wrapped_dek, 'base64')));
      } finally {
        svc.close();
      }
      const ctNonce = ct.subarray(0, 12);
      const ctTag = ct.subarray(ct.length - 16);
      const ctBody = ct.subarray(12, ct.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', dek, ctNonce);
      decipher.setAuthTag(ctTag);
      const recovered = Buffer.concat([decipher.update(ctBody), decipher.final()]);
      expect(Buffer.compare(recovered, plaintext)).toBe(0);
    });

    it('re-running the same import job is idempotent on attachment id (no duplicate rows)', async () => {
      const plaintext = crypto.randomBytes(1024);
      const seeded = await seedReadyAttachment({ plaintext, fileName: 'rechnung.pdf' });
      const archive = await buildExportArchive(ownerToken);

      // First import. Wait for the mid-job wipe, then re-auth before polling.
      const job1 = await uploadArchiveToNewJob(ownerToken, archive);
      let token = await awaitWipeAndReauth(ownerToken, job1);
      expect((await pollImportTerminal(token, job1)).status).toBe('ready');

      // Second import of the SAME archive. Each override import wipes
      // `attachments` then rebuilds from the archive, so the row count for
      // that id stays exactly 1 — operation-level idempotency (a re-run is a
      // deterministic full replace). The wipe prevents duplication, not a
      // per-row skip (AC-328).
      const job2 = await uploadArchiveToNewJob(token, archive);
      token = await awaitWipeAndReauth(token, job2);
      expect((await pollImportTerminal(token, job2)).status).toBe('ready');

      const dup = (
        await db.execute(sql`SELECT COUNT(*)::int AS c FROM attachments WHERE id = ${seeded.id}`)
      ).rows[0] as { c: number };
      expect(dup.c).toBe(1);
    });

    it('restores business rows with IDs preserved (project id round-trips)', async () => {
      // The project we seeded the attachment against must survive the
      // wipe-and-restore with the SAME id (AC-254 IDs-preserved, the
      // business-data leg of AC-328).
      const plaintext = crypto.randomBytes(256);
      await seedReadyAttachment({ plaintext, fileName: 'foto.jpg' });
      const archive = await buildExportArchive(ownerToken);

      const jobId = await uploadArchiveToNewJob(ownerToken, archive);
      const token = await awaitWipeAndReauth(ownerToken, jobId);
      expect((await pollImportTerminal(token, jobId)).status).toBe('ready');

      const proj = (await db.execute(sql`SELECT id FROM projects WHERE id = ${projectId}`))
        .rows as { id: string }[];
      expect(proj.length).toBe(1);
      expect(proj[0]!.id).toBe(projectId);
    });

    it('regenerates a WebP thumbnail for a restored photo and captures version-ids', async () => {
      // A REAL, decodable JPEG (random bytes would not decode) so the server
      // can derive a thumbnail from the restored original. 800×600 keeps the
      // longest edge above the 320px thumb target so the resize is exercised.
      const photo = await sharp({
        create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 90, b: 160 } },
      })
        .jpeg()
        .toBuffer();

      // Seeded as a PHOTO with NO source thumbnail — the export bundles only
      // the original, so a thumbnail on the restored row proves SERVER-SIDE
      // regeneration on import, not a carried-over blob.
      const seeded = await seedReadyAttachment({
        plaintext: photo,
        fileName: 'baustelle.jpg',
        kind: 'photo',
        mimeType: 'image/jpeg',
        label: 'foto',
      });

      const archive = await buildExportArchive(ownerToken);
      const jobId = await uploadArchiveToNewJob(ownerToken, archive);
      const reauth = await awaitWipeAndReauth(ownerToken, jobId);
      expect((await pollImportTerminal(reauth, jobId)).status).toBe('ready');

      const row = (
        await db.execute(sql`
          SELECT kind, has_thumbnail, thumb_key, wrapped_thumb_dek,
                 ciphertext_thumb_size_bytes, version_id, thumb_version_id
          FROM attachments WHERE id = ${seeded.id}
        `)
      ).rows[0] as {
        kind: string;
        has_thumbnail: boolean;
        thumb_key: string | null;
        wrapped_thumb_dek: string | null;
        // bigint over raw db.execute → string
        ciphertext_thumb_size_bytes: string | null;
        version_id: string | null;
        thumb_version_id: string | null;
      };

      // The restored photo carries a regenerated thumbnail at the conventional
      // `.thumb` key with its own wrapped DEK + ciphertext size.
      expect(row.kind).toBe('photo');
      expect(row.has_thumbnail).toBe(true);
      expect(row.thumb_key).toBe(`attachments/${projectId}/${seeded.id}.thumb`);
      expect(row.wrapped_thumb_dek).toBeTruthy();
      // bigint columns come back from raw db.execute as strings — coerce.
      expect(Number(row.ciphertext_thumb_size_bytes ?? 0)).toBeGreaterThan(0);

      // Version-id capture (server-side PUT into the versioned bucket): both
      // ids are non-null so a later hide → restore can copyFromVersion. Without
      // the capture an imported attachment is un-restorable from the Papierkorb
      // (AttachmentService restore throws restoreMissingVersionId).
      expect(row.version_id ?? '').toMatch(/.+/);
      expect(row.thumb_version_id ?? '').toMatch(/.+/);

      // The thumb ciphertext decrypts (via the freshly-wrapped thumb DEK) to a
      // real, decodable WebP no larger than the configured longest edge (320).
      const dl = await storage.download(row.thumb_key!);
      const ct = Buffer.from(dl.data);
      const svc = new KeyEnvelopeService({ recipient, identity });
      let thumbDek: Buffer;
      try {
        thumbDek = Buffer.from(await svc.unwrap(Buffer.from(row.wrapped_thumb_dek!, 'base64')));
      } finally {
        svc.close();
      }
      const tNonce = ct.subarray(0, 12);
      const tTag = ct.subarray(ct.length - 16);
      const tBody = ct.subarray(12, ct.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', thumbDek, tNonce);
      decipher.setAuthTag(tTag);
      const thumbPlain = Buffer.concat([decipher.update(tBody), decipher.final()]);

      const meta = await sharp(thumbPlain).metadata();
      expect(meta.format).toBe('webp');
      const longestEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
      expect(longestEdge).toBeGreaterThan(0);
      expect(longestEdge).toBeLessThanOrEqual(320);
    });
  });

  // -------------------------------------------------------------------
  // AC-220 — ROUND-TRIP COVERAGE. The two-cycle e2e round proves the
  // export is a FIXED POINT; it cannot prove the export is COMPLETE. A
  // table inside the wipe set but absent from the envelope round-trips
  // perfectly while losing every row it held, and no existing arm can
  // see it — which is precisely how the Papierkorb purge (#392) went
  // unnoticed. So: enumerate the LIVE schema and require every table to
  // either survive a real export→import or sit on an exemption list with
  // a written reason. A new table added without a decision fails here.
  // -------------------------------------------------------------------
  describe('AC-220: a full round trip loses no table (schema-drift tripwire)', () => {
    /**
     * Tables a restore is allowed to shrink, each with the reason it is
     * allowed. This list is the decision record — adding a table to the
     * schema without either exporting it or naming it here fails the arm
     * below, so the choice cannot be made by omission.
     */
    const MAY_SHRINK: Record<string, string> = {
      sessions: 'ephemeral auth state — the wipe CASCADEs it and the operator re-authenticates',
      push_subscriptions:
        'device- and VAPID-bound; a restored endpoint would be dead on any other instance',
      attachments:
        'the `hidden` (Papierkorb) rows deliberately do not travel — AC-220; the `ready` rows are pinned by the next arm',
    };

    /** Every base table in the live `public` schema. */
    async function publicTables(): Promise<string[]> {
      const res = await db.execute(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      return (res.rows as { table_name: string }[]).map((r) => r.table_name);
    }

    async function rowCounts(tables: string[]): Promise<Record<string, number>> {
      const counts: Record<string, number> = {};
      for (const t of tables) counts[t] = await countRows(t);
      return counts;
    }

    /** Seed a `ready` row and soft-hide it — a Papierkorb item. */
    async function seedHiddenAttachment(fileName: string): Promise<string> {
      const seeded = await seedReadyAttachment({
        plaintext: crypto.randomBytes(256),
        fileName,
      });
      await db.execute(
        sql`UPDATE attachments SET status = 'hidden', hidden_at = now() WHERE id = ${seeded.id}`,
      );
      return seeded.id;
    }

    /** seed → export → import(override) → re-auth; returns the fresh token. */
    async function fullRoundTrip(): Promise<string> {
      const archive = await buildExportArchive(ownerToken);
      const jobId = await uploadArchiveToNewJob(ownerToken, archive);
      const freshToken = await awaitWipeAndReauth(ownerToken, jobId);
      const job = await pollImportTerminal(freshToken, jobId);
      expect(job.status, `import failed: ${job.errorDetail ?? ''}`).toBe('ready');
      return freshToken;
    }

    it('every table either round-trips or is on the documented shrink list', async () => {
      await seedReadyAttachment({ plaintext: crypto.randomBytes(512), fileName: 'keep.pdf' });
      await seedHiddenAttachment('im-papierkorb.pdf');

      const tables = await publicTables();
      // A stale exemption is as bad as a missing one: a renamed table would
      // leave its old name here, silently excusing the new one from nothing.
      for (const exempt of Object.keys(MAY_SHRINK)) {
        expect(tables, `MAY_SHRINK names "${exempt}", which is not a table`).toContain(exempt);
      }

      const before = await rowCounts(tables);
      await fullRoundTrip();
      const after = await rowCounts(tables);

      for (const table of tables) {
        if (table in MAY_SHRINK) continue;
        expect(
          after[table],
          `table "${table}" lost rows across a full export→import ` +
            `(${before[table]} → ${after[table]}). Either it belongs in the export ` +
            `envelope, or it belongs in MAY_SHRINK with a reason.`,
        ).toBeGreaterThanOrEqual(before[table]!);
      }
    });

    it('the restore purges the Papierkorb and keeps every ready attachment (AC-220)', async () => {
      const kept = await seedReadyAttachment({
        plaintext: crypto.randomBytes(512),
        fileName: 'behalten.pdf',
      });
      const trashed = await seedHiddenAttachment('geloescht.pdf');

      await fullRoundTrip();

      const rows = (await db.execute(sql`SELECT id, status FROM attachments ORDER BY id`)).rows as {
        id: string;
        status: string;
      }[];
      const byId = new Map(rows.map((r) => [r.id, r.status]));

      // The live row travels and comes back `ready`.
      expect(byId.get(kept.id)).toBe('ready');
      // The Papierkorb row does not — the envelope never carried it and the
      // wipe removed it. This is the decided behaviour (a takeout carries the
      // live working set, not a TTL-bounded undo buffer), surfaced to the
      // operator on both dialog legs so it is never a surprise.
      expect(byId.has(trashed)).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // AC-327 / AT-141 — validate before wipe. Corrupt a REAL roundtrip
  // archive (break data.json's schema_version; sibling arm: break a
  // manifest sha256), import into the NON-EMPTY seeded target with
  // override + phrase, and assert the job → `failed` with `error_detail`
  // AND the pre-existing target rows are UNTOUCHED (no wipe ran).
  // -------------------------------------------------------------------
  describe('AC-327: a corrupt/wrong-version archive fails the job WITHOUT wiping', () => {
    /** Re-zip an archive after applying `mutate` to its decoded entries. */
    function remuxArchive(
      archive: Buffer,
      mutate: (entries: Record<string, Uint8Array>) => void,
    ): Buffer {
      const entries = unzipSync(new Uint8Array(archive));
      mutate(entries);
      return Buffer.from(zipSync(entries));
    }

    it('a wrong schema_version in data.json → job failed, error_detail set, target untouched', async () => {
      await seedReadyAttachment({ plaintext: crypto.randomBytes(512), fileName: 'a.pdf' });
      const archive = await buildExportArchive(ownerToken);

      // Baseline counts BEFORE the import — the wipe must not touch these.
      const before = {
        customers: await countRows('customers'),
        projects: await countRows('projects'),
        users: await countRows('users'),
      };
      expect(before.projects).toBeGreaterThan(0); // the seed left a non-empty target

      // Corrupt data.json: bump schema_version to an impossible value so
      // the validate-before-wipe gate fails (SCHEMA_VERSION_MISMATCH).
      const corrupt = remuxArchive(archive, (entries) => {
        const env = JSON.parse(Buffer.from(entries['data.json']!).toString('utf-8'));
        env.schema_version = 999999;
        entries['data.json'] = new Uint8Array(Buffer.from(JSON.stringify(env)));
      });

      const jobId = await uploadArchiveToNewJob(ownerToken, corrupt);
      const terminal = await pollImportTerminal(ownerToken, jobId);
      expect(terminal.status).toBe('failed');
      expect(terminal.errorDetail).toBeTruthy();

      // ZERO writes: the target counts are unchanged — the destructive
      // wipe never ran on a wrong-version archive (AC-327). The owner's
      // session is also still valid (no users wipe), so the SAME token
      // still works.
      expect(await countRows('customers')).toBe(before.customers);
      expect(await countRows('projects')).toBe(before.projects);
      expect(await countRows('users')).toBe(before.users);
      const stillAuthed = await authGet(ownerToken, '/api/import-jobs');
      expect(stillAuthed.statusCode).toBe(200);
    });

    it('a tampered manifest sha256 → job failed, error_detail set, target untouched', async () => {
      await seedReadyAttachment({ plaintext: crypto.randomBytes(512), fileName: 'b.pdf' });
      const archive = await buildExportArchive(ownerToken);

      const before = {
        customers: await countRows('customers'),
        projects: await countRows('projects'),
      };

      // Corrupt manifest.json: flip the first file's sha256 so per-entry
      // integrity verification fails (manifest coverage / sha256 check,
      // AC-327) before any write.
      const corrupt = remuxArchive(archive, (entries) => {
        const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf-8')) as {
          files: { sha256: string }[];
        };
        expect(manifest.files.length).toBeGreaterThan(0);
        manifest.files[0]!.sha256 = '0'.repeat(64); // valid hex shape, wrong digest
        entries['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
      });

      const jobId = await uploadArchiveToNewJob(ownerToken, corrupt);
      const terminal = await pollImportTerminal(ownerToken, jobId);
      expect(terminal.status).toBe('failed');
      expect(terminal.errorDetail).toBeTruthy();

      expect(await countRows('customers')).toBe(before.customers);
      expect(await countRows('projects')).toBe(before.projects);
    });

    it('an attachment mimeType outside the CHECK enum → job failed at Pass-1, target untouched', async () => {
      // Regression: Pass-1 must reject an attachment whose kind/label/
      // mimeType is outside the `attachments` CHECK enums. Without that
      // gate the value survives validation, the wipe commits, and the
      // Pass-2 insert trips the DB constraint AFTER the destructive
      // restore — leaving the target truncated (AC-327 violation).
      await seedReadyAttachment({ plaintext: crypto.randomBytes(512), fileName: 'evil.pdf' });
      const archive = await buildExportArchive(ownerToken);

      const before = {
        customers: await countRows('customers'),
        projects: await countRows('projects'),
        users: await countRows('users'),
        attachments: await countRows('attachments'),
      };
      expect(before.attachments).toBeGreaterThan(0); // the seed left an attachment to tamper

      // Tamper data.json: flip the first attachment's mimeType to a value
      // outside the whitelist. Because data.json's own digest is pinned in
      // the manifest, we re-stamp that entry so the integrity gate passes
      // and the run reaches the enum check (otherwise this would merely
      // re-prove the sha256 path).
      const corrupt = remuxArchive(archive, (entries) => {
        const env = JSON.parse(Buffer.from(entries['data.json']!).toString('utf-8')) as {
          attachments: { mimeType: string }[];
        };
        expect(env.attachments.length).toBeGreaterThan(0);
        env.attachments[0]!.mimeType = 'application/x-tampered';
        const repacked = Buffer.from(JSON.stringify(env));
        entries['data.json'] = new Uint8Array(repacked);

        const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf-8')) as {
          files: { zipPath: string; sha256: string }[];
        };
        const dataEntry = manifest.files.find((f) => f.zipPath === 'data.json');
        expect(dataEntry).toBeDefined();
        dataEntry!.sha256 = crypto.createHash('sha256').update(repacked).digest('hex');
        entries['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
      });

      const jobId = await uploadArchiveToNewJob(ownerToken, corrupt);
      const terminal = await pollImportTerminal(ownerToken, jobId);
      expect(terminal.status).toBe('failed');
      // The failure is the enum gate specifically — not an incidental
      // integrity trip — so the message names the invalid enum value.
      expect(terminal.errorDetail).toContain('invalid enum value');

      // ZERO writes: the wipe never ran (AC-327). Counts unchanged and the
      // owner's session still works (no users wipe).
      expect(await countRows('customers')).toBe(before.customers);
      expect(await countRows('projects')).toBe(before.projects);
      expect(await countRows('users')).toBe(before.users);
      expect(await countRows('attachments')).toBe(before.attachments);
      const stillAuthed = await authGet(ownerToken, '/api/import-jobs');
      expect(stillAuthed.statusCode).toBe(200);
    });

    it('an attachment fileName with a path separator → job failed at Pass-1, target untouched', async () => {
      // Parity with the upload-path `isSafeFileName` guard: the import
      // path must not persist a fileName (path separator / control char)
      // the upload path would reject. Like the enum gate, this fails in
      // Pass-1 before the destructive wipe (AC-327).
      await seedReadyAttachment({ plaintext: crypto.randomBytes(512), fileName: 'ok.pdf' });
      const archive = await buildExportArchive(ownerToken);

      const before = {
        projects: await countRows('projects'),
        attachments: await countRows('attachments'),
      };
      expect(before.attachments).toBeGreaterThan(0);

      // Tamper data.json with a traversal-style fileName, re-stamping the
      // manifest digest so the run reaches the fileName-safety check.
      const corrupt = remuxArchive(archive, (entries) => {
        const env = JSON.parse(Buffer.from(entries['data.json']!).toString('utf-8')) as {
          attachments: { fileName: string }[];
        };
        expect(env.attachments.length).toBeGreaterThan(0);
        env.attachments[0]!.fileName = '../../etc/passwd';
        const repacked = Buffer.from(JSON.stringify(env));
        entries['data.json'] = new Uint8Array(repacked);

        const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf-8')) as {
          files: { zipPath: string; sha256: string }[];
        };
        const dataEntry = manifest.files.find((f) => f.zipPath === 'data.json');
        expect(dataEntry).toBeDefined();
        dataEntry!.sha256 = crypto.createHash('sha256').update(repacked).digest('hex');
        entries['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
      });

      const jobId = await uploadArchiveToNewJob(ownerToken, corrupt);
      const terminal = await pollImportTerminal(ownerToken, jobId);
      expect(terminal.status).toBe('failed');
      expect(terminal.errorDetail).toContain('unsafe fileName');

      expect(await countRows('projects')).toBe(before.projects);
      expect(await countRows('attachments')).toBe(before.attachments);
    });

    it('two manifest entries sharing a zipPath → job failed at Pass-1, target untouched', async () => {
      // The import-side twin of #387. Pass 2 matches an archive entry back
      // to its row through `zipPath → attachmentId`, so two ids pointing at
      // one path collapse into a single insert and the loser is restored
      // NOWHERE. Attachment-id uniqueness does not catch it (both ids are
      // distinct) and envelope↔manifest parity still holds (both ids are
      // still listed), so without this gate the job wipes the target,
      // restores N-1 of N attachments, and reports `ready` — the operator
      // learns their restore was short only at the next restore.
      await seedReadyAttachment({ plaintext: crypto.randomBytes(512), fileName: 'one.pdf' });
      await seedReadyAttachment({ plaintext: crypto.randomBytes(512), fileName: 'two.pdf' });
      const archive = await buildExportArchive(ownerToken);

      const before = {
        projects: await countRows('projects'),
        attachments: await countRows('attachments'),
      };
      expect(before.attachments).toBe(2);

      // Point the second attachment entry at the first one's path + digest.
      // Both entries now verify against a real archive entry, so the run
      // reaches the uniqueness gate rather than tripping the sha256 check.
      const corrupt = remuxArchive(archive, (entries) => {
        const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf-8')) as {
          files: { zipPath: string; sha256: string; attachmentId?: string }[];
        };
        const attachmentFiles = manifest.files.filter((f) => f.attachmentId);
        expect(attachmentFiles.length).toBe(2);
        attachmentFiles[1]!.zipPath = attachmentFiles[0]!.zipPath;
        attachmentFiles[1]!.sha256 = attachmentFiles[0]!.sha256;
        entries['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
      });

      const jobId = await uploadArchiveToNewJob(ownerToken, corrupt);
      const terminal = await pollImportTerminal(ownerToken, jobId);
      expect(terminal.status).toBe('failed');
      expect(terminal.errorDetail).toContain('duplicate zipPath');

      // ZERO destructive writes — the wipe never ran (AC-327).
      expect(await countRows('projects')).toBe(before.projects);
      expect(await countRows('attachments')).toBe(before.attachments);
    });
  });

  // -------------------------------------------------------------------
  // AC-330 / AT-144 — session invalidation + re-auth.
  // -------------------------------------------------------------------
  describe('AC-330: users wipe drops the session mid-job; the job row survives', () => {
    it('old cookie polls 401, job row gets created_by=NULL, re-auth re-attaches via latest', async () => {
      await seedReadyAttachment({ plaintext: crypto.randomBytes(256), fileName: 'c.pdf' });
      const archive = await buildExportArchive(ownerToken);

      // The owner's token BEFORE the wipe. After the restore wipes `users`,
      // this session is CASCADE-dropped.
      const preWipeToken = ownerToken;
      const jobId = await uploadArchiveToNewJob(preWipeToken, archive);

      // A status poll on the OLD cookie returns 401 once the wipe lands.
      // Poll until the cookie is rejected (or time out — red-state failure).
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let got401 = false;
      while (Date.now() < deadline) {
        const res = await authGet(preWipeToken, `/api/import-jobs/${jobId}`);
        if (res.statusCode === 401) {
          got401 = true;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      expect(got401, 'old session cookie was never invalidated by the users wipe').toBe(true);

      // The job row survives the users wipe — created_by is SET NULL (FK
      // ON DELETE SET NULL, data-model.md §5.18), NOT cascade-deleted.
      const survived = (
        await db.execute(sql`SELECT id, created_by FROM data_exchange_job WHERE id = ${jobId}`)
      ).rows as { id: string; created_by: string | null }[];
      expect(survived.length).toBe(1);
      expect(survived[0]!.created_by).toBeNull();

      // After re-authenticating, GET /api/import-jobs (latest) re-attaches
      // to the same job so the operator resumes polling to completion.
      const reauth = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      const latest = await authGet(reauth, '/api/import-jobs');
      expect(latest.statusCode).toBe(200);
      expect((latest.json() as { job: JobRow | null }).job?.id).toBe(jobId);

      const terminal = await pollImportTerminal(reauth, jobId);
      expect(terminal.status).toBe('ready');

      // Restore the standard owner token for any later arm.
      ownerToken = reauth;
    });
  });

  // -------------------------------------------------------------------
  // AC-334 / AT-148 — the staging reaper sweeps an abandoned/terminal
  // IMPORT upload too (not just ready export artifacts). data-model §6.15:
  // it sweeps an import job's uploaded archive once the job is terminal
  // (ready/failed) or its upload was abandoned, deletes the staged FILE,
  // and nulls archiveRef.
  //
  // ttlMinutes is injected directly (the shape data-exchange-export-job's
  // reaper arm uses) — pinning the OBSERVABLE contract (aged import upload
  // swept → archiveRef nulled → staged file gone), not the env wiring.
  // -------------------------------------------------------------------
  describe('AC-334: staging reaper sweeps an aged import upload', () => {
    it('an aged terminal import upload is swept: staged file deleted, archiveRef nulled', async () => {
      const ttlMinutes = 1440; // §12.2 default (24h) in the _MINUTES unit

      await seedReadyAttachment({ plaintext: crypto.randomBytes(256), fileName: 'd.pdf' });
      const archive = await buildExportArchive(ownerToken);
      const jobId = await uploadArchiveToNewJob(ownerToken, archive);
      const reauth = await awaitWipeAndReauth(ownerToken, jobId);
      const terminal = await pollImportTerminal(reauth, jobId);
      // A terminal import job retains its uploaded archive on the VPS
      // staging path until the reaper sweeps it. The staged path is derivable
      // from (kind, id) — the route no longer echoes archiveRef on the wire
      // (Finding F1) — so assert the on-disk staged file directly.
      expect(terminal.status).toBe('ready');
      const stagedPath = stagedArtifactPath(getEnv().TAKEOUT_STAGING_DIR, 'import', jobId);
      expect(existsSync(stagedPath)).toBe(true);

      // Backdate finishedAt well past the TTL so the reaper's age
      // predicate selects this row, then run the reaper with now=real time.
      await db.execute(sql`
        UPDATE data_exchange_job
        SET finished_at = ${new Date(Date.now() - (ttlMinutes + 60) * 60 * 1000).toISOString()}
        WHERE id = ${jobId}
      `);

      await runTakeoutStagingReaper({
        db,
        storage: storageClient(),
        logger: { info: vi.fn(), error: vi.fn() },
        ttlMinutes,
        now: new Date(),
      });

      // The reaper deletes the staged file and nulls archiveRef; the row
      // persists as operational metadata (data-model.md §6.15). Assert the
      // staged file is gone on disk AND the column was nulled (a direct-DB
      // read, not a wire field).
      expect(existsSync(stagedPath)).toBe(false);
      const row = (
        await db.execute(sql`SELECT archive_ref FROM data_exchange_job WHERE id = ${jobId}`)
      ).rows as { archive_ref: string | null }[];
      expect(row.length).toBe(1);
      expect(row[0]!.archive_ref).toBeNull();

      ownerToken = reauth;
    });
  });
});
