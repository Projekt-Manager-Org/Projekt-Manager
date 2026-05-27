/**
 * API integration tests — attachment export envelope (AC-220, post-#163).
 *
 * Pins the export-envelope extension from data-model.md §5.8 under the
 * takeout-zip restore design:
 *
 *   interface ExportEnvelope {
 *     schema_version: number;
 *     exported_at: string;
 *     customers: Customer[];
 *     projects: Project[];
 *     project_workers: { projectId, userId }[];
 *     attachments: EnvelopeAttachment[];  // status='ready' only
 *   }
 *
 *   interface EnvelopeAttachment {
 *     id, projectId, kind, label, fileName, mimeType, sizeBytes,
 *     createdAt, createdBy
 *   }
 *
 * Invariants under test:
 *   - Export body carries an `attachments` array.
 *   - Every `status='ready'` row appears.
 *   - `status='pending'` rows are excluded.
 *   - Crypto fields (`wrappedDek`, `wrappedThumbDek`, `wrappedDekVersion`),
 *     opaque storage keys (`originalKey`, `thumbKey`), and ciphertext
 *     sizes (`ciphertextSizeBytes`, `ciphertextThumbSizeBytes`) are
 *     NOT carried on envelope entries — they are not consumable on
 *     the importing instance and the wrapped envelopes additionally
 *     remain inside the exporting instance's confidentiality boundary
 *     (ADR-0024).
 *
 * Bytes stay in storage per ADR-0018 and are NOT part of the envelope.
 * Per-attachment restoration runs through the `init` (with `restore`
 * block) + presigned PUT + `complete` pipeline driven by the client
 * orchestrator on the importing instance; the byte-equality round-trip
 * lands at the takeout E2E (AC-259).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { startApp, stopApp, login, authGet } from '../../test/api-helpers.js';
import { exportEnvelope } from '../../test/data-exchange-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

const year = new Date().getFullYear();

async function projectIdByNumber(ownerToken: string, number: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find((r) => r.number === number);
  if (!p) throw new Error(`seed missing ${number}`);
  return p.id;
}

interface AttachmentSeed {
  id?: string;
  projectId: string;
  status: 'pending' | 'ready';
  label?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  kind?: 'photo' | 'binary';
}

async function seedAttachment(spec: AttachmentSeed): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = spec.id ?? crypto.randomUUID();
    const kind = spec.kind ?? (spec.mimeType?.startsWith('image/') ? 'photo' : 'binary');
    const label = spec.label ?? 'sonstiges';
    const fileName = spec.fileName ?? `file-${id.slice(0, 6)}`;
    const mimeType = spec.mimeType ?? 'application/pdf';
    const sizeBytes = spec.sizeBytes ?? 1024;
    const originalKey = `attachments/${spec.projectId}/${id}.orig`;
    const thumbKey = kind === 'photo' ? `attachments/${spec.projectId}/${id}.thumb` : null;
    // Synthetic wrapped envelopes — the seeded rows do not need to be
    // unwrappable; AC-220 only pins that the column rides the export
    // envelope byte-for-byte. Real envelope shape is the `age` X25519
    // KEM output wrapped in base64 — the seed uses base64 of opaque
    // bytes (length differs per blob to detect a regression that
    // copied one column over another). Ciphertext sizes mirror the
    // plaintext sizes for the seeded fixture; the row's
    // `ciphertext_size_bytes` column is what the export envelope
    // surfaces. (Numerical relationship between plaintext and
    // ciphertext is implementation-defined per api.md §14.2.11.)
    const wrappedDek = Buffer.from(`wrapped-orig-${id}`).toString('base64');
    const wrappedThumbDek =
      kind === 'photo' ? Buffer.from(`wrapped-thumb-${id}`).toString('base64') : null;
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes, ciphertext_thumb_size_bytes,
         original_key, thumb_key, has_thumbnail,
         wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
      VALUES (${id}, ${spec.projectId}, ${spec.status}, ${kind}, ${label},
              ${fileName}, ${mimeType}, ${sizeBytes},
              ${sizeBytes}, ${kind === 'photo' ? Math.max(1, Math.floor(sizeBytes / 10)) : null},
              ${originalKey}, ${thumbKey}, ${kind === 'photo'},
              ${wrappedDek}, ${wrappedThumbDek}, 1)
    `);
    return id;
  } finally {
    await pool.end();
  }
}

/**
 * Wire shape for entries on the export envelope (post-#163,
 * data-model.md §5.8 / AC-220). The metadata-only descriptor: crypto
 * fields, opaque storage keys, and ciphertext sizes are off the wire.
 */
interface AttachmentInEnvelope {
  id: string;
  projectId: string;
  status: 'ready';
  label: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'photo' | 'binary';
  createdAt: string;
  createdBy: string | null;
}

describe('Attachment export envelope (AC-220)', () => {
  let ownerToken: string;
  let projectId: string;
  let readyIds: string[];
  let pendingIds: string[];

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    projectId = await projectIdByNumber(ownerToken, `${year}-007`);

    // Seed three ready rows and two pending rows. The export must
    // carry the ready rows and omit the pending ones.
    readyIds = await Promise.all([
      seedAttachment({
        projectId,
        status: 'ready',
        label: 'angebot',
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 111,
      }),
      seedAttachment({
        projectId,
        status: 'ready',
        label: 'rechnung',
        fileName: 'b.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 222,
      }),
      seedAttachment({
        projectId,
        status: 'ready',
        label: 'foto',
        fileName: 'c.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 333,
      }),
    ]);
    pendingIds = await Promise.all([
      seedAttachment({
        projectId,
        status: 'pending',
        label: 'aufmass',
        fileName: 'p1.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 400,
      }),
      seedAttachment({
        projectId,
        status: 'pending',
        label: 'sonstiges',
        fileName: 'p2.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 500,
      }),
    ]);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // AC-220 Part 1 — Envelope shape + ready/pending filtering
  // -------------------------------------------------------------------
  it('includes every ready row with the documented metadata fields', async () => {
    const env = (await exportEnvelope()) as unknown as { attachments: AttachmentInEnvelope[] };
    const exportedIds = env.attachments.map((a) => a.id);
    for (const id of readyIds) {
      expect(exportedIds).toContain(id);
    }

    // Pin the row-level fidelity — each exported row carries the
    // documented metadata-only fields (data-model.md §5.8).
    const first = env.attachments.find((a) => a.id === readyIds[0]);
    expect(first).toBeDefined();
    expect(first!.projectId).toBe(projectId);
    expect(first!.status).toBe('ready');
    expect(first!.label).toBe('angebot');
    expect(first!.mimeType).toBe('application/pdf');
    expect(first!.sizeBytes).toBe(111);
    expect(typeof first!.fileName).toBe('string');
    expect(typeof first!.createdAt).toBe('string');
  });

  // -------------------------------------------------------------------
  // AC-220 (post-#163) — crypto fields, opaque storage keys, and
  // ciphertext sizes MUST NOT appear on envelope entries. They are not
  // consumable on the importing instance and the wrapped envelopes
  // additionally remain inside the exporting instance's confidentiality
  // boundary. The takeout-zip restore re-uploads attachments via the
  // standard `init` + presigned PUT + `complete` pipeline (AC-256), so
  // these fields would be dead weight on the wire and a confidentiality
  // leak.
  // -------------------------------------------------------------------
  it('drops crypto fields, storage keys, and ciphertext sizes from envelope entries', async () => {
    const env = (await exportEnvelope()) as unknown as { attachments: Record<string, unknown>[] };
    expect(env.attachments.length).toBeGreaterThan(0);

    for (const row of env.attachments) {
      // Crypto fields — never on the envelope.
      expect(row.wrappedDek).toBeUndefined();
      expect(row.wrappedThumbDek).toBeUndefined();
      expect(row.wrappedDekVersion).toBeUndefined();
      // Opaque storage keys — local to the exporting instance, dropped.
      expect(row.originalKey).toBeUndefined();
      expect(row.thumbKey).toBeUndefined();
      expect(row.hasThumbnail).toBeUndefined();
      // Ciphertext sizes — internal to the storage path, dropped.
      expect(row.ciphertextSizeBytes).toBeUndefined();
      expect(row.ciphertextThumbSizeBytes).toBeUndefined();
    }
  });

  it('serialized response carries no crypto field names anywhere', async () => {
    // Defense-in-depth grep over the serialized JSON. A regression that
    // re-introduced any of the dropped fields under a nested or aliased
    // shape (e.g. on the project rows by mistake) would surface here.
    const serialized = JSON.stringify(await exportEnvelope());
    expect(serialized).not.toMatch(/"wrappedDek"\s*:/);
    expect(serialized).not.toMatch(/"wrappedThumbDek"\s*:/);
    expect(serialized).not.toMatch(/"wrappedDekVersion"\s*:/);
    expect(serialized).not.toMatch(/"originalKey"\s*:/);
    expect(serialized).not.toMatch(/"thumbKey"\s*:/);
    expect(serialized).not.toMatch(/"ciphertextSizeBytes"\s*:/);
    expect(serialized).not.toMatch(/"ciphertextThumbSizeBytes"\s*:/);
  });

  it('excludes every pending row', async () => {
    const env = (await exportEnvelope()) as unknown as { attachments: AttachmentInEnvelope[] };
    const exportedIds = new Set(env.attachments.map((a) => a.id));
    for (const id of pendingIds) {
      expect(exportedIds.has(id)).toBe(false);
    }
    for (const row of env.attachments) {
      expect(row.status).toBe('ready');
    }
  });

  // The import-side cross-checks that used to live here (re-posting an
  // export snapshot verbatim → 422 on the `attachments` key, and the
  // strip-then-override roundtrip) tested the removed text-leg
  // `POST /api/import` route schema. The attachments-key rejection was a
  // route-schema guard with no service-layer equivalent (ImportService
  // ignores the key — it never inserts attachment rows), and the override
  // truncate (AC-254) is owned by `data-exchange.test.ts`. Both went with
  // the route; this file is now purely the AC-220 export envelope.
});
