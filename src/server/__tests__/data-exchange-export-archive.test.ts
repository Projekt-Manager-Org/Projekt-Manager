/**
 * API integration tests — export-job ARCHIVE layout, manifest, and
 * completeness.
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
 *   - AC-325 / AT-139 — export completeness, two arms:
 *     (a) an attachment whose wrapped DEK is corrupt (unwrap fails) FAILS
 *         the job: `error_detail` names the row, the download 409s, and no
 *         archive is served. Removing the bad row and re-running yields a
 *         `ready` archive whose envelope↔manifest parity holds.
 *     (b) a row that becomes `ready` AFTER the envelope snapshot but
 *         before the archive is built is excluded from BOTH — the export
 *         is a consistent point-in-time snapshot, not two disagreeing
 *         reads. Arm (b) drives `buildExportArchive` directly because the
 *         window cannot be won deterministically through HTTP.
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
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase, type Database } from '../db/connection.js';
import {
  createStorageClient,
  type StorageClient,
  type AttachmentStorageClient,
} from '../storage/client.js';
import { KeyEnvelopeService } from '../services/KeyEnvelopeService.js';
import { buildExportArchive } from '../services/takeout-export-builder.js';
import type { ServiceLogger } from '../services/Logger.js';
import { getEnv } from '../config/env.js';
import type { AuthUser } from '../middleware/auth.js';

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
  errorDetail: string | null;
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

/**
 * The invariant the import job enforces before the wipe
 * (`takeout-import-runner` → `validateArchive`): the envelope's
 * `attachments[]` ids and the manifest's attachment entries must cover
 * exactly the same set, both directions. An archive failing this is
 * unrestorable — asserted here so the export side owns the failure.
 */
function assertEnvelopeManifestParity(entries: Map<string, Buffer>, manifest: Manifest): void {
  const envelope = JSON.parse(entries.get('data.json')!.toString('utf-8')) as {
    attachments: { id: string }[];
  };
  const envelopeIds = [...envelope.attachments.map((a) => a.id)].sort();
  const manifestIds = manifest.files
    .filter((f) => f.attachmentId)
    .map((f) => f.attachmentId!)
    .sort();
  expect(manifestIds).toEqual(envelopeIds);
}

describe('Export-job archive — layout, manifest, completeness', () => {
  let db: Database;
  let pool: import('pg').Pool;
  let storage: StorageClient;
  let identity: string;
  let recipient: string;
  let caller: AuthUser;
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

    // Unscoped caller for the direct `buildExportArchive` arm (the
    // snapshot-race test) — threaded to ExportService's scope tripwire.
    const ownerRow = (
      await db.execute(
        sql`SELECT id, display_name FROM users WHERE username = ${SEED_USERS.owner.username}`,
      )
    ).rows[0] as { id: string; display_name: string };
    caller = {
      id: ownerRow.id,
      username: SEED_USERS.owner.username,
      displayName: ownerRow.display_name,
      roles: ['owner'],
      email: null,
      themePreference: 'system',
      pushMuted: false,
    };

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
  // AC-325 / AT-139 — one bad row FAILS the job; no partial archive.
  //
  // This arm crosses the diagonal the old coverage matrix left empty:
  // "≥1 unreadable row" × "the archive is importable". Under the previous
  // contract the build skipped the row and reached `ready`, but the
  // envelope — serialized before any decryption is attempted — still
  // listed it, so the importer's parity check rejected the archive at
  // restore time. The operator learned their backup was worthless only
  // when they needed it.
  // -------------------------------------------------------------------
  describe('AC-325: export completeness (a corrupt DEK fails the job)', () => {
    it('fails the job naming the bad row, serves no archive, and exports cleanly once it is gone', async () => {
      const goodPlain = crypto.randomBytes(512);
      const good = await seedReadyAttachment({ plaintext: goodPlain, fileName: 'good.pdf' });
      const bad = await seedReadyAttachment({
        plaintext: crypto.randomBytes(512),
        fileName: 'bad.pdf',
        corruptDek: true,
      });

      const created = await authPost(ownerToken, '/api/export-jobs');
      expect(created.statusCode).toBe(201);
      const failed = await pollUntilTerminal(ownerToken, (created.json() as ExportJobRow).id);

      // No partial artifact is labelled success.
      expect(failed.status).toBe('failed');
      // `error_detail` names the offending row so the operator can act on
      // it without reading server logs.
      expect(failed.errorDetail ?? '').toContain(bad.id);

      // Nothing is downloadable from a failed job (AC-324).
      const dl = await authGet(ownerToken, `/api/export-jobs/${failed.id}/download`);
      expect(dl.statusCode).toBe(409);

      // Remove the unreadable row; the export now succeeds and covers the
      // full remaining set.
      await db.execute(sql`DELETE FROM attachments WHERE id = ${bad.id}`);
      const { entries, manifest, job } = await buildAndUnzip(ownerToken);

      expect(job.status).toBe('ready');
      expect(job.filesTotal).toBe(1);
      expect(job.filesDone).toBe(1);
      expect(job.bytesTotal).toBe(512);
      expect(job.bytesDone).toBe(512);

      const goodEntry = [...entries.keys()].find((k) => k.endsWith(`${good.id}-good.pdf`));
      expect(goodEntry, 'good attachment missing from archive').toBeDefined();
      expect(Buffer.compare(entries.get(goodEntry!)!, goodPlain)).toBe(0);

      assertEnvelopeManifestParity(entries, manifest);
    });

    it('a healthy build satisfies envelope↔manifest parity for every ready row', async () => {
      await seedReadyAttachment({ plaintext: crypto.randomBytes(128), fileName: 'a.pdf' });
      await seedReadyAttachment({ plaintext: crypto.randomBytes(256), fileName: 'b.pdf' });

      const { entries, manifest, job } = await buildAndUnzip(ownerToken);

      expect(job.filesTotal).toBe(2);
      expect(job.filesDone).toBe(2);
      assertEnvelopeManifestParity(entries, manifest);
    });

    // -----------------------------------------------------------------
    // The envelope is read inside a `repeatable read read only` snapshot
    // that COMMITS before the archive is built. A build that re-derived
    // its own `status='ready'` set afterwards would pick up anything that
    // landed in between — producing a `ready` archive whose manifest
    // carries a row the envelope lacks, which the importer rejects
    // pre-wipe, with healthy-looking counters and no bad row anywhere.
    //
    // Deriving the archive set FROM the envelope makes that impossible.
    // The window is opened deterministically by proxying `db.transaction`
    // to land a ready row the instant the snapshot closes; it cannot be
    // won reliably through the HTTP surface, hence the direct call.
    // -----------------------------------------------------------------
    it('excludes a row that turns ready after the envelope snapshot from BOTH envelope and manifest', async () => {
      const original = await seedReadyAttachment({
        plaintext: crypto.randomBytes(256),
        fileName: 'already-there.pdf',
      });
      let racedId = '';

      const racingDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'transaction') {
            return async (...args: unknown[]) => {
              const result = await (
                target.transaction as unknown as (...a: unknown[]) => Promise<unknown>
              )(...args);
              // Envelope snapshot has committed — another user's upload
              // completes right now.
              racedId = (
                await seedReadyAttachment({
                  plaintext: crypto.randomBytes(256),
                  fileName: 'landed-mid-build.pdf',
                })
              ).id;
              return result;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as Database;

      const result = await buildExportArchive({
        db: racingDb,
        storage: storage as AttachmentStorageClient,
        logger: { info: () => {}, error: () => {} } as unknown as ServiceLogger,
        caller,
        binaryAgeRecipient: recipient,
        binaryAgeIdentityPath: process.env.BINARY_AGE_IDENTITY_PATH!,
        stagingDir: getEnv().TAKEOUT_STAGING_DIR,
        jobId: crypto.randomUUID(),
        onProgress: async () => {},
      });

      expect(racedId, 'the race window never opened — the proxy did not fire').not.toBe('');
      // The build covers the snapshot, not the moving present.
      expect(result.filesTotal).toBe(1);
      expect(result.filesDone).toBe(1);

      const decoded = unzipSync(new Uint8Array(await readFile(result.archiveRef)));
      const entries = new Map<string, Buffer>();
      for (const [name, bytes] of Object.entries(decoded)) entries.set(name, Buffer.from(bytes));
      const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf-8')) as Manifest;

      // Parity holds, and the raced row is in NEITHER — a consistent
      // point-in-time snapshot. It belongs to the next export.
      assertEnvelopeManifestParity(entries, manifest);
      const envelope = JSON.parse(entries.get('data.json')!.toString('utf-8')) as {
        attachments: { id: string }[];
      };
      expect(envelope.attachments.map((a) => a.id)).toEqual([original.id]);
      expect(manifest.files.some((f) => f.attachmentId === racedId)).toBe(false);
    });
  });
});
