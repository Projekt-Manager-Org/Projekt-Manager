/**
 * API integration tests — `attachment_changed` emission per call site
 * (#237, ADR-0025).
 *
 * Pins AC-336 from verification.md §15.28: each attachment mutation that
 * changes a project's attachment list emits one `attachment_changed`
 * frame post-commit to a subscribed `/api/events` connection. This is
 * the emit half of the gallery cross-user view-sync fix; the consumer
 * refetch is AC-337 (`attachmentSseSubscription.test.ts`) and the
 * two-browser value test is AC-338 (e2e).
 *
 * Emitter list under test (co-located with the `storage_usage_changed`
 * emits pinned by AC-270):
 *
 *   1. AttachmentService.completeUpload (pending → ready)
 *   2. AttachmentService.hideAttachment (ready → hidden)
 *   3. AttachmentService.restoreAttachment (hidden → ready)
 *   4. attachment-hidden-reaper (hidden row delete — one frame per row)
 *
 * `init` (pending row creation) is deliberately NOT an emitter — a
 * pending row is invisible to the gallery and the Papierkorb, so an
 * emit would be a wasted refetch (parity with AC-270's init exclusion).
 *
 * Post-commit ordering ("a tx that aborts emits nothing") and
 * subscriber-failure isolation are NOT re-pinned here: `attachment_changed`
 * rides the exact same `broadcast()` / bus hook as `storage_usage_changed`,
 * co-emitted one line apart, so those properties are already proven by
 * `attachments-storage-usage-events.test.ts` (T-REDU — pinning one path
 * on a shared mechanism is sufficient).
 *
 * Harness mirrors `attachments-storage-usage-events.test.ts`: subscribe a
 * fake connection to the in-process bus and count the frames of interest.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';

import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import type { ServiceLogger } from '../services/Logger.js';

interface SseConnection {
  write(chunk: string): void;
}
interface SseBusModule {
  subscribe(c: SseConnection): void;
  unsubscribe(c: SseConnection): void;
}
async function loadBus(): Promise<SseBusModule> {
  const path = '../sse/bus.js';
  return (await import(/* @vite-ignore */ path)) as unknown as SseBusModule;
}

interface SubscribedFake extends SseConnection {
  chunks: string[];
}
function subscribeFake(bus: SseBusModule): SubscribedFake {
  const conn: SubscribedFake = {
    chunks: [],
    write(chunk: string): void {
      this.chunks.push(chunk);
    },
  };
  bus.subscribe(conn);
  return conn;
}
function countAttachmentChangedEvents(conn: SubscribedFake): number {
  const matches = conn.chunks.join('').match(/event: attachment_changed/g);
  return matches ? matches.length : 0;
}

const STUB_MD5_BASE64 = '1B2M2Y8AsgTpgAmY7PhCfg==';
function freshDekMaterial(): string {
  return crypto.randomBytes(32).toString('base64');
}
function ciphertextBuffer(length: number): Buffer {
  return crypto.randomBytes(length);
}
function storageClient() {
  const env = getEnv();
  return createStorageClient({
    endpoint: env.STORAGE_ENDPOINT!,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY!,
    secretKey: env.STORAGE_SECRET_KEY!,
  });
}

function photoInit() {
  return {
    fileName: `att-${crypto.randomUUID().slice(0, 8)}.jpg`,
    mimeType: 'image/jpeg',
    sizeBytes: 4096,
    label: 'foto' as const,
    hasThumbnail: true as const,
    thumbSizeBytes: 256,
    dekMaterial: freshDekMaterial(),
    ciphertextSizeBytes: 4160,
    ciphertextContentMd5: STUB_MD5_BASE64,
    thumbDekMaterial: freshDekMaterial(),
    ciphertextThumbSizeBytes: 320,
    ciphertextThumbContentMd5: STUB_MD5_BASE64,
  };
}

async function initAndUploadPending(
  ownerToken: string,
  projectId: string,
): Promise<{ attachmentId: string }> {
  const init = photoInit();
  const initRes = await authPost(
    ownerToken,
    `/api/projects/${projectId}/attachments/init`,
    init as unknown as Record<string, unknown>,
  );
  if (initRes.statusCode !== 201) {
    throw new Error(`init failed ${initRes.statusCode} ${initRes.body}`);
  }
  const body = initRes.json() as {
    attachment: { id: string; originalKey: string; thumbKey: string };
  };
  const s = storageClient();
  await s.upload(
    body.attachment.originalKey,
    ciphertextBuffer(init.ciphertextSizeBytes),
    'application/octet-stream',
  );
  await s.upload(
    body.attachment.thumbKey,
    ciphertextBuffer(init.ciphertextThumbSizeBytes),
    'application/octet-stream',
  );
  return { attachmentId: body.attachment.id };
}

async function seedReadyAttachment(ownerToken: string, projectId: string): Promise<string> {
  const { attachmentId } = await initAndUploadPending(ownerToken, projectId);
  const completeRes = await authPost(
    ownerToken,
    `/api/projects/${projectId}/attachments/${attachmentId}/complete`,
  );
  if (completeRes.statusCode !== 200) {
    throw new Error(`complete failed ${completeRes.statusCode} ${completeRes.body}`);
  }
  return attachmentId;
}

async function seedHiddenAttachment(ownerToken: string, projectId: string): Promise<string> {
  const id = await seedReadyAttachment(ownerToken, projectId);
  const hideRes = await authDelete(ownerToken, `/api/projects/${projectId}/attachments/${id}`);
  if (hideRes.statusCode !== 204) {
    throw new Error(`hide failed ${hideRes.statusCode} ${hideRes.body}`);
  }
  return id;
}

async function projectIdAny(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const data = res.json().data as { id: string; status: string }[];
  const active = data.find((p) => p.status !== 'erledigt' && p.status !== 'archiviert');
  if (!active) throw new Error('seed has no active project');
  return active.id;
}

async function seedHiddenBackdated(
  db: Database,
  projectId: string,
  hiddenAt: Date,
): Promise<string> {
  const id = crypto.randomUUID();
  const wrappedDek = Buffer.alloc(192, 0x77).toString('base64');
  await db.execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       ciphertext_size_bytes,
       original_key, thumb_key, has_thumbnail, version_id, hidden_at,
       wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
    VALUES (${id}, ${projectId}, 'hidden', 'binary', 'sonstiges',
            ${'hreap-' + id.slice(0, 6)}, 'application/pdf', 2048,
            2064,
            ${`attachments/${projectId}/${id}.orig`}, NULL, FALSE,
            ${'v-' + id.slice(0, 8)}, ${hiddenAt.toISOString()},
            ${wrappedDek}, NULL, 1)
  `);
  return id;
}

async function loadHiddenReaper(): Promise<
  (deps: { db: Database; logger: ServiceLogger; ttlMinutes: number; now?: Date }) => Promise<void>
> {
  const mod = (await import('../services/attachment-hidden-reaper.js')) as {
    runAttachmentHiddenReaper: (deps: {
      db: Database;
      logger: ServiceLogger;
      ttlMinutes: number;
      now?: Date;
    }) => Promise<void>;
  };
  return mod.runAttachmentHiddenReaper;
}

describe('attachment_changed emission per call site (AC-336, #237)', () => {
  let ownerToken: string;
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
  });

  afterAll(async () => {
    await pool.end();
    await stopApp();
  });

  it('completeUpload (pending → ready) emits one attachment_changed; init emits none', async () => {
    const bus = await loadBus();
    const conn = subscribeFake(bus);
    const projectId = await projectIdAny(ownerToken);
    try {
      const { attachmentId } = await initAndUploadPending(ownerToken, projectId);
      // A pending row is invisible to the gallery — init must not emit.
      expect(countAttachmentChangedEvents(conn)).toBe(0);

      const completeRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attachmentId}/complete`,
      );
      expect(completeRes.statusCode).toBe(200);
      await new Promise<void>((r) => setImmediate(r));

      expect(countAttachmentChangedEvents(conn)).toBe(1);
    } finally {
      bus.unsubscribe(conn);
    }
  });

  it('hideAttachment (ready → hidden) emits one attachment_changed', async () => {
    const bus = await loadBus();
    const projectId = await projectIdAny(ownerToken);
    const attachmentId = await seedReadyAttachment(ownerToken, projectId);

    const conn = subscribeFake(bus);
    try {
      const hideRes = await authDelete(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attachmentId}`,
      );
      expect(hideRes.statusCode).toBe(204);
      await new Promise<void>((r) => setImmediate(r));

      expect(countAttachmentChangedEvents(conn)).toBe(1);
    } finally {
      bus.unsubscribe(conn);
    }
  });

  it('restoreAttachment (hidden → ready) emits one attachment_changed', async () => {
    const bus = await loadBus();
    const projectId = await projectIdAny(ownerToken);
    const attachmentId = await seedHiddenAttachment(ownerToken, projectId);

    const conn = subscribeFake(bus);
    try {
      const restoreRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attachmentId}/restore`,
      );
      expect(restoreRes.statusCode).toBe(200);
      await new Promise<void>((r) => setImmediate(r));

      expect(countAttachmentChangedEvents(conn)).toBe(1);
    } finally {
      bus.unsubscribe(conn);
    }
  });

  it('attachment-hidden-reaper emits one attachment_changed per purged row', async () => {
    const bus = await loadBus();
    const runHiddenReaper = await loadHiddenReaper();
    const projectId = await projectIdAny(ownerToken);

    const now = new Date();
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await seedHiddenBackdated(db, projectId, cutoff);
    await seedHiddenBackdated(db, projectId, cutoff);

    const conn = subscribeFake(bus);
    try {
      await runHiddenReaper({
        db,
        logger: { info: vi.fn(), error: vi.fn() } as unknown as ServiceLogger,
        ttlMinutes: 1,
        now,
      });
      await new Promise<void>((r) => setImmediate(r));

      expect(countAttachmentChangedEvents(conn)).toBe(2);
    } finally {
      bus.unsubscribe(conn);
    }
  });
});
