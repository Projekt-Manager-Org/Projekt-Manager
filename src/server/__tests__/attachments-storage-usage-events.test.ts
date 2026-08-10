/**
 * API integration tests — `storage_usage_changed` emission per call site
 * (issue #171, ADR-0025).
 *
 * Pins AC-270 from verification.md §15.28: each of the v1 emitters sends
 * exactly one `storage_usage_changed` event post-commit to a subscribed
 * `/api/events` connection — and a tx that aborts emits nothing.
 *
 * v1 emitters under test (architecture.md §11.13):
 *
 *   1. AttachmentService.completeUpload (pending → ready)
 *   2. AttachmentService.hideAttachment (ready → hidden)
 *   3. AttachmentService.restoreAttachment (hidden → ready)
 *   4. attachment-hidden-reaper (hidden row delete)
 *   5. ProjectCrudService.purgeProject (FK cascade removes attachments)
 *   6. CustomerService.deleteCustomer (atomic archived-project purge)
 *
 * The orphan reaper is intentionally NOT in the emitter list — it
 * deletes only `pending` rows, which contribute zero to every counter
 * per data-model.md §5.14, so emission would be a wasted refetch with
 * identical bytes. Pinned by architecture.md §11.13 + AC-270. The two
 * cascade emitters (5, 6) gate emission on whether the cascade actually
 * removed byte-bearing rows for the same reason — purges of empty
 * projects, or pending-only projects, must stay silent.
 *
 * Failure isolation arm (architecture.md §11.13, AC-270 final clause):
 * a subscriber whose write throws does not break the originating
 * mutation — by the time the bus fires, the tx has already committed.
 *
 * Strategy:
 *   - Subscribe a fake `Connection` directly to the in-process bus
 *     (no need for the held HTTP stream — the bus contract is what AC-270
 *     pins; the route plumbing is covered in `attachments-events-route.test.ts`).
 *   - Drive each happy-path emitter via the existing service / route
 *     surface, then assert the fake connection observed exactly one
 *     `storage_usage_changed` frame.
 *   - For the abort arm, construct AttachmentService against a Proxy db
 *     whose `transaction()` rejects — the canonical way to force a
 *     post-validation tx fault without poking at the schema. Same
 *     pattern as `attachments-hidden-reaper.test.ts` L516-530 and the
 *     parity is deliberate: `mutate()` and `db.transaction()` are the
 *     single points the post-commit hook can hang off.
 *
 * The trigger arithmetic (counter values) is NOT pinned here — that's
 * `attachments-storage-usage.test.ts`'s job. This file pins ONLY the
 * SSE emission side: "did the event reach the bus, and only after the
 * tx committed".
 *
 * Pre-impl red state: the bus module + the AttachmentService / reaper
 * emission wiring don't exist yet, so:
 *   - `import('../sse/bus.js')` surfaces MODULE_NOT_FOUND per test.
 *   - Even if the bus existed, `completeUpload` / `hideAttachment` /
 *     `restoreAttachment` / both reapers wouldn't call `broadcast`.
 *   - The "no event on abort" arm passes only because the bus throws
 *     at import — once the bus lands but emission is wired BEFORE the
 *     tx commits (a regression), the abort arm flips red and pins the
 *     post-commit ordering. ACBS-clean.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';

import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { createStorageClient } from '../storage/client.js';
import { AttachmentService } from '../services/AttachmentService.js';
import type { AuthUser } from '../middleware/auth.js';
import { getEnv } from '../config/env.js';
import type { ServiceLogger } from '../services/Logger.js';

// ---------------------------------------------------------------------
// Bus module surface — guess. The implementer conforms or asks for a
// rename. Same module path as `attachments-sse-bus.test.ts` and
// `attachments-events-route.test.ts`.
// ---------------------------------------------------------------------

interface SseConnection {
  write(chunk: string): void;
}

interface SseBusModule {
  subscribe(c: SseConnection): void;
  unsubscribe(c: SseConnection): void;
}

async function loadBus(): Promise<SseBusModule> {
  // Dynamic import via a string variable so TS --noEmit does not block
  // the file. The bus module does not exist at step-3 time; the import
  // fails at runtime with MODULE_NOT_FOUND — the intended red surface.
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

function countStorageUsageEvents(conn: SubscribedFake): number {
  const matches = conn.chunks.join('').match(/event: storage_usage_changed/g);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------
// Fixtures shared across the AttachmentService arms.
// ---------------------------------------------------------------------

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

interface PhotoInitBody {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: 'foto';
  hasThumbnail: true;
  thumbSizeBytes: number;
  dekMaterial: string;
  ciphertextSizeBytes: number;
  ciphertextContentMd5: string;
  thumbDekMaterial: string;
  ciphertextThumbSizeBytes: number;
  ciphertextThumbContentMd5: string;
}

function photoInit(): PhotoInitBody {
  return {
    fileName: `att-${crypto.randomUUID().slice(0, 8)}.jpg`,
    mimeType: 'image/jpeg',
    sizeBytes: 4096,
    label: 'foto',
    hasThumbnail: true,
    thumbSizeBytes: 256,
    dekMaterial: freshDekMaterial(),
    ciphertextSizeBytes: 4160,
    ciphertextContentMd5: STUB_MD5_BASE64,
    thumbDekMaterial: freshDekMaterial(),
    ciphertextThumbSizeBytes: 320,
    ciphertextThumbContentMd5: STUB_MD5_BASE64,
  };
}

/**
 * Init + storage upload. Returns the attachment id; the caller decides
 * whether to complete / abandon the pending row. Mirrors the
 * `seedReadyAttachment` helper in attachments-routes.test.ts but stops
 * before completeUpload — the SSE-emission arm needs to drive complete
 * itself so the subscribed bus observes the event.
 */
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
    ciphertextBuffer(init.ciphertextThumbSizeBytes!),
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
  // Pick a non-terminal project so transitions / mutations don't hit
  // archive-state guards.
  const active = data.find((p) => p.status !== 'erledigt' && p.status !== 'archiviert');
  if (!active) throw new Error('seed has no active project');
  return active.id;
}

/**
 * Resolve any seeded customer id — used as the parent of fresh active
 * projects in the purge-cascade arms. The customer-delete arms create
 * their own customer fixtures via `createCustomer` so they can be
 * deleted atomically with their archived projects without touching
 * the seed.
 */
async function seededCustomerIdAny(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/customers');
  const customers = (res.json().customers ?? res.json().data) as Array<{ id: string }>;
  if (!Array.isArray(customers) || customers.length === 0) {
    throw new Error('seed has no customers');
  }
  return customers[0].id;
}

async function createActiveProject(ownerToken: string, customerId: string): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const res = await authPost(ownerToken, '/api/projects', {
    number: `EVT-${suffix}`,
    title: `Storage-event fixture ${suffix}`,
    customerId,
  });
  if (res.statusCode !== 201) {
    throw new Error(`fixture project create failed ${res.statusCode} ${res.body}`);
  }
  return res.json().id as string;
}

async function archiveProject(ownerToken: string, projectId: string): Promise<void> {
  const res = await authDelete(ownerToken, `/api/projects/${projectId}`);
  if (res.statusCode !== 200) {
    throw new Error(`fixture project archive failed ${res.statusCode} ${res.body}`);
  }
}

async function createCustomer(ownerToken: string): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const res = await authPost(ownerToken, '/api/customers', {
    name: `Evt-Cust-${suffix}`,
  });
  if (res.statusCode !== 201) {
    throw new Error(`fixture customer create failed ${res.statusCode} ${res.body}`);
  }
  return res.json().id as string;
}

// ---------------------------------------------------------------------
// Reaper-fixture helpers (raw SQL — backdate created_at / hidden_at past
// the reaper's TTL). Mirror the patterns in attachments-reaper.test.ts
// + attachments-hidden-reaper.test.ts.
// ---------------------------------------------------------------------

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

interface OrphanReaperDeps {
  db: Database;
  storage: ReturnType<typeof storageClient>;
  logger: ServiceLogger;
  ttlMinutes: number;
  now?: Date;
}

async function loadOrphanReaper(): Promise<(deps: OrphanReaperDeps) => Promise<void>> {
  const mod = (await import('../services/attachment-orphan-reaper.js')) as {
    runAttachmentOrphanReaper: (deps: OrphanReaperDeps) => Promise<void>;
  };
  return mod.runAttachmentOrphanReaper;
}

async function seedPendingBackdated(
  db: Database,
  projectId: string,
  createdAt: Date,
): Promise<string> {
  const id = crypto.randomUUID();
  // Pending rows carry no wrapped_dek (the row flips to ready after
  // HEAD-verify and version-id capture, which is when the envelope
  // commits to the row in production paths). Schema allows NULL.
  await db.execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       ciphertext_size_bytes,
       original_key, thumb_key, has_thumbnail, version_id, created_at,
       wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
    VALUES (${id}, ${projectId}, 'pending', 'binary', 'sonstiges',
            ${'oreap-' + id.slice(0, 6)}, 'application/pdf', 2048,
            NULL,
            ${`attachments/${projectId}/${id}.orig`}, NULL, FALSE,
            NULL, ${createdAt.toISOString()},
            NULL, NULL, 1)
  `);
  return id;
}

// ---------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------

describe('storage_usage_changed emission per call site (AC-270)', () => {
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

  // -------------------------------------------------------------------
  // (1) AttachmentService.completeUpload — pending → ready.
  // -------------------------------------------------------------------
  describe('AC-270: AttachmentService.completeUpload (pending → ready) emits exactly one event', () => {
    it('a subscribed connection observes one storage_usage_changed event after a successful complete', async () => {
      const bus = await loadBus();
      const conn = subscribeFake(bus);
      const projectId = await projectIdAny(ownerToken);

      try {
        const { attachmentId } = await initAndUploadPending(ownerToken, projectId);
        // Pre-condition: init does NOT emit storage_usage_changed —
        // pending rows do not affect the counters (data-model.md §5.14),
        // so AC-270's emitter list deliberately excludes init.
        expect(countStorageUsageEvents(conn)).toBe(0);

        const completeRes = await authPost(
          ownerToken,
          `/api/projects/${projectId}/attachments/${attachmentId}/complete`,
        );
        expect(completeRes.statusCode).toBe(200);

        // Post-commit hook fires synchronously after `markReady` commits.
        // Allow the microtask queue to drain in case the implementer
        // chooses a `setImmediate` post-commit shape (parity with
        // architecture.md §11.11's notification publisher).
        await new Promise<void>((r) => setImmediate(r));

        expect(countStorageUsageEvents(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (2) AttachmentService.hideAttachment — ready → hidden.
  // -------------------------------------------------------------------
  describe('AC-270: AttachmentService.hideAttachment (ready → hidden) emits exactly one event', () => {
    it('a subscribed connection observes one storage_usage_changed event after a successful hide', async () => {
      const bus = await loadBus();
      const projectId = await projectIdAny(ownerToken);
      const attachmentId = await seedReadyAttachment(ownerToken, projectId);

      // Subscribe AFTER the seed so the seed's complete-event does not
      // pollute the count. Unsubscribe in finally — the bus is global
      // and a leaked subscriber would observe events from sibling tests.
      const conn = subscribeFake(bus);
      try {
        const hideRes = await authDelete(
          ownerToken,
          `/api/projects/${projectId}/attachments/${attachmentId}`,
        );
        expect(hideRes.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        expect(countStorageUsageEvents(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (3) AttachmentService.restoreAttachment — hidden → ready.
  // -------------------------------------------------------------------
  describe('AC-270: AttachmentService.restoreAttachment (hidden → ready) emits exactly one event', () => {
    it('a subscribed connection observes one storage_usage_changed event after a successful restore', async () => {
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

        expect(countStorageUsageEvents(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (4) attachment-hidden-reaper — hidden row delete.
  //
  // The orphan reaper is intentionally not tested as an emitter — it
  // deletes only `pending` rows, which contribute zero to every counter,
  // so emission would be wasted (architecture.md §11.13).
  // -------------------------------------------------------------------
  describe('AC-270: attachment-hidden-reaper (hidden delete) emits exactly one event per purged row', () => {
    it('a subscribed connection observes one storage_usage_changed event after each hidden delete', async () => {
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

        expect(countStorageUsageEvents(conn)).toBe(2);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // Orphan reaper — the negative case AC-270 names explicitly:
  // "The orphan reaper deletes only `pending` rows, which contribute
  // zero to every counter — no event is emitted."  Without an explicit
  // assertion, a regression that wires the same hook into the orphan
  // reaper would pass green.
  // -------------------------------------------------------------------
  describe('AC-270: attachment-orphan-reaper (pending delete) emits no event', () => {
    it('a subscribed connection observes zero storage_usage_changed events after the sweep', async () => {
      const bus = await loadBus();
      const runOrphanReaper = await loadOrphanReaper();
      const projectId = await projectIdAny(ownerToken);

      const now = new Date();
      const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      await seedPendingBackdated(db, projectId, cutoff);
      await seedPendingBackdated(db, projectId, cutoff);

      const conn = subscribeFake(bus);
      try {
        await runOrphanReaper({
          db,
          // Real storage client — best-effort `.hide` on the seeded
          // keys; missing-object errors are tolerated by the reaper
          // (data-model.md §6.11) and irrelevant to this assertion.
          storage: storageClient(),
          logger: { info: vi.fn(), error: vi.fn() } as unknown as ServiceLogger,
          ttlMinutes: 1,
          now,
        });

        await new Promise<void>((r) => setImmediate(r));

        expect(countStorageUsageEvents(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (5) ProjectCrudService.purgeProject — FK-cascade attachment removal.
  //
  // AC-270 requires emission whenever the cascade removes byte-bearing
  // rows (`ready` or `hidden`), and silence when it removes nothing
  // counter-moving (zero attachments, or `pending`-only). Three arms
  // pin the trichotomy.
  // -------------------------------------------------------------------
  describe('AC-270: ProjectCrudService.purgeProject (cascade) emits exactly one event when bytes moved', () => {
    it('a subscribed connection observes one storage_usage_changed event after a purge that cascades a ready attachment', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      // Seed a ready attachment, then archive — the archive itself does
      // not move counters (status stays ready, only `projects.deleted`
      // flips), so subscribing AFTER the archive isolates the purge
      // event from the seed's complete-emission.
      await seedReadyAttachment(ownerToken, projectId);
      await archiveProject(ownerToken, projectId);

      const conn = subscribeFake(bus);
      try {
        const purgeRes = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
        expect(purgeRes.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        expect(countStorageUsageEvents(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });

    it('a subscribed connection observes zero events after purging a project with no attachments', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      await archiveProject(ownerToken, projectId);

      const conn = subscribeFake(bus);
      try {
        const purgeRes = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
        expect(purgeRes.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        // No byte-bearing rows ⇒ no event. Emitting here would force
        // every observer into an identical refetch.
        expect(countStorageUsageEvents(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });

    it('a subscribed connection observes zero events after purging a project carrying only pending rows', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      // Seed a pending row directly — do not flip to ready, otherwise
      // the complete emission contaminates a later count.
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await seedPendingBackdated(db, projectId, cutoff);
      await archiveProject(ownerToken, projectId);

      const conn = subscribeFake(bus);
      try {
        const purgeRes = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
        expect(purgeRes.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        // Pending rows contribute zero on every counter — purging them
        // does not move the global figure, so no event must fire.
        expect(countStorageUsageEvents(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (6) CustomerService.deleteCustomer — atomic archived-project purge.
  //
  // AC-91 says the customer-delete cascade purges every archived project
  // atomically. AC-270 says a single event fires when at least one of
  // those projects carried a byte-bearing row, and zero events fire
  // otherwise (no archived projects, or archived projects had only
  // pending / no attachments). Fan-in collapses to a single event even
  // when multiple archived projects are purged atomically — observers
  // refetch the global figure once per commit, not per project.
  // -------------------------------------------------------------------
  describe('AC-270: CustomerService.deleteCustomer (cascade) emits exactly one event when bytes moved', () => {
    it('a subscribed connection observes one event after deleting a customer whose archived project carried a ready attachment', async () => {
      const bus = await loadBus();
      const customerId = await createCustomer(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      await seedReadyAttachment(ownerToken, projectId);
      await archiveProject(ownerToken, projectId);

      const conn = subscribeFake(bus);
      try {
        const delRes = await authDelete(ownerToken, `/api/customers/${customerId}`);
        expect(delRes.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        expect(countStorageUsageEvents(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });

    it('a subscribed connection observes zero events after deleting a customer with no projects at all', async () => {
      const bus = await loadBus();
      const customerId = await createCustomer(ownerToken);

      const conn = subscribeFake(bus);
      try {
        const delRes = await authDelete(ownerToken, `/api/customers/${customerId}`);
        expect(delRes.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        expect(countStorageUsageEvents(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });

    it('a subscribed connection observes zero events when archived projects had no byte-bearing attachments', async () => {
      const bus = await loadBus();
      const customerId = await createCustomer(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      // Archive the project without ever attaching anything — the
      // cascade will remove a project_storage_usage row whose four
      // counters are all zero, so the global figure does not move.
      await archiveProject(ownerToken, projectId);

      const conn = subscribeFake(bus);
      try {
        const delRes = await authDelete(ownerToken, `/api/customers/${customerId}`);
        expect(delRes.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        expect(countStorageUsageEvents(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // Post-commit ordering — a tx that aborts emits NO event. Pinned for
  // completeUpload via a Proxy db whose `transaction()` rejects;
  // mutate()-based paths (hide / restore) and the reapers ride on the
  // same hook so the same ordering rule applies (AC-270 "Emission is
  // post-commit"). Pinning one path is sufficient under T-REDU.
  // -------------------------------------------------------------------
  describe('AC-270: a transaction that aborts emits no storage_usage_changed event', () => {
    it('completeUpload that throws inside the markReady transaction emits no event', async () => {
      const bus = await loadBus();
      const env = getEnv();
      const projectId = await projectIdAny(ownerToken);

      // Init + storage upload happen on the real db via the route — we
      // need a real pending row + real backing bytes for completeUpload
      // to reach the markReady transaction.
      const { attachmentId } = await initAndUploadPending(ownerToken, projectId);

      // Wrap the real db with a Proxy that rejects on `.transaction()`.
      // completeUpload's flip from pending → ready runs inside
      // db.transaction(...) (AttachmentService.ts L792-794), so this is
      // the canonical "tx aborted" injection point. Mirrors the pattern
      // in attachments-hidden-reaper.test.ts L516-530.
      const flakyDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'transaction') {
            return () => Promise.reject(new Error('simulated-tx-abort'));
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as Database;

      const owner = await resolveOwnerAuthUser(db);

      const service = new AttachmentService({
        db: flakyDb,
        storage: storageClient(),
        binaryAgeRecipient: env.BINARY_AGE_RECIPIENT ?? '',
        binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH!,
      });

      const conn = subscribeFake(bus);
      try {
        const log: ServiceLogger = {
          info: vi.fn(),
          error: vi.fn(),
          warn: vi.fn(),
        } as unknown as ServiceLogger;

        await expect(service.completeUpload(owner, projectId, attachmentId, log)).rejects.toThrow(
          /simulated-tx-abort/,
        );

        await new Promise<void>((r) => setImmediate(r));

        // Post-commit ordering: a tx that aborts MUST NOT emit
        // (architecture.md §11.13 + verification.md AC-270). A
        // regression that calls broadcast() before the transaction
        // commits — or in a `try` block that swallows the rollback
        // — would land an event on `conn` here.
        expect(countStorageUsageEvents(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // Failure isolation at the emission boundary — a subscriber that
  // throws on write does not break the originating mutation. AC-270
  // final clause + architecture.md §11.13 "the originating mutation
  // has already committed and is unaffected".
  // -------------------------------------------------------------------
  describe('AC-270: a throwing subscriber does not affect the originating mutation', () => {
    it('completeUpload completes successfully when a subscribed connection throws on write', async () => {
      const bus = await loadBus();
      const projectId = await projectIdAny(ownerToken);
      const { attachmentId } = await initAndUploadPending(ownerToken, projectId);

      const failing: SseConnection = {
        write(): void {
          throw new Error('subscriber-write-failed');
        },
      };
      bus.subscribe(failing);

      try {
        const completeRes = await authPost(
          ownerToken,
          `/api/projects/${projectId}/attachments/${attachmentId}/complete`,
        );
        // The mutation is unaffected — committed before the bus
        // dispatched, so a downstream-writer fault cannot roll it back.
        expect(completeRes.statusCode).toBe(200);
        const body = completeRes.json() as { status: string };
        expect(body.status).toBe('ready');
      } finally {
        bus.unsubscribe(failing);
      }
    });
  });
});

/**
 * Resolve the seeded owner row as an `AuthUser` shape — the shape the
 * AttachmentService methods expect when called outside a Fastify request
 * lifecycle. The route layer normally builds this from the session row;
 * here we read the `users` table directly for the abort arm where we
 * call the service in-process.
 */
async function resolveOwnerAuthUser(db: Database): Promise<AuthUser> {
  const row = await db.execute(
    sql`SELECT id, username, display_name, roles FROM users
        WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
  );
  const r = row.rows[0] as
    { id: string; username: string; display_name: string; roles: string[] } | undefined;
  if (!r) throw new Error('seed missing owner user');
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    roles: r.roles,
  } as AuthUser;
}
