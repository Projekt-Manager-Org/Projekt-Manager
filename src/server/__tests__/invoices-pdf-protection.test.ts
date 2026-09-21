/**
 * API integration tests — protection of a rendered invoice PDF (issue #417).
 *
 * The renderer stores each issued invoice's PDF/A-3 as an `attachments`
 * row in the invoice namespace (data-model.md §5.15). That row is a
 * §147 AO record, so it must not behave like an uploaded attachment:
 *
 *   - AC-364: the attachment surface never lists or addresses it. List and
 *     trash omit it; delete / restore / complete / download-url answer
 *     404 and change nothing; bulk fetch rejects the batch with 422. The
 *     invoice's own PDF route keeps serving the bytes.
 *   - AC-296: its object is written with a per-object Compliance lock of
 *     `INVOICE_OBJECT_LOCK_DAYS`. The restricted MinIO user cannot read
 *     retention back (no `s3:GetObjectRetention`, parity with the B2 app
 *     key), so the arm captures the outgoing `PutObjectCommand`; the
 *     issuance succeeding against that user proves the provider accepted
 *     the lock. The import-job leg is pinned by AC-365 in
 *     data-exchange-import-archive.test.ts.
 *
 * `INVOICE_OBJECT_LOCK_DAYS` is read when the invoice routes are wired, so
 * it is set before `startApp()` and restored afterwards.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PutObjectCommand, S3Client, type PutObjectCommandInput } from '@aws-sdk/client-s3';
import type pg from 'pg';

import {
  startApp,
  stopApp,
  getApp,
  login,
  authGet,
  authPost,
  authDelete,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase, type Database } from '../db/connection.js';
import { createStorageClient, type AttachmentStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';

const LOCK_DAYS = 1;
const DAY_MS = 86_400_000;

interface DescriptorRow {
  status: string;
  original_key: string;
}

describe('Rendered invoice PDF protection (#417)', () => {
  let db: Database;
  let pool: pg.Pool;
  let storage: AttachmentStorageClient;
  let ownerToken: string;
  let projectId: string;
  let invoiceId: string;
  let descriptorId: string;
  let issueStartedAt: number;
  let putInputs: PutObjectCommandInput[];
  let previousLockDays: string | undefined;

  async function descriptorRow(): Promise<DescriptorRow> {
    const res = await db.execute(
      sql`SELECT status, original_key FROM attachments WHERE id = ${descriptorId}`,
    );
    return res.rows[0] as unknown as DescriptorRow;
  }

  async function attachmentAuditCount(): Promise<number> {
    const res = await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM audit_log
          WHERE entity_type = 'attachment' AND entity_id = ${descriptorId}`,
    );
    return (res.rows[0] as { c: number }).c;
  }

  async function invoicePdfStatus(): Promise<number> {
    const res = await getApp().inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}/pdf`,
      headers: { cookie: `session=${ownerToken}` },
    });
    return res.statusCode;
  }

  /** Asserts the descriptor is exactly as issuance left it. */
  async function expectUntouched(status = 'ready'): Promise<void> {
    const row = await descriptorRow();
    expect(row.status).toBe(status);
    expect(await attachmentAuditCount()).toBe(0);
    if (status === 'ready') {
      // A hidden object would HEAD as missing (delete marker on current).
      await expect(storage.headObject(row.original_key)).resolves.toBeDefined();
      expect(await invoicePdfStatus()).toBe(200);
    }
  }

  beforeAll(async () => {
    previousLockDays = process.env.INVOICE_OBJECT_LOCK_DAYS;
    process.env.INVOICE_OBJECT_LOCK_DAYS = String(LOCK_DAYS);

    await startApp();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    const env = getEnv();
    storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
      region: env.STORAGE_REGION,
    }) as AttachmentStorageClient;
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    const projects = await authGet(ownerToken, '/api/projects?status=rechnung_faellig&limit=200');
    const project = (projects.json().data as { id: string }[])[0];
    if (!project) throw new Error('seed missing a project in rechnung_faellig');
    projectId = project.id;

    const draft = await authPost(ownerToken, '/api/invoices', {
      projectId,
      lines: [
        {
          description: 'Anstrich Fassade',
          quantity: 1,
          unit: 'pauschal',
          unitPrice: 1500,
          lineTotal: 1500,
          taxRate: 19,
        },
      ],
      performanceDate: '2026-04-10',
    });
    expect(draft.statusCode).toBe(201);
    invoiceId = draft.json().id as string;

    // Capture every S3 command the issuance sends, then let it through.
    const send = vi.spyOn(S3Client.prototype, 'send');
    issueStartedAt = Date.now();
    const issued = await authPost(ownerToken, `/api/invoices/${invoiceId}/issue`);
    putInputs = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof PutObjectCommand)
      .map((command) => (command as PutObjectCommand).input);
    send.mockRestore();

    expect(issued.statusCode).toBe(200);
    descriptorId = issued.json().renderedPdfBinaryDescriptorId as string;
    expect(descriptorId).toBeTruthy();
  });

  afterAll(async () => {
    await stopApp();
    await pool.end();
    if (previousLockDays === undefined) delete process.env.INVOICE_OBJECT_LOCK_DAYS;
    else process.env.INVOICE_OBJECT_LOCK_DAYS = previousLockDays;
  });

  describe('AC-296: per-object Compliance lock', () => {
    it('the rendered PDF is PUT with COMPLIANCE mode until ≥ write time + INVOICE_OBJECT_LOCK_DAYS', async () => {
      const { original_key } = await descriptorRow();
      const put = putInputs.find((input) => input.Key?.endsWith(original_key));
      expect(put, 'no PutObjectCommand for the rendered PDF').toBeDefined();
      expect(put!.ObjectLockMode).toBe('COMPLIANCE');
      expect(new Date(put!.ObjectLockRetainUntilDate!).getTime()).toBeGreaterThanOrEqual(
        issueStartedAt + LOCK_DAYS * DAY_MS,
      );
    });
  });

  describe('AC-364: not addressable through the attachment surface', () => {
    const base = () => `/api/projects/${projectId}/attachments`;

    it('is absent from the attachment list', async () => {
      const res = await authGet(ownerToken, base());
      expect(res.statusCode).toBe(200);
      const ids = (res.json().data as { id: string }[]).map((a) => a.id);
      expect(ids).not.toContain(descriptorId);
    });

    it('delete → 404, nothing changes', async () => {
      const res = await authDelete(ownerToken, `${base()}/${descriptorId}`);
      expect(res.statusCode).toBe(404);
      await expectUntouched();
    });

    it('complete → 404, nothing changes', async () => {
      const res = await authPost(ownerToken, `${base()}/${descriptorId}/complete`);
      expect(res.statusCode).toBe(404);
      await expectUntouched();
    });

    it('download-url → 404', async () => {
      const res = await authGet(ownerToken, `${base()}/${descriptorId}/download-url`);
      expect(res.statusCode).toBe(404);
      await expectUntouched();
    });

    it('bulk fetch including it → 422', async () => {
      const res = await authPost(ownerToken, `${base()}/bulk-fetch`, {
        attachmentIds: [descriptorId],
      });
      expect(res.statusCode).toBe(422);
      await expectUntouched();
    });

    it('a hidden one is absent from the trash, and restore → 404', async () => {
      // No API path can hide it (arm above), so the state is forced by SQL.
      await db.execute(
        sql`UPDATE attachments SET status = 'hidden', hidden_at = now() WHERE id = ${descriptorId}`,
      );
      try {
        const trash = await authGet(ownerToken, `${base()}/trash`);
        expect(trash.statusCode).toBe(200);
        const ids = (trash.json().data as { id: string }[]).map((a) => a.id);
        expect(ids).not.toContain(descriptorId);

        const res = await authPost(ownerToken, `${base()}/${descriptorId}/restore`);
        expect(res.statusCode).toBe(404);
        await expectUntouched('hidden');
      } finally {
        await db.execute(
          sql`UPDATE attachments SET status = 'ready', hidden_at = NULL WHERE id = ${descriptorId}`,
        );
      }
    });
  });
});
