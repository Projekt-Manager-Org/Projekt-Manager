/**
 * Route integration tests: POST /api/extract — LLM email extraction — and
 * GET /api/extract/status — whether extraction is configured (AC-734).
 *
 * Covers the route-level contract: auth gate, permission gate, schema
 * validation, happy path (with mocked upstream), upstream failure and the
 * not-configured refusal.
 * The ExtractionService's unit-level logic is tested in extraction.test.ts;
 * this file pins the route contract (authentication, authorization,
 * validation, error category mapping) end-to-end via Fastify inject.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { count } from 'drizzle-orm';
import {
  startApp,
  stopApp,
  getApp,
  getDb,
  login,
  authGet,
  authPost,
} from '../../test/api-helpers.js';
import { customers, projects } from '../db/schema.js';

/** Sets or clears the extraction key for the next request — the service
 * and the status route read the environment per request. */
function setExtractionKey(value: string | undefined): void {
  if (value === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = value;
}

async function rowCounts(): Promise<{ customers: number; projects: number }> {
  const db = getDb();
  const [c] = await db.select({ n: count() }).from(customers);
  const [p] = await db.select({ n: count() }).from(projects);
  return { customers: c!.n, projects: p!.n };
}

/** A well-formed upstream answer carrying a customer and a project. */
function mockUpstreamSuccess(): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              customer: { name: 'Erika Muster', street: 'Ring 2', zip: '50667', city: 'Köln' },
              project: { title: 'Bad sanieren', description: null, siteAddress: null },
            }),
          },
        },
      ],
    }),
  }) as unknown as typeof fetch;
}

let ownerToken: string;
let workerToken: string;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  // Extraction is configured by default; the not-configured tests clear
  // the key per request (`setExtractionKey`). Tests that reach the
  // upstream mock fetch.
  process.env.OPENROUTER_API_KEY = 'test-key-for-integration';
  await startApp();
  ownerToken = await login('inhaber', 'changeme');
  workerToken = await login('arbeiter1', 'changeme');
});

afterAll(async () => {
  await stopApp();
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setExtractionKey('test-key-for-integration');
});

describe('POST /api/extract', () => {
  // ---------------------------------------------------------------
  // AC-574: Unauthenticated requests are rejected
  // ---------------------------------------------------------------
  it('AC-574: unauthenticated request is rejected with auth error', async () => {
    const res = await getApp().inject({
      method: 'POST',
      url: '/api/extract',
      payload: { text: 'any email text' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });

  // ---------------------------------------------------------------
  // AC-576: customer:write permission required
  // ---------------------------------------------------------------
  it('AC-576: worker role (no customer:write) is rejected with authorization error', async () => {
    const res = await authPost(workerToken, '/api/extract', { text: 'any email text' });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });

  // ---------------------------------------------------------------
  // AC-102: Input validation
  // ---------------------------------------------------------------
  it('AC-102: empty text is rejected as a validation error', async () => {
    const res = await authPost(ownerToken, '/api/extract', { text: '' });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('AC-102: text exceeding 50,000 characters is rejected as a validation error', async () => {
    const res = await authPost(ownerToken, '/api/extract', { text: 'x'.repeat(50_001) });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  // ---------------------------------------------------------------
  // Successful extraction returns the fields found, null for the rest
  // ---------------------------------------------------------------
  it('successful extraction returns customer + project sections with nulls for missing data', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                customer: {
                  name: 'Max Mustermann',
                  phone: '+49 123 456',
                  email: 'max@example.de',
                  street: 'Hauptstr. 1',
                  zip: '12345',
                  city: 'Berlin',
                },
                project: {
                  title: 'Fassadenanstrich',
                  description: null,
                },
              }),
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await authPost(ownerToken, '/api/extract', {
      text: 'Guten Tag, ich hätte gerne einen Fassadenanstrich. Max Mustermann, Hauptstr. 1, 12345 Berlin.',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.customer.name).toBe('Max Mustermann');
    expect(body.customer.phone).toBe('+49 123 456');
    expect(body.customer.email).toBe('max@example.de');
    expect(body.customer.street).toBe('Hauptstr. 1');
    expect(body.customer.zip).toBe('12345');
    expect(body.customer.city).toBe('Berlin');
    expect(body.project.title).toBe('Fassadenanstrich');
    expect(body.project.description).toBeNull();
    // Single-address email: project.siteAddress falls back to null even
    // when the upstream omits the field entirely.
    expect(body.project.siteAddress).toBeNull();
  });

  it('returns a full siteAddress triple when the email mentions a separate Baustelle', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                customer: {
                  name: 'Schmidt Hausverwaltung GmbH',
                  phone: null,
                  email: null,
                  street: 'Kölner Str. 45',
                  zip: '51429',
                  city: 'Bergisch Gladbach',
                },
                project: {
                  title: 'Treppenhaus streichen',
                  description: null,
                  siteAddress: {
                    street: 'Goethestr. 18',
                    zip: '51103',
                    city: 'Köln',
                  },
                },
              }),
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await authPost(ownerToken, '/api/extract', {
      text: 'Hausverwaltung mit Baustelle in Goethestr. 18, 51103 Köln, Rechnungsadresse Kölner Str. 45, 51429 Bergisch Gladbach.',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.customer.street).toBe('Kölner Str. 45');
    expect(body.project.siteAddress).toEqual({
      street: 'Goethestr. 18',
      zip: '51103',
      city: 'Köln',
    });
  });

  // ---------------------------------------------------------------
  // AC-733: Upstream failure refused as a server error, no internal details
  // ---------------------------------------------------------------
  it('AC-733: upstream service failure is mapped to a server error with no internal details leaked', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const res = await authPost(ownerToken, '/api/extract', { text: 'some email text' });

    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('SERVER_ERROR');

    // No internal details leaked — no upstream name, stack, or API path.
    const rawBody = res.body;
    expect(rawBody.toLowerCase()).not.toContain('openrouter');
    expect(rawBody.toLowerCase()).not.toContain('stack');
    expect(rawBody.toLowerCase()).not.toContain('api/v1/chat');
  });
  it('AC-782: an upstream failure echoing the API key does not pass the key on', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid key test-key-for-integration' } }),
      text: async () => 'Invalid key test-key-for-integration',
    }) as unknown as typeof fetch;

    const res = await authPost(ownerToken, '/api/extract', { text: 'some email text' });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('test-key-for-integration');
  });

  // ---------------------------------------------------------------
  // AC-739: an extraction stores nothing
  // ---------------------------------------------------------------
  it('AC-739: a successful extraction leaves no customer or project row', async () => {
    mockUpstreamSuccess();
    const before = await rowCounts();

    const res = await authPost(ownerToken, '/api/extract', {
      text: 'Erika Muster, Ring 2, 50667 Köln — bitte das Bad sanieren.',
    });

    expect(res.statusCode).toBe(200);
    expect(await rowCounts()).toEqual(before);
  });

  // ---------------------------------------------------------------
  // AC-738: not configured — server error naming no configuration
  // ---------------------------------------------------------------
  describe('while extraction is not configured', () => {
    it('AC-738: email text within the AC-102 bounds is refused as a server error naming no configuration', async () => {
      setExtractionKey(undefined);
      const upstream = vi.fn();
      globalThis.fetch = upstream as unknown as typeof fetch;

      const res = await authPost(ownerToken, '/api/extract', { text: 'some email text' });

      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('SERVER_ERROR');
      const body = res.body.toLowerCase();
      expect(body).not.toContain('openrouter');
      expect(body).not.toContain('api_key');
      expect(body).not.toContain('konfiguriert');
      expect(upstream).not.toHaveBeenCalled();
    });

    it('AC-102: blank text is still refused as a validation error', async () => {
      setExtractionKey(undefined);

      const res = await authPost(ownerToken, '/api/extract', { text: '   ' });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('AC-102: text exceeding 50,000 characters is still refused as a validation error', async () => {
      setExtractionKey(undefined);

      const res = await authPost(ownerToken, '/api/extract', { text: 'x'.repeat(50_001) });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });
  });
});

// ---------------------------------------------------------------
// AC-734: the client learns whether extraction is configured
// ---------------------------------------------------------------
describe('GET /api/extract/status', () => {
  it('AC-734: reports configured while the extraction key is set', async () => {
    const res = await authGet(ownerToken, '/api/extract/status');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: true });
  });

  it('AC-734: reports not configured while the extraction key is unset', async () => {
    setExtractionKey(undefined);

    const res = await authGet(ownerToken, '/api/extract/status');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false });
  });

  it('AC-574: unauthenticated request is rejected with auth error', async () => {
    const res = await getApp().inject({ method: 'GET', url: '/api/extract/status' });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });

  it('AC-576: worker role (no customer:write) is rejected with authorization error', async () => {
    const res = await authGet(workerToken, '/api/extract/status');

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });
});
