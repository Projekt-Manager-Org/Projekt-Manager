/**
 * Unit tests — browser-side import-all orchestrator (issue #163).
 *
 * Pins the orchestration contract for the helper that lives one level
 * up from this file:
 *
 *   src/ui/management/importAllFromZip.ts → importAllFromZip
 *
 * Helper shape (mirror of `exportAllAsZip.ts` from #162):
 *
 *   import { importAllFromZip } from '../importAllFromZip';
 *
 *   const result = await importAllFromZip({
 *     zip,                       // Uint8Array — the takeout zip bytes
 *     postTextLeg,               // (envelopeWithoutAttachments) => Promise<{ ok: boolean }>
 *     initAttachment,            // (entry, restoreBlock) => Promise<{ id: string, originalUpload: ... }>
 *     putCiphertext,             // (url, headers, ciphertext) => Promise<void>
 *     completeAttachment,        // (id) => Promise<{ id: string, status: 'ready' }>
 *     deleteAttachment,          // (id) => Promise<void>
 *     pinnedSchemaVersion,       // number — what the importing instance pins
 *   });
 *
 * The orchestrator is THE hook the AC-260 / AC-261 / AC-262 invariants
 * land on. The browser dialog (`VollstaendigerImportDialog.tsx`) is a
 * thin shell around this helper; the dialog's UX assertions live in
 * the e2e spec (`e2e/daten-vollstaendiger-import.spec.ts`).
 *
 * AC coverage in this file:
 *   AC-260  step-1 structural manifest + zip-coverage parity check.
 *           Missing-entry, extra-entry, and malformed-shape variants
 *           all abort BEFORE any text-leg request is dispatched.
 *           Per-file SHA-256 verification is deferred to step 5.
 *   AC-261  step-5 canonical per-file SHA-256 mismatch is fatal. The
 *           orchestrator detects the mismatch on read just before
 *           encrypt / dispatch `init`, walks the committed-id list,
 *           and DELETEs each. Text-leg-committed rows remain.
 *   AC-262  envelope `data.json.schema_version` ≠ pinned value aborts
 *           in step 1 BEFORE the text-leg dispatches.
 *
 * Until the helper exists the import statement throws at module-load
 * time and Vitest surfaces the failure as the test-run output. That is
 * the expected red-phase shape; do NOT stub the module.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeZip } from 'client-zip';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — module does not exist yet; the failing import IS the red-
// phase signal per the brief. Once `importAllFromZip.ts` lands, this
// directive can be removed.
import { importAllFromZip } from '../importAllFromZip';

const PINNED_SCHEMA_VERSION = 1;

interface ManifestEntry {
  zipPath: string;
  sizeBytes: number;
  sha256: string;
  attachmentId?: string;
}

interface Manifest {
  manifestVersion: 1;
  exportedAt: string;
  totalFiles: number;
  totalBytes: number;
  files: ManifestEntry[];
}

interface EnvelopeAttachment {
  id: string;
  projectId: string;
  kind: 'photo' | 'binary';
  label: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  createdBy: string | null;
}

interface Envelope {
  schema_version: number;
  exported_at: string;
  users: unknown[];
  company_profile: unknown[];
  customers: unknown[];
  projects: unknown[];
  project_workers: unknown[];
  invoices: unknown[];
  invoice_sequence: unknown[];
  attachments?: EnvelopeAttachment[];
}

/**
 * Hex-lowercase SHA-256 — same shape the manifest stores. Recomputed
 * here because the orchestrator hashes plaintext for the per-entry
 * verification, and the test mints fixtures with the matching hash
 * (or with a deliberately mismatched hash for AC-261).
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Drain a ReadableStream into a single Uint8Array. */
async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Build a single-attachment envelope. Trivial content — the AC pins
 * the orchestrator's flow-control around the envelope, not envelope
 * shape (data-exchange.test.ts owns envelope-shape coverage).
 */
function buildEnvelope(attachments: EnvelopeAttachment[] = []): Envelope {
  return {
    schema_version: PINNED_SCHEMA_VERSION,
    exported_at: '2026-05-04T08:00:00.000Z',
    users: [],
    company_profile: [],
    customers: [],
    projects: [],
    project_workers: [],
    invoices: [],
    invoice_sequence: [],
    attachments,
  };
}

interface BuildZipInput {
  envelope: Envelope;
  /** Per-attachment plaintext bytes paired with the envelope row. */
  files: Array<{
    entry: EnvelopeAttachment;
    plaintext: Uint8Array;
  }>;
  /** Override the manifest's contents — used by AC-260 negative arms. */
  manifestOverride?: Partial<Manifest> | ((m: Manifest) => Manifest);
  /**
   * Optional: omit the listed `zipPath`s from the zip body (but keep
   * them in the manifest) — drives the missing-entry AC-260 arm.
   */
  omitFromZip?: string[];
  /**
   * Optional: extra `{ zipPath, bytes }` entries to inject into the
   * zip body without listing them in the manifest — drives the
   * extra-entry AC-260 arm.
   */
  extraZipEntries?: Array<{ zipPath: string; bytes: Uint8Array }>;
}

/**
 * Assemble a takeout-zip fixture in the same shape `exportAllAsZip.ts`
 * produces: `data.json` first, then per-attachment plaintext entries,
 * then `manifest.json` last. `client-zip`'s `makeZip` is the same lib
 * the production assembler uses — using it here keeps the test fixture
 * byte-shape congruent with what real exports look like.
 */
async function buildZip(input: BuildZipInput): Promise<Uint8Array> {
  const dataJsonBytes = new TextEncoder().encode(JSON.stringify(input.envelope));
  const manifestFiles: ManifestEntry[] = [
    {
      zipPath: 'data.json',
      sizeBytes: dataJsonBytes.byteLength,
      sha256: await sha256Hex(dataJsonBytes),
    },
  ];
  const attachmentEntries: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const f of input.files) {
    const zipPath = `attachments/p/${f.entry.id}-${f.entry.fileName}`;
    manifestFiles.push({
      zipPath,
      sizeBytes: f.plaintext.byteLength,
      sha256: await sha256Hex(f.plaintext),
      attachmentId: f.entry.id,
    });
    attachmentEntries.push({ name: zipPath, bytes: f.plaintext });
  }

  let manifest: Manifest = {
    manifestVersion: 1,
    exportedAt: input.envelope.exported_at,
    totalFiles: manifestFiles.length,
    totalBytes: manifestFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
    files: manifestFiles,
  };
  if (typeof input.manifestOverride === 'function') {
    manifest = input.manifestOverride(manifest);
  } else if (input.manifestOverride) {
    manifest = { ...manifest, ...input.manifestOverride };
  }

  const omit = new Set(input.omitFromZip ?? []);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  function bytesAsStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async function* zipInputs() {
    if (!omit.has('data.json')) {
      yield { name: 'data.json', input: bytesAsStream(dataJsonBytes) };
    }
    for (const e of attachmentEntries) {
      if (omit.has(e.name)) continue;
      yield { name: e.name, input: bytesAsStream(e.bytes) };
    }
    for (const extra of input.extraZipEntries ?? []) {
      yield { name: extra.zipPath, input: bytesAsStream(extra.bytes) };
    }
    yield { name: 'manifest.json', input: bytesAsStream(manifestBytes) };
  }

  return readStreamToBytes(makeZip(zipInputs()));
}

interface OrchestratorMocks {
  postTextLeg: ReturnType<typeof vi.fn>;
  initAttachment: ReturnType<typeof vi.fn>;
  putCiphertext: ReturnType<typeof vi.fn>;
  completeAttachment: ReturnType<typeof vi.fn>;
  deleteAttachment: ReturnType<typeof vi.fn>;
}

/**
 * Build a fresh set of dependency mocks. Every call is `vi.fn()` so
 * each test asserts on call counts / call arguments without sharing
 * state across tests.
 *
 * Defaults:
 *   - `postTextLeg` resolves to { ok: true }
 *   - `initAttachment` returns { id: <entry.id>, originalUpload: { url, headers } }
 *   - `putCiphertext` resolves
 *   - `completeAttachment` resolves to { id, status: 'ready' }
 *   - `deleteAttachment` resolves
 */
function makeMocks(): OrchestratorMocks {
  return {
    postTextLeg: vi.fn(async () => ({ ok: true })),
    initAttachment: vi.fn(async (entry: EnvelopeAttachment) => ({
      id: entry.id,
      originalUpload: {
        url: `https://storage.test/${entry.id}.ct`,
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    })),
    putCiphertext: vi.fn(async () => undefined),
    completeAttachment: vi.fn(async (id: string) => ({ id, status: 'ready' })),
    deleteAttachment: vi.fn(async () => undefined),
  };
}

/**
 * One canonical attachment entry the AC-260 / AC-261 fixtures reuse.
 */
function entryOf(id: string, fileName: string): EnvelopeAttachment {
  return {
    id,
    projectId: 'p1',
    kind: 'binary',
    label: 'sonstiges',
    fileName,
    mimeType: 'application/pdf',
    sizeBytes: 8,
    createdAt: '2026-05-01T00:00:00.000Z',
    createdBy: null,
  };
}

// ===================================================================
// AC-260 — step-1 structural manifest + zip-coverage parity check.
// ===================================================================
describe('AC-260: step-1 structural manifest + zip-coverage parity', () => {
  it('aborts before dispatching the text-leg when a manifest entry has no matching zip entry (missing-entry variant)', async () => {
    // Two attachments listed in the manifest; the second's zip entry is
    // omitted from the body. The structural parity check in step 1
    // catches this before any text-leg request fires.
    const a = entryOf('aaaaaaaa-0000-4000-8000-00000000aaaa', 'a.pdf');
    const b = entryOf('bbbbbbbb-0000-4000-8000-00000000bbbb', 'b.pdf');
    const envelope = buildEnvelope([a, b]);
    const plaintextA = new TextEncoder().encode('AAA-bytes');
    const plaintextB = new TextEncoder().encode('BBB-bytes');

    const zip = await buildZip({
      envelope,
      files: [
        { entry: a, plaintext: plaintextA },
        { entry: b, plaintext: plaintextB },
      ],
      // Manifest still claims `b`'s zipPath; the zip body omits it.
      omitFromZip: [`attachments/p/${b.id}-${b.fileName}`],
    });

    const mocks = makeMocks();
    await expect(
      importAllFromZip({
        zip,
        ...mocks,
        pinnedSchemaVersion: PINNED_SCHEMA_VERSION,
      }),
    ).rejects.toThrow();

    // The whole point of step 1: no text-leg, no init, no upload.
    expect(mocks.postTextLeg).not.toHaveBeenCalled();
    expect(mocks.initAttachment).not.toHaveBeenCalled();
    expect(mocks.putCiphertext).not.toHaveBeenCalled();
    expect(mocks.completeAttachment).not.toHaveBeenCalled();
  });

  it('aborts before dispatching the text-leg when the zip carries an extra entry not listed in the manifest (extra-entry variant)', async () => {
    // One attachment listed in the manifest; an additional zip entry
    // appears under attachments/ but has no manifest line. Step 1
    // rejects before the text-leg fires.
    const a = entryOf('aaaaaaaa-0000-4000-8000-00000000aaaa', 'a.pdf');
    const envelope = buildEnvelope([a]);
    const plaintextA = new TextEncoder().encode('AAA-bytes');

    const zip = await buildZip({
      envelope,
      files: [{ entry: a, plaintext: plaintextA }],
      extraZipEntries: [
        {
          zipPath: 'attachments/p/extra-not-in-manifest.bin',
          bytes: new TextEncoder().encode('extra'),
        },
      ],
    });

    const mocks = makeMocks();
    await expect(
      importAllFromZip({
        zip,
        ...mocks,
        pinnedSchemaVersion: PINNED_SCHEMA_VERSION,
      }),
    ).rejects.toThrow();

    expect(mocks.postTextLeg).not.toHaveBeenCalled();
    expect(mocks.initAttachment).not.toHaveBeenCalled();
  });

  it('aborts before dispatching the text-leg when manifest top-level shape is malformed (missing manifestVersion)', async () => {
    // The orchestrator validates the top-level shape per AC-252 before
    // moving on. Stripping `manifestVersion` is a minimal way to break
    // the shape contract.
    const a = entryOf('aaaaaaaa-0000-4000-8000-00000000aaaa', 'a.pdf');
    const envelope = buildEnvelope([a]);
    const plaintextA = new TextEncoder().encode('AAA-bytes');

    const zip = await buildZip({
      envelope,
      files: [{ entry: a, plaintext: plaintextA }],
      manifestOverride: (m) => {
        const copy = { ...m } as Partial<Manifest> & Record<string, unknown>;
        delete copy.manifestVersion;
        return copy as Manifest;
      },
    });

    const mocks = makeMocks();
    await expect(
      importAllFromZip({
        zip,
        ...mocks,
        pinnedSchemaVersion: PINNED_SCHEMA_VERSION,
      }),
    ).rejects.toThrow();

    expect(mocks.postTextLeg).not.toHaveBeenCalled();
    expect(mocks.initAttachment).not.toHaveBeenCalled();
  });
});

// ===================================================================
// AC-261 — step-5 per-file SHA-256 mismatch is fatal. The third
// entry's `init` is never dispatched (its hash check fires before
// init); every id whose `complete` resolved before the abort gets
// rolled back via DELETE. Text-leg-committed rows remain.
//
// Assertions are concurrency-agnostic — issue #163 pins bounded
// concurrency (~4) on the per-attachment leg, so under real
// implementation entries 1 / 2 / 3 may all be inflight when entry 3's
// hash check fires. The contract is a SET relation (rollback ⊇
// committed), not a sequence of call counts.
// ===================================================================
describe('AC-261: per-file SHA-256 mismatch in step 5 — rollback walk', () => {
  it('aborts the run, never inits the corrupt entry, and DELETE-walks every committed id', async () => {
    const a = entryOf('aaaaaaaa-0000-4000-8000-00000000aaaa', 'a.pdf');
    const b = entryOf('bbbbbbbb-0000-4000-8000-00000000bbbb', 'b.pdf');
    const c = entryOf('cccccccc-0000-4000-8000-00000000cccc', 'c.pdf');
    const envelope = buildEnvelope([a, b, c]);

    const plaintextA = new TextEncoder().encode('AAA-bytes');
    const plaintextB = new TextEncoder().encode('BBB-bytes');
    const plaintextC = new TextEncoder().encode('CCC-real-bytes');

    // Manifest's `c` line will claim the SHA-256 of a DIFFERENT byte
    // string than what the zip carries — the canonical AC-261 fixture.
    // The orchestrator hashes the bytes-on-read in step 5; the
    // mismatch is fatal at that point, BEFORE encrypt / dispatch init.
    const corruptHash = await sha256Hex(new TextEncoder().encode('NOT-the-real-c-bytes'));
    const zip = await buildZip({
      envelope,
      files: [
        { entry: a, plaintext: plaintextA },
        { entry: b, plaintext: plaintextB },
        { entry: c, plaintext: plaintextC },
      ],
      manifestOverride: (m) => {
        const files = m.files.map((f) => {
          if (f.attachmentId === c.id) return { ...f, sha256: corruptHash };
          return f;
        });
        return { ...m, files };
      },
    });

    const mocks = makeMocks();

    await expect(
      importAllFromZip({
        zip,
        ...mocks,
        pinnedSchemaVersion: PINNED_SCHEMA_VERSION,
      }),
    ).rejects.toThrow();

    // Text-leg ran (manifest's structural check passed in step 1; the
    // per-entry hash check is step 5 only).
    expect(mocks.postTextLeg).toHaveBeenCalledTimes(1);

    // The corrupt entry's hash check fires BEFORE init / encrypt /
    // put / complete dispatch — so its id never reaches `init`,
    // regardless of concurrency.
    const initCalledIds = new Set(
      mocks.initAttachment.mock.calls.map((call) => (call[0] as EnvelopeAttachment).id),
    );
    expect(initCalledIds.has(c.id)).toBe(false);

    // Rollback contract: every id whose `complete` resolved (the
    // committed set) appears in the DELETE walk. No claim about
    // ordering or count — under bounded concurrency the committed
    // set may be {} ∪ {a.id} ∪ {b.id} ∪ {a.id, b.id}; the only
    // invariant is rollback ⊇ committed and rollback contains no
    // ids that never committed (in particular, never c.id).
    const committedIds = new Set(
      mocks.completeAttachment.mock.results
        .filter((r) => r.type === 'return')
        .map((_, i) => mocks.completeAttachment.mock.calls[i]![0] as string),
    );
    const rolledBackIds = new Set(
      mocks.deleteAttachment.mock.calls.map((call) => call[0] as string),
    );
    for (const id of committedIds) {
      expect(rolledBackIds.has(id)).toBe(true);
    }
    // c.id never committed and so must not appear in the rollback
    // walk; any other id outside {a.id, b.id} would be foreign and
    // also wrong.
    for (const id of rolledBackIds) {
      expect([a.id, b.id]).toContain(id);
    }
  });
});

// ===================================================================
// AC-262 — client-side schema_version mismatch aborts in step 1.
// Defense-in-depth server-side check is covered in
// src/server/__tests__/data-exchange.test.ts.
// ===================================================================
describe('AC-262: schema_version mismatch — client-side rejection in step 1', () => {
  it('aborts before dispatching the text-leg when envelope schema_version ≠ pinned value', async () => {
    const a = entryOf('aaaaaaaa-0000-4000-8000-00000000aaaa', 'a.pdf');
    const envelope: Envelope = {
      ...buildEnvelope([a]),
      // Drift the schema version on the envelope. The pinned value
      // injected into the orchestrator is PINNED_SCHEMA_VERSION;
      // anything else must reject before any wire fires.
      schema_version: PINNED_SCHEMA_VERSION + 1,
    };
    const plaintextA = new TextEncoder().encode('AAA-bytes');
    const zip = await buildZip({
      envelope,
      files: [{ entry: a, plaintext: plaintextA }],
    });

    const mocks = makeMocks();
    await expect(
      importAllFromZip({
        zip,
        ...mocks,
        pinnedSchemaVersion: PINNED_SCHEMA_VERSION,
      }),
    ).rejects.toThrow();

    expect(mocks.postTextLeg).not.toHaveBeenCalled();
    expect(mocks.initAttachment).not.toHaveBeenCalled();
    expect(mocks.putCiphertext).not.toHaveBeenCalled();
    expect(mocks.completeAttachment).not.toHaveBeenCalled();
  });
});
