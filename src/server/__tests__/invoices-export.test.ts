/**
 * API integration tests — invoice bulk-export ZIP.
 *
 * Pins the wire contract for `POST /api/invoices/export`:
 *   - Body shape: exactly one of `ids` or `filter`.
 *   - Response: `application/zip` carrying one PDF per non-draft
 *     invoice plus a `manifest.csv` with German bookkeeping
 *     conventions (UTF-8 BOM, semicolon separator, comma decimal,
 *     CRLF line endings).
 *   - Permission: `invoice:read` (owner / office / bookkeeper).
 *     Workers reject at 403; the repository scope returns the empty
 *     set on the inner list path too, but the route gate fires first.
 *   - Draft rejection: ids-mode draft → 422 DRAFT_NOT_EXPORTABLE
 *     before any bytes leave the wire; filter-mode silently omits.
 *   - Unknown id → 404 NOT_FOUND.
 *
 * Bootstrap mirrors `invoices-routes.test.ts`: real Postgres + seeded
 * invoices spanning 2024/2025/2026. The seed delivers ~6 issued rows
 * (one of which is cancelled, plus its Storno sibling) so the
 * filter-by-year and search-narrowing arms have something to grip.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { sql } from 'drizzle-orm';
import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { InvoiceService } from '../services/InvoiceService.js';
import { EXPORT_FILTER_SAFETY_CAP } from '../services/InvoiceExportService.js';

interface InvoiceWire {
  id: string;
  number: string | null;
  status: 'draft' | 'issued' | 'cancelled';
  issueDate: string | null;
  cancellationOf: string | null;
  recipient: { name: string };
  projectId: string;
  totals: { netGrandTotal: number; taxGrandTotal: number; grossGrandTotal: number };
}

/**
 * `app.inject()` returns a Buffer in `rawPayload` even when the
 * declared content type is binary. Parse the ZIP with fflate and
 * return the canonical (entry name → buffer) map plus the manifest
 * decoded as UTF-8.
 */
function parseZipResponse(body: Buffer): { entries: Map<string, Buffer>; manifest: string } {
  const decoded = unzipSync(new Uint8Array(body));
  const entries = new Map<string, Buffer>();
  for (const [name, bytes] of Object.entries(decoded)) {
    entries.set(name, Buffer.from(bytes));
  }
  const manifestBuf = entries.get('manifest.csv');
  if (!manifestBuf) throw new Error('manifest.csv missing from archive');
  return { entries, manifest: manifestBuf.toString('utf-8') };
}

/** Direct-DB count of non-draft invoice rows — the export's target. */
async function countNonDraftInvoices(): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute<{ c: string }>(
      sql`SELECT COUNT(*)::text AS c FROM invoices WHERE status <> 'draft'`,
    );
    return Number(res.rows[0]!.c);
  } finally {
    await pool.end();
  }
}

/** Fetch all non-draft invoices visible to the owner — the export reference set. */
async function listNonDraftInvoices(token: string): Promise<InvoiceWire[]> {
  const res = await authGet(token, '/api/invoices?limit=500');
  expect(res.statusCode).toBe(200);
  const body = res.json() as { data: InvoiceWire[] };
  return body.data.filter((i) => i.status !== 'draft');
}

/** Fetch all draft invoices — needed for the draft-rejection arm. */
async function listDraftInvoices(token: string): Promise<InvoiceWire[]> {
  const res = await authGet(token, '/api/invoices?status=draft&limit=500');
  expect(res.statusCode).toBe(200);
  const body = res.json() as { data: InvoiceWire[] };
  return body.data;
}

describe('POST /api/invoices/export', () => {
  let ownerToken: string;
  let workerToken: string;
  let bookkeeperToken: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // Happy path — filter mode (no filter) returns every non-draft row.
  // -------------------------------------------------------------------
  it('filter mode without arguments returns every non-draft invoice + a well-formed manifest', async () => {
    const expectedCount = await countNonDraftInvoices();
    expect(expectedCount).toBeGreaterThan(0);

    const res = await authPost(ownerToken, '/api/invoices/export', { filter: {} });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/zip');
    const disposition = String(res.headers['content-disposition']);
    expect(disposition).toContain('attachment');
    expect(disposition).toMatch(/Rechnungen_alle_\d{4}-\d{2}-\d{2}\.zip/);

    const body = res.rawPayload as Buffer;
    const { entries, manifest } = parseZipResponse(body);

    // One PDF per non-draft invoice + the manifest entry.
    expect(entries.size).toBe(expectedCount + 1);

    // PDFs start with the %PDF- magic bytes.
    for (const [name, buf] of entries) {
      if (name === 'manifest.csv') continue;
      expect(name.endsWith('.pdf'), `entry ${name} should be a PDF`).toBe(true);
      expect(buf.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    }

    // BOM + header.
    expect(manifest.charCodeAt(0)).toBe(0xfeff);
    const stripped = manifest.replace(/^\uFEFF/, '');
    const lines = stripped.split('\r\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('Nr.;Datum;Empfänger;Netto;USt;Brutto;Status');
    // One header row + one data row per invoice.
    expect(lines.length).toBe(expectedCount + 1);

    // Spot-check the first data row.
    const firstData = lines[1]!;
    const fields = firstData.split(';');
    expect(fields.length).toBe(7);
    // German date `DD.MM.YYYY`.
    expect(fields[1]).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    // German decimals — comma separator, two fractional digits.
    expect(fields[3]).toMatch(/^-?\d+(?:\.\d{3})*,\d{2}$|^-?\d+,\d{2}$/);
    expect(fields[5]).toMatch(/^-?\d+(?:\.\d{3})*,\d{2}$|^-?\d+,\d{2}$/);
    expect(['Ausgestellt', 'Storniert', 'Storno']).toContain(fields[6]);
  });

  // -------------------------------------------------------------------
  // Happy path — ids mode returns only the requested rows.
  // -------------------------------------------------------------------
  it('ids mode returns only the requested PDFs + manifest rows', async () => {
    const all = await listNonDraftInvoices(ownerToken);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const picked = all.slice(0, 2);
    const ids = picked.map((i) => i.id);

    const res = await authPost(ownerToken, '/api/invoices/export', { ids });
    expect(res.statusCode).toBe(200);
    const disposition = String(res.headers['content-disposition']);
    expect(disposition).toMatch(/Rechnungen_auswahl_\d{4}-\d{2}-\d{2}\.zip/);

    const body = res.rawPayload as Buffer;
    const { entries, manifest } = parseZipResponse(body);

    // Two PDFs + manifest.
    expect(entries.size).toBe(3);
    for (const inv of picked) {
      expect(entries.has(`${inv.number!}.pdf`)).toBe(true);
    }

    const stripped = manifest.replace(/^\uFEFF/, '');
    const lines = stripped.split('\r\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(3); // header + 2 data rows
    const numbersInManifest = lines.slice(1).map((l) => l.split(';')[0]);
    for (const inv of picked) {
      expect(numbersInManifest).toContain(inv.number);
    }
  });

  // -------------------------------------------------------------------
  // Bad request — both `ids` and `filter` present.
  // -------------------------------------------------------------------
  it('rejects 422 when both ids and filter are provided', async () => {
    const all = await listNonDraftInvoices(ownerToken);
    const res = await authPost(ownerToken, '/api/invoices/export', {
      ids: [all[0]!.id],
      filter: { year: 2024 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------
  // Bad request — neither `ids` nor `filter`.
  // -------------------------------------------------------------------
  it('rejects 422 when neither ids nor filter is provided', async () => {
    const res = await authPost(ownerToken, '/api/invoices/export', {});
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------
  // Draft in ids → 422 DRAFT_NOT_EXPORTABLE.
  // -------------------------------------------------------------------
  it('rejects 422 DRAFT_NOT_EXPORTABLE when ids includes a draft invoice', async () => {
    const drafts = await listDraftInvoices(ownerToken);
    expect(drafts.length).toBeGreaterThan(0);
    const draftId = drafts[0]!.id;

    const all = await listNonDraftInvoices(ownerToken);
    const issuedId = all[0]!.id;

    const res = await authPost(ownerToken, '/api/invoices/export', {
      // Include a non-draft id too so a regression that short-circuits
      // before resolution would still fail (the draft is at index 1).
      ids: [issuedId, draftId],
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.code).toBe('DRAFT_NOT_EXPORTABLE');
    expect(body.details).toBeDefined();
    expect(body.details.invoiceId).toBe(draftId);
  });

  // -------------------------------------------------------------------
  // Unknown id → 404 NOT_FOUND.
  // -------------------------------------------------------------------
  it('rejects 404 when ids includes an unknown invoice id', async () => {
    const res = await authPost(ownerToken, '/api/invoices/export', {
      ids: ['00000000-0000-0000-0000-000000000000'],
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  // -------------------------------------------------------------------
  // Worker → 403 NOT_PERMITTED (lacks invoice:read).
  // -------------------------------------------------------------------
  it('AC-576: rejects 403 when called as a worker', async () => {
    const res = await authPost(workerToken, '/api/invoices/export', { filter: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });

  // -------------------------------------------------------------------
  // Bookkeeper can export.
  // -------------------------------------------------------------------
  it('allows bookkeeper to export (holds invoice:read)', async () => {
    const res = await authPost(bookkeeperToken, '/api/invoices/export', { filter: {} });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/zip');
    const body = res.rawPayload as Buffer;
    const { entries } = parseZipResponse(body);
    expect(entries.has('manifest.csv')).toBe(true);
  });

  // -------------------------------------------------------------------
  // Filter narrowing — year filter trims the result set.
  // -------------------------------------------------------------------
  it('year filter narrows the export to invoices issued in that year', async () => {
    const all = await listNonDraftInvoices(ownerToken);
    // The seed spans 2024..2026; pick a year that has issued invoices
    // AND fewer rows than the total. 2024 carries the cancellation
    // pair (RE-0001 storno + RE-0001 re-issue) plus RE-0004 — at
    // least three rows but strictly fewer than the full set.
    const yearCount = all.filter((i) => i.issueDate?.startsWith('2024-')).length;
    expect(yearCount).toBeGreaterThan(0);
    expect(yearCount).toBeLessThan(all.length);

    const res = await authPost(ownerToken, '/api/invoices/export', {
      filter: { year: 2024 },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toMatch(
      /Rechnungen_2024_\d{4}-\d{2}-\d{2}\.zip/,
    );
    const { entries } = parseZipResponse(res.rawPayload as Buffer);
    // yearCount PDFs + manifest.
    expect(entries.size).toBe(yearCount + 1);
  });

  // -------------------------------------------------------------------
  // Filter narrowing — search filter trims the result set.
  // -------------------------------------------------------------------
  // -------------------------------------------------------------------
  // Cap enforcement — a filter that matches more than
  // EXPORT_FILTER_SAFETY_CAP rows must 422, NOT silently truncate.
  // Seeding 5000+ invoices is impractical; we spy on the service's
  // `list()` to report an inflated `total` on the first probe page.
  // -------------------------------------------------------------------
  it('rejects 422 EXPORT_TOO_LARGE when the filter matches more than the cap', async () => {
    const spy = vi
      .spyOn(InvoiceService.prototype, 'list')
      .mockResolvedValueOnce({ data: [], total: EXPORT_FILTER_SAFETY_CAP + 1 });
    try {
      const res = await authPost(ownerToken, '/api/invoices/export', { filter: {} });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.code).toBe('EXPORT_TOO_LARGE');
      expect(body.details).toBeDefined();
      expect(body.details.total).toBe(EXPORT_FILTER_SAFETY_CAP + 1);
      expect(body.details.cap).toBe(EXPORT_FILTER_SAFETY_CAP);
    } finally {
      spy.mockRestore();
    }
  });

  it('search filter narrows the export to invoices matching the term', async () => {
    const all = await listNonDraftInvoices(ownerToken);
    // The seed places one invoice on "Kanzlei Dr. Meier" (project 019);
    // grep through the list to find a recipient name appearing on
    // exactly one row so the assertion is unambiguous.
    const term = pickUniqueRecipientSubstring(all);
    expect(term).toBeDefined();

    const res = await authPost(ownerToken, '/api/invoices/export', {
      filter: { search: term! },
    });
    expect(res.statusCode).toBe(200);
    const { entries, manifest } = parseZipResponse(res.rawPayload as Buffer);
    // One PDF + manifest.
    expect(entries.size).toBe(2);
    const stripped = manifest.replace(/^\uFEFF/, '');
    const dataLines = stripped
      .split('\r\n')
      .filter((l) => l.length > 0)
      .slice(1);
    expect(dataLines.length).toBe(1);
  });
});

/**
 * Pick a substring that appears in exactly one invoice's recipient
 * name. Splits each recipient on whitespace, walks the resulting
 * tokens, and returns the first one that uniquely identifies its
 * invoice. Throws if no such token exists in the seeded set (would
 * indicate a seed change that this test must be updated against).
 */
function pickUniqueRecipientSubstring(invoices: InvoiceWire[]): string {
  const counts = new Map<string, number>();
  const tokensPerRow = invoices.map((i) =>
    (i.recipient?.name ?? '').split(/\s+/).filter((t) => t.length >= 4),
  );
  for (const tokens of tokensPerRow) {
    for (const t of new Set(tokens)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  for (const tokens of tokensPerRow) {
    for (const t of tokens) {
      if (counts.get(t) === 1) return t;
    }
  }
  throw new Error('seed has no unique recipient token — update fixture');
}
