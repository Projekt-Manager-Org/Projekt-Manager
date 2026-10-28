/**
 * Binary key rotation — data written under a listed retired key stays
 * readable in the app (AC-517), new wraps use the active key only (AC-400).
 *
 * Phase 1 runs on the per-fork key from `integration-setup.ts` (key 1):
 * the seed issues its invoices, and one photo attachment with real
 * ciphertext is written. Phase 2 "reboots": the tmpfs-equivalent file becomes the
 * keyring {key 1, key 2}, the env makes key 2 active and lists key 1 as
 * retired, the boot probe runs on the same env-to-options mapping as
 * `start.ts`, and a second app is
 * built on the same database. Every request below goes to that app.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, stopApp, login, getDb } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { TEST_OBJECT_METADATA } from '../../test/fixtures/objectEnvelope.js';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { createStorageClientFromEnv } from '../storage/fromEnv.js';
import { assertBinaryIdentityLoaded } from '../storage/binaryIdentity.js';
import { KeyEnvelopeService, KeyEnvelopeUnwrapError } from '../services/KeyEnvelopeService.js';
import { photoInitBody } from '../../test/fixtures/attachmentInit.js';

const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

const ROTATED_ENV_KEYS = [
  'BINARY_AGE_RECIPIENT',
  'BINARY_AGE_RETIRED_RECIPIENTS',
  'BINARY_AGE_IDENTITY_PATH',
] as const;

function freshAgeIdentity(): { identity: string; recipient: string } {
  const identity = execFileSync('age-keygen', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const recipient = execFileSync('age-keygen', ['-y'], {
    input: identity,
    encoding: 'utf-8',
  }).trim();
  return { identity, recipient };
}

describe('Binary key rotation (#554)', () => {
  let rotated: FastifyInstance;
  let ownerToken: string;
  let keyringDir: string;
  let activeOnlyIdentity: string;
  let retiredOnlyIdentity: string;
  const savedEnv: Partial<Record<(typeof ROTATED_ENV_KEYS)[number], string | undefined>> = {};

  let issuedInvoice: { id: string; number: string; pdfDescriptorId: string };
  let projectId: string;
  let oldAttachment: {
    id: string;
    dek: Buffer;
    thumbDek: Buffer;
    plaintext: Buffer;
    wrappedDek: string;
  };

  function get(url: string) {
    return rotated.inject({ method: 'GET', url, headers: { cookie: `session=${ownerToken}` } });
  }
  function post(url: string, payload?: Record<string, unknown>) {
    return rotated.inject({
      method: 'POST',
      url,
      headers: { cookie: `session=${ownerToken}` },
      ...(payload ? { payload } : {}),
    });
  }

  function encrypt(plaintext: Buffer, dek: Buffer): Buffer {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
    return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  }

  /** A ready photo with real AES-256-GCM ciphertext, both DEKs wrapped to the current active key. */
  async function writePhotoUnderCurrentKey(): Promise<typeof oldAttachment> {
    const env = getEnv();
    const storage = createStorageClientFromEnv(env);
    const envelope = new KeyEnvelopeService({
      recipient: env.BINARY_AGE_RECIPIENT!,
      identityPath: env.BINARY_AGE_IDENTITY_PATH,
    });
    const id = crypto.randomUUID();
    const plaintext = Buffer.from(`written under key 1 — ${id}`);
    const dek = crypto.randomBytes(32);
    const thumbDek = crypto.randomBytes(32);
    const ciphertext = encrypt(plaintext, dek);
    const thumbCiphertext = encrypt(Buffer.from(`thumbnail — ${id}`), thumbDek);
    const originalKey = `attachments/${projectId}/${id}.orig`;
    const thumbKey = `attachments/${projectId}/${id}.thumb`;
    for (const [key, body] of [
      [originalKey, ciphertext],
      [thumbKey, thumbCiphertext],
    ] as const) {
      await storage.upload(key, body, 'application/octet-stream', TEST_OBJECT_METADATA);
    }
    const wrap = async (k: Buffer): Promise<string> =>
      Buffer.from(await envelope.wrap(k)).toString('base64');
    const wrappedDek = await wrap(dek);
    await getDb().execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes, ciphertext_thumb_size_bytes, original_key, thumb_key,
         has_thumbnail, wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
      VALUES (${id}, ${projectId}, 'ready', 'photo', 'foto',
              'vor-rotation.jpg', 'image/jpeg', ${plaintext.length}, ${ciphertext.length},
              ${thumbCiphertext.length}, ${originalKey}, ${thumbKey},
              TRUE, ${wrappedDek}, ${await wrap(thumbDek)}, 1)
    `);
    return { id, dek, thumbDek, plaintext, wrappedDek };
  }

  beforeAll(async () => {
    // --- Phase 1: key 1 active, no retired keys -----------------------
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    const invoiceRow = (
      await getDb().execute(
        sql`SELECT id, number, rendered_pdf_binary_descriptor_id AS "pdfDescriptorId"
            FROM invoices
            WHERE status = 'issued' AND rendered_pdf_binary_descriptor_id IS NOT NULL
            LIMIT 1`,
      )
    ).rows[0] as typeof issuedInvoice | undefined;
    if (!invoiceRow) throw new Error('seed has no issued invoice with a rendered PDF');
    issuedInvoice = invoiceRow;

    const projectRow = (await getDb().execute(sql`SELECT id FROM projects ORDER BY number LIMIT 1`))
      .rows[0] as { id: string };
    projectId = projectRow.id;
    oldAttachment = await writePhotoUnderCurrentKey();

    // --- Phase 2: rotate — key 2 active, key 1 retired ---------------
    const env = getEnv();
    const key1 = {
      identity: readFileSync(env.BINARY_AGE_IDENTITY_PATH, 'utf-8').trim(),
      recipient: env.BINARY_AGE_RECIPIENT!,
    };
    const key2 = freshAgeIdentity();
    activeOnlyIdentity = key2.identity;
    retiredOnlyIdentity = key1.identity;

    keyringDir = mkdtempSync(path.join(os.tmpdir(), 'binary-key-rotation-'));
    const keyringPath = path.join(keyringDir, 'identity');
    writeFileSync(keyringPath, `${key2.identity}\n${key1.identity}\n`, { mode: 0o600 });

    for (const key of ROTATED_ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.BINARY_AGE_RECIPIENT = key2.recipient;
    process.env.BINARY_AGE_RETIRED_RECIPIENTS = key1.recipient;
    process.env.BINARY_AGE_IDENTITY_PATH = keyringPath;

    const rotatedEnv = getEnv();
    await assertBinaryIdentityLoaded({
      identityPath: rotatedEnv.BINARY_AGE_IDENTITY_PATH,
      configuredRecipient: rotatedEnv.BINARY_AGE_RECIPIENT!,
      retiredRecipients: rotatedEnv.BINARY_AGE_RETIRED_RECIPIENTS,
      waitTimeoutMs: 0,
      progressLogIntervalMs: 0,
    });

    // The fixture is retired-key-only: the new active key cannot read it.
    const activeOnly = new KeyEnvelopeService({
      recipient: key2.recipient,
      identity: key2.identity,
    });
    try {
      await expect(
        activeOnly.unwrap(Buffer.from(oldAttachment.wrappedDek, 'base64')),
      ).rejects.toBeInstanceOf(KeyEnvelopeUnwrapError);
    } finally {
      activeOnly.close();
    }

    rotated = buildApp({ logger: false, db: getDb(), rateLimit: false });
    await rotated.ready();
  });

  afterAll(async () => {
    await rotated?.close();
    for (const key of ROTATED_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    if (keyringDir) rmSync(keyringDir, { recursive: true, force: true });
    await stopApp();
  });

  it('AC-517: an invoice PDF issued under the retired key downloads', async () => {
    const res = await get(`/api/invoices/${issuedInvoice.id}/pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('AC-517: the invoice bulk export includes an invoice PDF issued under the retired key', async () => {
    const res = await post('/api/invoices/export', { ids: [issuedInvoice.id] });
    expect(res.statusCode).toBe(200);
    const entries = unzipSync(new Uint8Array(res.rawPayload));
    const pdf = entries[`${issuedInvoice.number}.pdf`];
    expect(pdf).toBeDefined();
    expect(Buffer.from(pdf!.subarray(0, 5)).toString('utf-8')).toBe('%PDF-');
  });

  it('AC-517: an attachment written under the retired key opens and downloads', async () => {
    const base = `/api/projects/${projectId}/attachments/${oldAttachment.id}/download-url`;
    for (const [url, dek] of [
      [base, oldAttachment.dek],
      [`${base}?variant=thumbnail`, oldAttachment.thumbDek],
    ] as const) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect((res.json() as { dekMaterial: string }).dekMaterial).toBe(dek.toString('base64'));
    }
  });

  it('AC-517: a ZIP selection fetches an attachment written under the retired key', async () => {
    const res = await post(`/api/projects/${projectId}/attachments/bulk-fetch`, {
      attachmentIds: [oldAttachment.id],
    });
    expect(res.statusCode).toBe(200);
    const [entry] = (
      res.json() as { data: { originalDekMaterial: string; thumbDekMaterial?: string }[] }
    ).data;
    expect(entry).toMatchObject({
      originalDekMaterial: oldAttachment.dek.toString('base64'),
      thumbDekMaterial: oldAttachment.thumbDek.toString('base64'),
    });
  });

  it(
    'AC-517: the full-account export includes binaries written under the retired key',
    { timeout: 15_000 },
    async () => {
      const created = await post('/api/export-jobs');
      expect(created.statusCode).toBe(201);
      const jobId = (created.json() as { id: string }).id;

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let status = 'pending';
      let errorDetail: unknown = null;
      while (Date.now() < deadline) {
        const res = await get(`/api/export-jobs/${jobId}`);
        ({ status, errorDetail } = res.json() as { status: string; errorDetail: unknown });
        if (status === 'ready' || status === 'failed') break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      expect(status, `errorDetail: ${JSON.stringify(errorDetail)}`).toBe('ready');

      const dl = await get(`/api/export-jobs/${jobId}/download`);
      expect(dl.statusCode).toBe(200);
      const entries = Object.entries(unzipSync(new Uint8Array(dl.rawPayload)));
      expect(entries.some(([, bytes]) => Buffer.from(bytes).equals(oldAttachment.plaintext))).toBe(
        true,
      );
      const invoicePdf = entries.find(([name]) => name.includes(issuedInvoice.pdfDescriptorId));
      expect(invoicePdf, 'invoice PDF entry').toBeDefined();
      expect(Buffer.from(invoicePdf![1].subarray(0, 5)).toString('utf-8')).toBe('%PDF-');
    },
  );

  it('AC-400: keys wrapped after the rotation are wrapped for the active recipient only', async () => {
    const dek = crypto.randomBytes(32);
    const thumbDek = crypto.randomBytes(32);
    const init = await post(
      `/api/projects/${projectId}/attachments/init`,
      photoInitBody({
        dekMaterial: dek.toString('base64'),
        thumbDekMaterial: thumbDek.toString('base64'),
      }),
    );
    expect(init.statusCode).toBe(201);
    const attachmentId = (init.json() as { attachment: { id: string } }).attachment.id;

    const row = (
      await getDb().execute(
        sql`SELECT wrapped_dek, wrapped_thumb_dek FROM attachments WHERE id = ${attachmentId}`,
      )
    ).rows[0] as { wrapped_dek: string; wrapped_thumb_dek: string };

    const recipient = getEnv().BINARY_AGE_RECIPIENT!;
    const activeOnly = new KeyEnvelopeService({ recipient, identity: activeOnlyIdentity });
    const retiredOnly = new KeyEnvelopeService({ recipient, identity: retiredOnlyIdentity });
    try {
      for (const [wrapped, expected] of [
        [row.wrapped_dek, dek],
        [row.wrapped_thumb_dek, thumbDek],
      ] as const) {
        const envelope = Buffer.from(wrapped, 'base64');
        expect(Buffer.from(await activeOnly.unwrap(envelope))).toEqual(expected);
        await expect(retiredOnly.unwrap(envelope)).rejects.toBeInstanceOf(KeyEnvelopeUnwrapError);
      }
    } finally {
      activeOnly.close();
      retiredOnly.close();
    }
  });
});
