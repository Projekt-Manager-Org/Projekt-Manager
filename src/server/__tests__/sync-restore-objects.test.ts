/**
 * #627, AC-439 — the restore side of `scripts/sync-dev-to-vps.sh` writes
 * every synced object self-describing.
 *
 * The bucket dump crosses SSH as a plain directory, which holds no S3 user
 * metadata. `scripts/ops/restore-bucket-objects.py` therefore rebuilds each
 * object's metadata from its restored row, extracted by
 * `scripts/ops/restore-bucket-objects.sql`: the envelope (already re-wrapped
 * to the target recipient) and the number of the invoice rendering a PDF.
 *
 * Fixtures are app-written — a photo (original + thumbnail) and an issued
 * invoice — so rows, join and metadata are the real ones. Their bytes are
 * dumped to a directory, as the sync does, and restored by the script. The
 * proof: the rebuilt metadata equals what the app wrote, and the recovery
 * tool, with the binary identity alone and no database, reports every
 * synced version `recovered`, the invoice PDF with its number. The invoice
 * PDF also carries the target's own invoice lock, the photo only the
 * bucket default.
 *
 * Runs against this file's `STORAGE_KEY_PREFIX` namespace. Requires
 * `python3` with boto3 (`python3-boto3`, docs/ops/local-dev.md).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  PutObjectRetentionCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { eq, sql } from 'drizzle-orm';
import { startApp, stopApp, getDb, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { photoInitBody } from '../../test/fixtures/attachmentInit.js';
import {
  freshDekMaterial,
  md5Base64,
  presignedPut,
  type PresignedUpload,
} from '../../test/fixtures/presignedPut.js';
import { headObjectMetadata } from '../../test/storageObjectMetadata.js';
import { GCM_OVERHEAD_BYTES } from '../../domain/clientEncryption.js';
import { getEnv } from '../config/env.js';
import { attachments } from '../db/schema.js';
import { storageConfigFromEnv } from '../storage/fromEnv.js';
import { RESERVED_KEY_PREFIXES } from '../storage/keyNamespaces.js';
import { recoverObjects } from '../storage/recoverObjects.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptPath = path.join(repoRoot, 'scripts/ops/restore-bucket-objects.py');
const extractPath = path.join(repoRoot, 'scripts/ops/restore-bucket-objects.sql');
const year = new Date().getFullYear();
const DAY_MS = 86_400_000;
// Above the test bucket's 1-day default retention (docker/init-storage.sh),
// so the invoice lock is observable against it.
const INVOICE_LOCK_DAYS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The browser's client-side format: nonce(12) || ciphertext || tag(16). */
function encrypt(plaintext: Buffer, dekBase64: string): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(dekBase64, 'base64'), nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

async function readRow(id: string) {
  const rows = await getDb().select().from(attachments).where(eq(attachments.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`attachment row ${id} missing`);
  return row;
}

describe('sync restore: objects carry metadata rebuilt from their rows', () => {
  const env = getEnv();
  const storage = storageConfigFromEnv(env);
  const prefix = storage.keyPrefix ?? '';
  const s3 = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region ?? 'us-east-1',
    credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
    forcePathStyle: true,
  });
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'sync-restore-'));
  const dumpDir = path.join(workDir, 'bucket');
  const orphanKey = `projects/sync-${crypto.randomUUID()}/orphan.orig`;
  const staleKey = `projects/sync-${crypto.randomUUID()}/stale.orig`;
  const reservedKeys = RESERVED_KEY_PREFIXES.map((p) => `${p}sync-${crypto.randomUUID()}`);

  let ownerToken: string;
  let photo: { id: string; original: string; thumb: string };
  let invoice: { id: string; key: string; number: string };
  const plaintexts = new Map<string, Buffer>();
  const appMetadata = new Map<string, Record<string, string>>();
  let cutoff: Date;
  let stdout: string;

  async function exists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: prefix + key }));
      return true;
    } catch (err) {
      if (err instanceof NotFound) return false;
      throw err;
    }
  }

  async function currentVersion(key: string): Promise<string> {
    const res = await s3.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: prefix + key }));
    return res.VersionId!;
  }

  /** Copy the object's bytes into the dump — the directory holds no metadata. */
  async function dump(key: string): Promise<void> {
    const res = await s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: prefix + key }));
    const file = path.join(dumpDir, key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, await res.Body!.transformToByteArray());
  }

  async function uploadReadyPhoto(projectId: string) {
    const originalPlain = crypto.randomBytes(180);
    const thumbPlain = crypto.randomBytes(120);
    const dek = freshDekMaterial();
    const thumbDek = freshDekMaterial();
    const original = encrypt(originalPlain, dek);
    const thumb = encrypt(thumbPlain, thumbDek);
    const init = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      photoInitBody({
        sizeBytes: original.length - GCM_OVERHEAD_BYTES,
        ciphertextSizeBytes: original.length,
        ciphertextContentMd5: md5Base64(original),
        ciphertextThumbSizeBytes: thumb.length,
        ciphertextThumbContentMd5: md5Base64(thumb),
        dekMaterial: dek,
        thumbDekMaterial: thumbDek,
      }),
    );
    expect(init.statusCode).toBe(201);
    const body = init.json() as {
      attachment: { id: string };
      originalUpload: PresignedUpload;
      thumbnailUpload: PresignedUpload;
    };
    for (const [descriptor, bytes] of [
      [body.originalUpload, original],
      [body.thumbnailUpload, thumb],
    ] as const) {
      const put = await presignedPut(descriptor, bytes);
      expect(put.status).toBeLessThan(300);
      await put.arrayBuffer();
    }
    const complete = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
    );
    expect(complete.statusCode).toBe(200);
    const row = await readRow(body.attachment.id);
    plaintexts.set(row.originalKey, originalPlain);
    plaintexts.set(row.thumbKey!, thumbPlain);
    return { id: row.id, original: row.originalKey, thumb: row.thumbKey! };
  }

  async function issueInvoice() {
    const pr = await authGet(ownerToken, '/api/projects?status=rechnung_faellig&limit=200');
    const project = (pr.json() as { data: { id: string }[] }).data[0];
    if (!project) throw new Error('seed missing a project in rechnung_faellig');
    const draft = await authPost(ownerToken, '/api/invoices', {
      projectId: project.id,
      lines: [
        {
          description: 'Anstrich Fassade',
          quantity: 1,
          unit: 'pauschal',
          unitPrice: 1500,
          taxRate: 19,
        },
      ],
      performanceDate: `${year}-04-10`,
    });
    expect(draft.statusCode).toBe(201);
    const issued = await authPost(ownerToken, `/api/invoices/${draft.json().id}/issue`, {
      expectedVersion: draft.json().version,
    });
    expect(issued.statusCode).toBe(200);
    const { number, renderedPdfBinaryDescriptorId: id } = issued.json() as {
      number: string;
      renderedPdfBinaryDescriptorId: string;
    };
    return { id, key: (await readRow(id)).originalKey, number };
  }

  /** The restore's extract, run as written, rows joined into the helper's TSV. */
  async function extractTsv(): Promise<string> {
    const res = await getDb().execute(sql.raw(readFileSync(extractPath, 'utf8')));
    return res.rows.map((row) => Object.values(row).map(String).join('\t') + '\n').join('');
  }

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const res = await authGet(ownerToken, '/api/projects?limit=200');
    const project = (res.json().data as { id: string; number: string }[]).find(
      (row) => row.number === `${year}-007`,
    );
    if (!project) throw new Error(`seed missing ${year}-007`);

    photo = await uploadReadyPhoto(project.id);
    invoice = await issueInvoice();
    for (const key of [photo.original, photo.thumb, invoice.key]) {
      appMetadata.set(key, await headObjectMetadata(key));
      await dump(key);
    }
    mkdirSync(path.join(dumpDir, path.dirname(orphanKey)), { recursive: true });
    writeFileSync(path.join(dumpDir, orphanKey), 'no row');

    // Target-only keys: one the dump no longer has, and the deploy-probe
    // namespace the target owns.
    for (const key of [staleKey, ...reservedKeys]) {
      await s3.send(new PutObjectCommand({ Bucket: storage.bucket, Key: prefix + key, Body: 'x' }));
    }

    await sleep(1100);
    cutoff = new Date();
    await sleep(1100);

    const tsvPath = path.join(workDir, 'objects.tsv');
    writeFileSync(tsvPath, await extractTsv());
    ({ stdout } = await execFileAsync('python3', [scriptPath], {
      env: {
        PATH: process.env.PATH,
        B2_ENDPOINT: storage.endpoint,
        B2_BUCKET: storage.bucket,
        B2_KEY: storage.accessKey,
        B2_SECRET: storage.secretKey,
        SOURCE_DIR: dumpDir,
        OBJECTS_TSV: tsvPath,
        KEY_PREFIX: prefix,
        INVOICE_OBJECT_LOCK_DAYS: String(INVOICE_LOCK_DAYS),
      },
    }));
  }, 120_000);

  afterAll(async () => {
    await stopApp();
    s3.destroy();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('each synced object carries the metadata the app wrote', async () => {
    for (const [key, expected] of appMetadata) {
      expect(await headObjectMetadata(key), key).toEqual(expected);
    }
  });

  it('every synced object decrypts with the binary identity alone; the invoice PDF carries its number', async () => {
    const outDir = path.join(workDir, 'recovered');
    const identityPath = env.BINARY_AGE_IDENTITY_PATH!;
    const result = await recoverObjects({ storage, identityPath, since: cutoff, outDir });

    expect(result.failedCount).toBe(0);
    expect(result.entries.map((e) => e.key).sort()).toEqual(
      [photo.original, photo.thumb, invoice.key].sort(),
    );
    for (const key of [photo.original, photo.thumb]) {
      const entry = result.entries.find((e) => e.key === key)!;
      expect(readFileSync(path.join(outDir, entry.file!))).toEqual(plaintexts.get(key));
    }
    expect(result.entries.find((e) => e.key === invoice.key)!.invoiceNumber).toBe(invoice.number);
  });

  it('points each row at the version it wrote', async () => {
    expect(stdout.trim().split('\n').sort()).toEqual(
      [
        `UPDATE public.attachments SET version_id='${await currentVersion(photo.original)}', thumb_version_id='${await currentVersion(photo.thumb)}' WHERE id='${photo.id}';`,
        `UPDATE public.attachments SET version_id='${await currentVersion(invoice.key)}' WHERE id='${invoice.id}';`,
      ].sort(),
    );
  });

  // The restricted test user cannot read retention back (no
  // s3:GetObjectRetention, parity with the B2 app key), so the lock is
  // observed by behaviour: a Compliance lock cannot be shortened. The
  // helper wrote after `cutoff`, so a lock of the full INVOICE_LOCK_DAYS
  // ends after `cutoff` + 3 days: moving it to a minute before is refused
  // (MinIO: InvalidRequest, "WORM protected"). The photo's 1-day bucket
  // default accepts the same date as an extension.
  it("gives the invoice PDF the target's invoice lock and the photo only the bucket default", async () => {
    const justShortOfLock = new Date(cutoff.getTime() + INVOICE_LOCK_DAYS * DAY_MS - 60_000);
    const retainUntil = (key: string) =>
      s3.send(
        new PutObjectRetentionCommand({
          Bucket: storage.bucket,
          Key: prefix + key,
          Retention: { Mode: 'COMPLIANCE', RetainUntilDate: justShortOfLock },
        }),
      );
    await expect(retainUntil(invoice.key)).rejects.toMatchObject({ name: 'InvalidRequest' });
    await expect(retainUntil(photo.original)).resolves.toBeDefined();
  });

  it('mirrors the dump: a key absent from it is removed, a row-less file is not shipped, the probe namespace is left alone', async () => {
    expect(await exists(staleKey)).toBe(false);
    expect(await exists(orphanKey)).toBe(false);
    for (const key of reservedKeys) expect(await exists(key), key).toBe(true);
  });
});
