/**
 * API integration tests — `project_changed` emission per call site
 * (issue #176, ADR-0025).
 *
 * Pins AC-276 from verification.md §15.28: each of the ten project-
 * mutation sites enumerated in architecture.md §11.13 emits exactly
 * one `project_changed` event post-commit to a subscribed `/api/events`
 * connection — and a tx that aborts emits nothing. AC-276 cross-refs
 * AC-270 for failure-isolation, post-commit, and tx-abort posture, so
 * those arms are pinned narrowly here (the broad bus-level isolation
 * lives in `attachments-sse-bus.test.ts`).
 *
 * v1 emitters under test (architecture.md §11.13):
 *
 *   1. ProjectCrudService.createProject
 *   2. ProjectCrudService.updateProject (field-only branch)
 *   3. ProjectCrudService.updateProject (assigned-worker-only branch)
 *   4. ProjectCrudService.deleteProject (soft-delete / archive)
 *   5. ProjectCrudService.restoreProject (un-archive)
 *   6. ProjectCrudService.purgeProject (hard delete)
 *   7. ProjectTransitionService.transitionForward (+1)
 *   8. ProjectTransitionService.transitionBackward (-1)
 *   9. ProjectDatesService.updateDates (planned start / end edit)
 *  10. CustomerService.deleteCustomer (cascade with archived projects)
 *  11. ImportService.import — non-dry-run, both branches:
 *      a. override path (TRUNCATE + re-insert into a non-empty target)
 *      b. empty-target path (insert into empty tables; the seed-equivalent path)
 *
 * Silence cases:
 *   - CustomerService.deleteCustomer with zero archived projects
 *   - ImportService.import dry-run
 *   - A mutation that aborts inside its transaction
 *
 * Co-emission independence — the two cascading sites that may also
 * emit `storage_usage_changed`:
 *   - purgeProject of an archived project that carried a ready
 *     attachment ⇒ one `project_changed` AND one `storage_usage_changed`
 *   - purgeProject of an archived project with no byte-bearing rows ⇒
 *     one `project_changed`, zero `storage_usage_changed`
 *   - deleteCustomer of a customer whose archived project carried no
 *     attachments ⇒ one `project_changed`, zero `storage_usage_changed`
 *   - deleteCustomer of a customer whose archived project carried a
 *     ready attachment ⇒ one `project_changed` AND one `storage_usage_changed`
 *
 * Strategy:
 *   - Subscribe a fake `Connection` directly to the in-process bus and
 *     drive each happy-path emitter via the existing service / route
 *     surface, then assert the fake connection observed exactly one
 *     `project_changed` frame post-commit. Mirrors AC-270's
 *     `attachments-storage-usage-events.test.ts` exactly.
 *   - For the tx-abort arm, construct ProjectCrudService against a
 *     Proxy db whose `transaction()` rejects — the canonical "tx
 *     aborted" injection point. Same pattern as AC-270's tx-abort arm.
 *   - Wire-string pin: assert against the constant `PROJECT_CHANGED`
 *     from `src/config/sseEvents.ts`. The constant does not yet exist
 *     at step-3 time — the static import surfaces a TypeScript /
 *     module-resolution error and the suite fails red. That is the
 *     intended TDD signal.
 *
 * The trigger arithmetic (counter values, projects-list deltas) is NOT
 * pinned here — that is the per-service test files' job. This file
 * pins ONLY the SSE emission side: "did the event reach the bus, and
 * only after the tx committed".
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';

import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPatch,
  authDelete,
} from '../../test/api-helpers.js';
import {
  SEED_DEFAULT_PASSWORD,
  SEED_USERS,
  EXPECTED_RESTORE_PHRASE,
} from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { seed } from '../seed.js';
import type { Database } from '../db/connection.js';
import { createStorageClient } from '../storage/client.js';
import { ProjectCrudService } from '../services/ProjectCrudService.js';
import { getEnv } from '../config/env.js';
import type { ServiceLogger } from '../services/Logger.js';
// Wire-string pin — AC-276 names the literal `project_changed` on the
// SSE `event:` line (api.md §14.2.13, architecture.md §11.13). The
// constant lives in the shared catalog; the static import is the
// load-bearing red signal at step-3 time. Once the implementer adds
// `PROJECT_CHANGED` next to `STORAGE_USAGE_CHANGED`, this import
// resolves and the runtime arms run.
import { PROJECT_CHANGED, STORAGE_USAGE_CHANGED } from '../../config/sseEvents.js';

// ---------------------------------------------------------------------
// Bus module surface — same shape AC-270 uses. Dynamic import via a
// string variable so a pre-implementation typo on the catalog constant
// is the surfacing failure rather than a TS resolution error inside
// this file. (The bus module itself already exists; the constant does
// not. The static import above carries the red signal.)
// ---------------------------------------------------------------------

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

function countEvents(conn: SubscribedFake, eventName: string): number {
  // Anchor on `event: <name>\n` so a substring match between event
  // names cannot collide (e.g. `project_changed` is not a prefix of
  // anything in the catalog today, but the anchor keeps the assertion
  // robust if a sibling event lands later).
  const matches = conn.chunks.join('').match(new RegExp(`event: ${eventName}\\n`, 'g'));
  return matches ? matches.length : 0;
}

function countProjectChanged(conn: SubscribedFake): number {
  return countEvents(conn, PROJECT_CHANGED);
}

function countStorageUsageChanged(conn: SubscribedFake): number {
  return countEvents(conn, STORAGE_USAGE_CHANGED);
}

// ---------------------------------------------------------------------
// Fixtures.
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
 * Init + storage upload + complete. Returns the ready attachment id.
 * Mirrors `seedReadyAttachment` in `attachments-storage-usage-events.test.ts`.
 * Each step writes through the route layer so production wiring is
 * exercised; the only thing tests stub is the actor (the seeded owner).
 */
async function seedReadyAttachment(ownerToken: string, projectId: string): Promise<string> {
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
  const completeRes = await authPost(
    ownerToken,
    `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
  );
  if (completeRes.statusCode !== 200) {
    throw new Error(`complete failed ${completeRes.statusCode} ${completeRes.body}`);
  }
  return body.attachment.id;
}

async function seededCustomerIdAny(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/customers');
  const customers = (res.json().customers ?? res.json().data) as Array<{ id: string }>;
  if (!Array.isArray(customers) || customers.length === 0) {
    throw new Error('seed has no customers');
  }
  return customers[0].id;
}

async function createActiveProject(
  ownerToken: string,
  customerId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const res = await authPost(ownerToken, '/api/projects', {
    number: `EVT-${suffix}`,
    title: `Project-event fixture ${suffix}`,
    customerId,
    ...overrides,
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

/**
 * Resolve a worker user id from the seed — used by the assigned-worker-
 * only branch of updateProject, which mutates the `project_workers`
 * join without touching the projects row. AC-276 names this branch
 * explicitly because the join is part of the project read surface.
 */
async function seededWorkerIdAny(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/users');
  const data = res.json() as { users?: Array<{ id: string; roles: string[]; active: boolean }> };
  const users = data.users ?? [];
  const worker = users.find(
    (u) => Array.isArray(u.roles) && u.roles.includes('worker') && u.active,
  );
  if (!worker) throw new Error('seed has no active worker user');
  return worker.id;
}

/**
 * Build a minimal valid envelope distinct from the seed so the
 * override path actually replaces business data. The shape mirrors
 * `buildOverrideEnvelope` in `data-exchange.test.ts`. AC-276 pins
 * exactly one `project_changed` per successful non-dry-run commit
 * (architecture.md §11.13: "one coarse signal is sufficient for every
 * consumer to refetch") and zero events per dry-run. Both non-dry-run
 * branches reuse this envelope: the override test runs it against a
 * non-empty target; the empty-target test wipes the tables first.
 */
const CURRENT_SCHEMA_VERSION = 3;

function uuidWithPrefix(prefix: string, i: number): string {
  const hex = Array.from(prefix)
    .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(8, '0')
    .slice(0, 8);
  const n = String(i).padStart(12, '0');
  return `${hex}-0000-4000-8000-${n}`;
}

function buildOverrideEnvelope(): Record<string, unknown> {
  // Deterministic per-test-run UUIDs would collide on a re-run; lift
  // the high-order bits with a random nonce so each test build inserts
  // a fresh corpus. The override path TRUNCATEs first, so the previous
  // run's rows are gone before these land — but a deterministic ID
  // would still re-collide with the seed snapshot if the seed is
  // re-applied after a previous override.
  //
  // Issue #230 (v3): `company_profile` ships the singleton — the
  // importer rejects anything other than exactly one row. `users` is
  // empty (the override path wipes target.users and lands no replacements;
  // sibling tests reseed after the test). The empty-slot path through
  // ImportService is still cheap.
  const nonce = Math.floor(Math.random() * 1_000_000);
  const customerId = uuidWithPrefix('cus', nonce % 9999);
  const projectId = uuidWithPrefix('pro', nonce % 9999);
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    users: [],
    company_profile: [
      {
        id: uuidWithPrefix('cp', nonce % 9999),
        companyName: 'Fixture Maler GmbH',
        address: { street: 'Fixturestr. 1', zip: '10115', city: 'Berlin' },
        taxId: '111/222/33333',
        ustId: 'DE123456789',
        iban: 'DE12 1000 0000 1234 5678 90',
        accentColor: null,
        footerText: null,
        logoBinaryDescriptorId: null,
        defaultTaxMode: 'standard',
        updatedAt: '2026-01-03T00:00:00.000Z',
        updatedBy: null,
      },
    ],
    customers: [
      {
        id: customerId,
        name: 'Override-Cascade Customer',
        phone: null,
        email: null,
        address: null,
        ustId: null,
        notes: null,
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    projects: [
      {
        id: projectId,
        number: `2026-OV-${nonce}`,
        title: 'Override-Cascade Project',
        status: 'anfrage',
        statusChangedAt: '2026-02-05T00:00:00.000Z',
        customerId,
        plannedStart: null,
        plannedEnd: null,
        estimatedValue: null,
        notes: null,
        deleted: false,
        createdAt: '2026-02-05T00:00:00.000Z',
        updatedAt: '2026-02-05T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    project_workers: [],
    invoices: [],
    invoice_sequence: [],
    confirmation_phrase: EXPECTED_RESTORE_PHRASE,
  };
}

// ---------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------

describe('AC-276: project_changed emission from every project-mutation site', () => {
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
  // (1) ProjectCrudService.createProject — new row visible to every
  // project list / detail consumer (architecture.md §11.13).
  // -------------------------------------------------------------------
  describe('AC-276: ProjectCrudService.createProject emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after a successful create', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);

      const conn = subscribeFake(bus);
      try {
        const suffix = crypto.randomUUID().slice(0, 8);
        const res = await authPost(ownerToken, '/api/projects', {
          number: `EVT-${suffix}`,
          title: `Create-event fixture ${suffix}`,
          customerId,
        });
        expect(res.statusCode).toBe(201);

        // Post-commit hook fires after the create transaction commits.
        // Allow the microtask queue to drain in case the implementer
        // chooses a `setImmediate` post-commit shape (parity with
        // architecture.md §11.11's notification publisher).
        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (2) ProjectCrudService.updateProject — field-only branch.
  //
  // Mutates `title` / `notes` only — the projects row is touched, the
  // project_workers join is not. AC-276 pins emission on every successful
  // updateProject return.
  // -------------------------------------------------------------------
  describe('AC-276: ProjectCrudService.updateProject (field-only branch) emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after a title/notes update', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);

      // Subscribe AFTER the seed so the seed's create-event does not
      // pollute the count. Same isolation pattern as AC-270's hide /
      // restore arms.
      const conn = subscribeFake(bus);
      try {
        const res = await authPatch(ownerToken, `/api/projects/${projectId}`, {
          title: 'Updated title for AC-276',
          notes: 'Field-only branch — no worker mutation.',
        });
        expect(res.statusCode).toBe(200);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (3) ProjectCrudService.updateProject — assigned-worker-only branch.
  //
  // Mutates `assignedWorkerIds` only. The projects row is unchanged but
  // the join is part of the read surface (architecture.md §11.13:
  // "the assigned-worker-only path that writes only `project_workers`").
  // Without this arm a regression that gates emission on
  // `hasFieldUpdate` would silently drop the join change.
  // -------------------------------------------------------------------
  describe('AC-276: ProjectCrudService.updateProject (assigned-worker-only branch) emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after writing only project_workers', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      const workerId = await seededWorkerIdAny(ownerToken);

      const conn = subscribeFake(bus);
      try {
        const res = await authPatch(ownerToken, `/api/projects/${projectId}`, {
          // Only the join changes — no `title` / `notes` / etc. The
          // service's `hasFieldUpdate` branch evaluates to false; the
          // post-commit emit MUST still fire because the join is part
          // of the project read surface.
          assignedWorkerIds: [workerId],
        });
        expect(res.statusCode).toBe(200);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (4) ProjectCrudService.deleteProject — soft-delete / archive.
  // -------------------------------------------------------------------
  describe('AC-276: ProjectCrudService.deleteProject (archive) emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after a successful archive', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);

      const conn = subscribeFake(bus);
      try {
        const res = await authDelete(ownerToken, `/api/projects/${projectId}`);
        expect(res.statusCode).toBe(200);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (5) ProjectCrudService.restoreProject — un-archive.
  // -------------------------------------------------------------------
  describe('AC-276: ProjectCrudService.restoreProject (un-archive) emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after a successful restore', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      await archiveProject(ownerToken, projectId);

      const conn = subscribeFake(bus);
      try {
        const res = await authPost(ownerToken, `/api/projects/${projectId}/restore`);
        expect(res.statusCode).toBe(200);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (6) ProjectCrudService.purgeProject — hard delete of an archived
  // row. Always emits `project_changed` (the row is being deleted),
  // independently of whether the cascade also moved bytes.
  // -------------------------------------------------------------------
  describe('AC-276: ProjectCrudService.purgeProject (hard delete) emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after a successful purge', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      await archiveProject(ownerToken, projectId);

      const conn = subscribeFake(bus);
      try {
        const res = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
        expect(res.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
        expect(countStorageUsageChanged(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (7) ProjectTransitionService.transitionForward — `+1` workflow
  // transition. Default-created projects start in `anfrage`; `angebot`
  // is the next state.
  // -------------------------------------------------------------------
  describe('AC-276: ProjectTransitionService.transitionForward emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after a +1 transition', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);

      const conn = subscribeFake(bus);
      try {
        const res = await authPost(ownerToken, `/api/projects/${projectId}/transition/forward`, {
          expectedStatus: 'anfrage',
        });
        expect(res.statusCode).toBe(200);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (8) ProjectTransitionService.transitionBackward — `-1` workflow
  // transition. Drive the project forward once, then back.
  // -------------------------------------------------------------------
  describe('AC-276: ProjectTransitionService.transitionBackward emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after a -1 transition', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      const forwardRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/transition/forward`,
        { expectedStatus: 'anfrage' },
      );
      if (forwardRes.statusCode !== 200) {
        throw new Error(`fixture transition failed ${forwardRes.statusCode} ${forwardRes.body}`);
      }

      const conn = subscribeFake(bus);
      try {
        const res = await authPost(ownerToken, `/api/projects/${projectId}/transition/backward`, {
          expectedStatus: 'angebot',
        });
        expect(res.statusCode).toBe(200);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (9) ProjectDatesService.updateDates — planned start / end edit.
  // -------------------------------------------------------------------
  describe('AC-276: ProjectDatesService.updateDates emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after a successful date edit', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);

      const conn = subscribeFake(bus);
      try {
        const res = await authPatch(ownerToken, `/api/projects/${projectId}/dates`, {
          plannedStart: '2026-06-01',
          plannedEnd: '2026-06-30',
        });
        expect(res.statusCode).toBe(200);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (10) CustomerService.deleteCustomer — cascade with at least one
  // archived project. Emits exactly one `project_changed` per commit
  // even if multiple archived projects are purged atomically: observers
  // refetch the project list once, not per row.
  // -------------------------------------------------------------------
  describe('AC-276: CustomerService.deleteCustomer (cascade with archived projects) emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event when the cascade purges an archived project', async () => {
      const bus = await loadBus();
      const customerId = await createCustomer(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      await archiveProject(ownerToken, projectId);

      const conn = subscribeFake(bus);
      try {
        const res = await authDelete(ownerToken, `/api/customers/${customerId}`);
        expect(res.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
        expect(countStorageUsageChanged(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // (11a) ImportService.import — override path, successful bulk-restore
  // into a non-empty target. architecture.md §11.13: "Exactly one
  // `project_changed` is emitted post-commit per successful import —
  // one coarse signal is sufficient for every consumer to refetch."
  // -------------------------------------------------------------------
  describe('AC-276: ImportService.import (override commit) emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after a successful override', async () => {
      const bus = await loadBus();

      const conn = subscribeFake(bus);
      try {
        const res = await authPost(
          ownerToken,
          '/api/import?override=true',
          buildOverrideEnvelope(),
        );
        expect(res.statusCode).toBe(200);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
        // Issue #230: override wipes users → sessions cascade → the
        // operator's token is invalidated. Re-seed and re-login so the
        // sibling empty-target test below (which calls `authPost`) does
        // not 401. Pre-#230 this wasn't needed because override only
        // touched customers/projects/etc.
        await seed(db, { force: true });
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // (11b) ImportService.import — empty-target path, successful insert
  // into empty tables. The empty-target branch writes new project rows
  // and is observable to any subscriber connected at the time (e.g. an
  // admin re-importing into a wiped staging DB while the office tab is
  // open). AC-276 widens to cover this branch alongside override —
  // both non-dry-run paths emit one signal post-commit.
  // -------------------------------------------------------------------
  describe('AC-276: ImportService.import (empty-target commit) emits exactly one event', () => {
    it('a subscribed connection observes one project_changed event after a successful empty-target import', async () => {
      const bus = await loadBus();

      // Empty the business tables so the empty-target branch runs —
      // the import service refuses without `override` when any row
      // exists. attachments included so the FK cascade has nothing to
      // hold the truncate back.
      await db.execute(
        sql`TRUNCATE TABLE attachments, project_workers, projects, customers RESTART IDENTITY CASCADE`,
      );

      const conn = subscribeFake(bus);
      try {
        const res = await authPost(ownerToken, '/api/import', buildOverrideEnvelope());
        expect(res.statusCode).toBe(200);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // Silence cases.
  // -------------------------------------------------------------------

  // (12) deleteCustomer with zero archived projects — the project rows
  // visible to subscribers do not change, so no event must fire.
  describe('AC-276: CustomerService.deleteCustomer with zero archived projects emits no event', () => {
    it('a subscribed connection observes zero project_changed events', async () => {
      const bus = await loadBus();
      const customerId = await createCustomer(ownerToken);

      const conn = subscribeFake(bus);
      try {
        const res = await authDelete(ownerToken, `/api/customers/${customerId}`);
        expect(res.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // (13) ImportService.import dry-run — read-only, emits nothing.
  describe('AC-276: ImportService.import dry-run emits no event', () => {
    it('a subscribed connection observes zero project_changed events', async () => {
      const bus = await loadBus();

      const conn = subscribeFake(bus);
      try {
        const res = await authPost(ownerToken, '/api/import?dry_run=true', buildOverrideEnvelope());
        expect(res.statusCode).toBe(200);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // (14) Tx-abort — a mutation that aborts inside its transaction
  // emits no event. AC-276 cross-refs AC-270's tx-abort posture; the
  // injection pattern matches AC-270's `attachments-storage-usage-events.test.ts`
  // arm (a Proxy db whose `transaction()` rejects). Pinning one path
  // is sufficient under T-REDU — the post-commit hook is shared
  // across every emitter.
  describe('AC-276: a transaction that aborts emits no project_changed event', () => {
    it('createProject that throws inside its transaction emits no event', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);

      // Wrap the real db with a Proxy that rejects on `.transaction()`.
      // createProject's row insert + audit dispatch run inside
      // db.transaction(...), so this is the canonical "tx aborted"
      // injection point. Mirrors the pattern in AC-270's
      // `attachments-storage-usage-events.test.ts` L734-741.
      const flakyDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'transaction') {
            return () => Promise.reject(new Error('simulated-tx-abort'));
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as Database;

      const service = new ProjectCrudService(flakyDb);

      const conn = subscribeFake(bus);
      try {
        const log: ServiceLogger = {
          info: vi.fn(),
          error: vi.fn(),
          warn: vi.fn(),
        } as unknown as ServiceLogger;

        const suffix = crypto.randomUUID().slice(0, 8);
        await expect(
          service.createProject(
            {
              number: `EVT-ABORT-${suffix}`,
              title: `tx-abort fixture ${suffix}`,
              customerId,
            },
            // Owner user id resolution from the seed.
            await resolveOwnerUserId(db),
            log,
          ),
        ).rejects.toThrow(/simulated-tx-abort/);

        await new Promise<void>((r) => setImmediate(r));

        // Refutes the "emit before the throwing service call runs"
        // regression class: db.transaction() is Proxy-rejected before
        // any service work runs, so an event here proves the emitter
        // fired up-front (regardless of tx state). NOTE: this test
        // alone does NOT distinguish pre-tx from post-rollback emission
        // — both would land an event here. Post-commit ordering proper
        // is implicitly pinned by the storage_usage_changed silence
        // arms (16, 17) where the commit succeeds but no bytes moved.
        expect(countProjectChanged(conn)).toBe(0);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // Co-emission independence — the two cascade sites that may also
  // emit `storage_usage_changed` (architecture.md §11.13: "the two
  // events' emit gates are independent"). Pin both gates: a project
  // mutation always emits `project_changed` regardless of cascade
  // bytes, and emits `storage_usage_changed` only when bytes moved.
  // -------------------------------------------------------------------

  // (15) purgeProject of an archived project carrying a ready
  // attachment — both events fire.
  describe('AC-276: purgeProject co-emits project_changed AND storage_usage_changed when bytes moved', () => {
    it('a subscribed connection observes one of each event', async () => {
      const bus = await loadBus();
      const customerId = await seededCustomerIdAny(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      // Seed a ready attachment, then archive — the archive itself
      // emits one project_changed (covered in arm 4), so subscribe
      // AFTER the archive to isolate the purge's emissions.
      await seedReadyAttachment(ownerToken, projectId);
      await archiveProject(ownerToken, projectId);

      const conn = subscribeFake(bus);
      try {
        const res = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
        expect(res.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
        expect(countStorageUsageChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // (18) deleteCustomer whose archived project carried a ready
  // attachment — both events fire.
  describe('AC-276: deleteCustomer co-emits project_changed AND storage_usage_changed when bytes moved', () => {
    it('a subscribed connection observes one of each event', async () => {
      const bus = await loadBus();
      const customerId = await createCustomer(ownerToken);
      const projectId = await createActiveProject(ownerToken, customerId);
      await seedReadyAttachment(ownerToken, projectId);
      await archiveProject(ownerToken, projectId);

      const conn = subscribeFake(bus);
      try {
        const res = await authDelete(ownerToken, `/api/customers/${customerId}`);
        expect(res.statusCode).toBe(204);

        await new Promise<void>((r) => setImmediate(r));

        expect(countProjectChanged(conn)).toBe(1);
        expect(countStorageUsageChanged(conn)).toBe(1);
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });
});

/**
 * Resolve the seeded owner user id — needed for the in-process
 * service-call arm (tx-abort), which calls createProject directly
 * rather than through the route. The route layer would otherwise
 * supply this from the session.
 */
async function resolveOwnerUserId(db: Database): Promise<string> {
  const row = await db.execute(
    sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
  );
  const r = row.rows[0] as { id: string } | undefined;
  if (!r) throw new Error('seed missing owner user');
  return r.id;
}
