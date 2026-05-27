/**
 * API integration tests — export-job ARCHIVE layout, manifest, and
 * per-row resilience (TDD red).
 *
 * Drives a server-side full-account EXPORT job (api.md §14.2.4 "Export
 * job — archive layout + manifest" / "build and lifecycle") to `ready`,
 * downloads the staged zip, unzips it, and pins:
 *
 *   - AC-323 / AT-137 — the archive is a zip carrying `data.json` (the
 *     AC-135 envelope; first manifest entry; no attachmentId) and
 *     `manifest.json` at root, plus every `status='ready'` attachment as
 *     PLAINTEXT under `attachments/<projektnummer>-<projekt-titel>/
 *     <attachment-id>-<dateiname>` (components sanitised per AC-245).
 *     `manifest.json` = { manifestVersion:1, exportedAt, totalFiles,
 *     totalBytes, files:[{ zipPath, sizeBytes, sha256, attachmentId? }] },
 *     server-computed, EXCLUDES itself, totalFiles === files.length,
 *     totalBytes === sum(sizeBytes), every files[i].sha256 === SHA-256 of
 *     the bytes at its zipPath, and the attachment plaintext byte-equals
 *     what was uploaded.
 *   - AC-325 / AT-139 — an attachment whose wrapped DEK is corrupt
 *     (unwrap fails) is SKIPPED: the build still reaches `ready`,
 *     filesDone reflects the skip, the manifest omits the bad row, and
 *     the surviving rows land in the archive.
 *
 * SEEDING REAL CIPHERTEXT: the build unwraps each row's `wrappedDek`
 * against the per-fork binary `age` identity, fetches the ciphertext from
 * object storage, and AES-256-GCM-decrypts it. So a `ready` fixture needs
 * (1) a real ciphertext object in MinIO and (2) a real wrapped DEK on the
 * row. `seedReadyAttachment` below builds both inline: it picks a fresh
 * 32-byte DEK, encrypts the chosen plaintext into the `nonce(12)||ct||
 * tag(16)` wire shape (mirrors src/server/services/invoice/payloadCrypto.ts
 * and src/domain/clientEncryption.ts), uploads that to `originalKey` with
 * the ADR-0024 sentinel content-type, wraps the DEK via the production
 * KeyEnvelopeService, and inserts the row. The corrupt-DEK fixture reuses
 * the same path but overwrites `wrappedDek` with bytes that fail to unwrap.
 *
 * This file deliberately does NOT import data-exchange-export-all.ts's
 * `seedReadyAttachments` (that file is scheduled for retirement, and its
 * helper seeds the row WITHOUT real backing bytes — it would never
 * decrypt). Raw-SQL attachment seeding is allowlisted under __tests__/
 * per the AC-179 architecture check.
 *
 * RED-STATE EXPECTATION: `/api/export-jobs*` is not registered and no
 * runner exists, so `POST` 404s at the not-found handler and the poll
 * helper times out; every arm fails before the unzip. The assertions
 * encode the FINAL intended archive contract so they go green once the
 * feature lands.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase, type Database } from '../db/connection.js';
import { createStorageClient, type StorageClient } from '../storage/client.js';
import { KeyEnvelopeService } from '../services/KeyEnvelopeService.js';
import { getEnv } from '../config/env.js';

// ---------------------------------------------------------------------
// Job row wire shape — the subset this file reads (camelCase, §5.18).
// ---------------------------------------------------------------------
interface ExportJobRow {
  id: string;
  status: 'pending' | 'running' | 'ready' | 'failed';
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
}

// ---------------------------------------------------------------------
// Manifest wire shape — api.md §14.2.4 / AC-323.
// ---------------------------------------------------------------------
interface ManifestFile {
  zipPath: string;
  sizeBytes: number;
  sha256: string;
  attachmentId?: string;
}
interface Manifest {
  manifestVersion: number;
  exportedAt: string;
  totalFiles: number;
  totalBytes: number;
  files: ManifestFile[];
}

const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

async function pollUntilTerminal(token: string, jobId: string): Promise<ExportJobRow> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: ExportJobRow | null = null;
  while (Date.now() < deadline) {
    const res = await authGet(token, `/api/export-jobs/${jobId}`);
    expect(res.statusCode).toBe(200);
    last = res.json() as ExportJobRow;
    if (last.status === 'ready' || last.status === 'failed') return last;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `export job ${jobId} did not reach a terminal status within ${POLL_TIMEOUT_MS}ms ` +
      `(last status: ${last?.status ?? 'unknown'})`,
  );
}

/** Drive a job to `ready` and return the unzipped (entry → bytes) map + parsed manifest. */
async function buildAndUnzip(
  token: string,
): Promise<{ entries: Map<string, Buffer>; manifest: Manifest; job: ExportJobRow }> {
  const created = await authPost(token, '/api/export-jobs');
  expect(created.statusCode).toBe(201);
  const job = await pollUntilTerminal(token, (created.json() as ExportJobRow).id);
  expect(job.status).toBe('ready');

  const dl = await authGet(token, `/api/export-jobs/${job.id}/download`);
  expect(dl.statusCode).toBe(200);
  expect(dl.headers['content-type']).toContain('application/zip');

  const decoded = unzipSync(new Uint8Array(dl.rawPayload as Buffer));
  const entries = new Map<string, Buffer>();
  for (const [name, bytes] of Object.entries(decoded)) {
    entries.set(name, Buffer.from(bytes));
  }

  const manifestBuf = entries.get('manifest.json');
  if (!manifestBuf) throw new Error('manifest.json missing from archive');
  const manifest = JSON.parse(manifestBuf.toString('utf-8')) as Manifest;
  return { entries, manifest, job };
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('Export-job archive — layout, manifest, per-row resilience', () => {
  let db: Database;
  let pool: import('pg').Pool;
  let storage: StorageClient;
  let identity: string;
  let recipient: string;
  let ownerToken: string;
  let projectId: string;
  let projectNumber: string;

  /**
   * Seed one `status='ready'` attachment with REAL backing ciphertext.
   * Returns the row id, the original plaintext (for byte-equality), and
   * the row's filename. When `corruptDek` is set the persisted
   * `wrappedDek` is replaced with bytes that fail to unwrap (AC-325).
   */
  async function seedReadyAttachment(opts: {
    plaintext: Buffer;
    fileName: string;
    mimeType?: string;
    corruptDek?: boolean;
  }): Promise<{ id: string; plaintext: Buffer; fileName: string }> {
    const id = crypto.randomUUID();
    const dek = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
    const body = Buffer.concat([cipher.update(opts.plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([nonce, body, tag]); // nonce(12)||ct||tag(16)

    const originalKey = `attachments/${projectId}/${id}.orig`;
    await storage.upload(originalKey, ciphertext, 'application/octet-stream');

    let wrapped: string;
    if (opts.corruptDek) {
      // A structurally-bogus envelope: random bytes that are not a valid
      // age envelope, so the build's unwrap throws and the row is skipped.
      // Non-null so the `ready`-row CHECK (must carry a wrapped DEK) holds.
      wrapped = crypto.randomBytes(192).toString('base64');
    } else {
      const svc = new KeyEnvelopeService({ recipient, identity });
      try {
        wrapped = Buffer.from(await svc.wrap(dek)).toString('base64');
      } finally {
        svc.close();
      }
    }

    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes, original_key, has_thumbnail,
         wrapped_dek, wrapped_dek_version)
      VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges',
              ${opts.fileName}, ${opts.mimeType ?? 'application/pdf'},
              ${opts.plaintext.length}, ${ciphertext.length},
              ${originalKey}, FALSE, ${wrapped}, 1)
    `);
    return { id, plaintext: opts.plaintext, fileName: opts.fileName };
  }

  beforeAll(async () => {
    await startApp();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');

    const env = getEnv();
    storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
    });

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

    // Pin a concrete project to seed attachments against — its
    // (number, title) drives the archive's `attachments/<number>-<title>/`
    // path, asserted below.
    const pr = await authGet(ownerToken, '/api/projects?limit=200');
    const projects = (pr.json() as { data: { id: string; number: string; title: string }[] }).data;
    const project = projects[0];
    if (!project) throw new Error('seed produced no projects');
    projectId = project.id;
    projectNumber = project.number;
  });

  afterAll(async () => {
    await stopApp();
    await pool.end();
  });

  beforeEach(async () => {
    // Reset attachment rows + any prior export job so each arm seeds a
    // deterministic set and re-creates a single active job.
    await db.execute(sql`DELETE FROM attachments`);
    await db.execute(sql`DELETE FROM data_exchange_job`);
  });

  // -------------------------------------------------------------------
  // AC-323 / AT-137 — archive layout + server-computed manifest.
  // -------------------------------------------------------------------
  describe('AC-323: archive layout + manifest', () => {
    it('carries data.json + manifest.json at root, with data.json the first manifest entry', async () => {
      await seedReadyAttachment({ plaintext: Buffer.from('hello world'), fileName: 'brief.pdf' });

      const { entries, manifest } = await buildAndUnzip(ownerToken);

      expect(entries.has('data.json')).toBe(true);
      expect(entries.has('manifest.json')).toBe(true);

      // data.json is the FIRST manifest entry and carries no attachmentId.
      expect(manifest.files.length).toBeGreaterThan(0);
      expect(manifest.files[0]!.zipPath).toBe('data.json');
      expect(manifest.files[0]!.attachmentId).toBeUndefined();

      // data.json parses to the AC-135 export envelope (schema_version
      // present, business-data slots present). Full envelope shape is
      // pinned by data-exchange-export-envelope.test.ts; here we just
      // confirm the archive embeds the real envelope, not a stub.
      const envelope = JSON.parse(entries.get('data.json')!.toString('utf-8')) as {
        schema_version: number;
        users: unknown[];
        projects: unknown[];
        attachments: unknown[];
      };
      expect(typeof envelope.schema_version).toBe('number');
      expect(Array.isArray(envelope.users)).toBe(true);
      expect(Array.isArray(envelope.projects)).toBe(true);
    });

    it('manifest excludes itself and is internally consistent (totals + per-entry sha256)', async () => {
      await seedReadyAttachment({ plaintext: crypto.randomBytes(321), fileName: 'a.pdf' });
      await seedReadyAttachment({ plaintext: crypto.randomBytes(654), fileName: 'b.pdf' });

      const { entries, manifest } = await buildAndUnzip(ownerToken);

      expect(manifest.manifestVersion).toBe(1);
      expect(typeof manifest.exportedAt).toBe('string');
      expect(Number.isNaN(Date.parse(manifest.exportedAt))).toBe(false);

      // The manifest never lists itself.
      expect(manifest.files.some((f) => f.zipPath === 'manifest.json')).toBe(false);

      // totalFiles === files.length; totalBytes === sum(sizeBytes).
      expect(manifest.totalFiles).toBe(manifest.files.length);
      const summed = manifest.files.reduce((acc, f) => acc + f.sizeBytes, 0);
      expect(manifest.totalBytes).toBe(summed);

      // Every entry's declared sha256 + sizeBytes verify against the
      // actual bytes at its zipPath in the archive.
      for (const f of manifest.files) {
        const bytes = entries.get(f.zipPath);
        expect(bytes, `manifest lists ${f.zipPath} but the archive lacks it`).toBeDefined();
        expect(bytes!.length).toBe(f.sizeBytes);
        expect(sha256Hex(bytes!)).toBe(f.sha256);
      }
    });

    it('places each attachment under attachments/<number>-<title>/<id>-<filename> with bytes byte-equal to the upload', async () => {
      const plaintext = crypto.randomBytes(2048);
      const seeded = await seedReadyAttachment({ plaintext, fileName: 'angebot.pdf' });

      const { entries, manifest } = await buildAndUnzip(ownerToken);

      // The path component for the project is `<number>-<title>` (each
      // segment sanitised per AC-245). Title carries an umlaut in the
      // seed (e.g. "Fassadenanstrich Müller"); the sanitiser must not
      // emit a path separator, control char, or double-quote, but is NOT
      // required to strip the umlaut — so assert the dir prefix + the
      // <id>-<filename> tail rather than a fully-normalised literal.
      const dirPrefix = `attachments/${projectNumber}-`;
      const attachmentEntry = [...entries.keys()].find(
        (k) => k.startsWith('attachments/') && k.endsWith(`${seeded.id}-${seeded.fileName}`),
      );
      expect(
        attachmentEntry,
        `no archive entry ends with ${seeded.id}-${seeded.fileName}`,
      ).toBeDefined();
      expect(attachmentEntry!.startsWith(dirPrefix)).toBe(true);

      // Exactly 3 path segments (attachments / <number>-<title> / <id>-<file>):
      // any '/' or '\' in the project title MUST have been sanitised away
      // (AC-245), so no extra separator leaked into the path.
      expect(attachmentEntry!.split('/').length).toBe(3);
      // The middle segment carries the sanitised title beyond the
      // "<number>-" prefix — not collapsed to a placeholder.
      const dirSegment = attachmentEntry!.split('/')[1]!;
      expect(dirSegment.length).toBeGreaterThan(`${projectNumber}-`.length);

      // Bytes at the attachment path byte-equal the uploaded plaintext.
      const archived = entries.get(attachmentEntry!)!;
      expect(Buffer.compare(archived, plaintext)).toBe(0);

      // The manifest entry for this file carries its attachmentId and a
      // matching sha256.
      const mf = manifest.files.find((f) => f.zipPath === attachmentEntry);
      expect(mf, 'attachment missing from manifest').toBeDefined();
      expect(mf!.attachmentId).toBe(seeded.id);
      expect(mf!.sha256).toBe(sha256Hex(plaintext));
    });
  });

  // -------------------------------------------------------------------
  // AC-325 / AT-139 — one bad row is skipped; the build still completes.
  // -------------------------------------------------------------------
  describe('AC-325: per-row resilience (corrupt DEK is skipped)', () => {
    it('skips the corrupt-DEK row, still reaches ready, and excludes it from the manifest', async () => {
      const goodPlain = crypto.randomBytes(512);
      const good = await seedReadyAttachment({ plaintext: goodPlain, fileName: 'good.pdf' });
      const bad = await seedReadyAttachment({
        plaintext: crypto.randomBytes(512),
        fileName: 'bad.pdf',
        corruptDek: true,
      });

      const { entries, manifest, job } = await buildAndUnzip(ownerToken);

      // The build reached `ready` despite the bad row (buildAndUnzip
      // already asserts status === 'ready').
      expect(job.status).toBe('ready');

      // The good attachment is present and byte-equal; the bad one is
      // absent from BOTH the archive entries and the manifest.
      const goodEntry = [...entries.keys()].find((k) => k.endsWith(`${good.id}-good.pdf`));
      expect(goodEntry, 'good attachment missing from archive').toBeDefined();
      expect(Buffer.compare(entries.get(goodEntry!)!, goodPlain)).toBe(0);

      const badEntry = [...entries.keys()].find((k) => k.includes(bad.id));
      expect(badEntry, 'corrupt-DEK attachment should not be in the archive').toBeUndefined();

      expect(manifest.files.some((f) => f.attachmentId === good.id)).toBe(true);
      expect(manifest.files.some((f) => f.attachmentId === bad.id)).toBe(false);

      // filesDone "reflects the skip" (AC-325): of the 2 ready attachments
      // (filesTotal), exactly the 1 good one was streamed — the bad row was
      // attempted then skipped, not counted as done. data.json / manifest.json
      // are archive entries, not attachment "files" for this counter.
      expect(job.filesTotal).toBe(2);
      expect(job.filesDone).toBe(1);

      // bytesTotal is the denominator (Σ of BOTH ready rows' plaintext size,
      // skip included); bytesDone counts only the archived good row. Both
      // seeds are 512 bytes (data-model.md §5.18, ui/daten.md §8.11).
      expect(job.bytesTotal).toBe(1024);
      expect(job.bytesDone).toBe(512);
    });
  });
});
