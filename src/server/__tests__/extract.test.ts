/**
 * Route integration tests: POST /api/extract — LLM email extraction.
 *
 * Covers the route-level contract: auth gate, permission gate, schema
 * validation, happy path (with mocked upstream) and upstream failure.
 * The ExtractionService's unit-level logic is tested in extraction.test.ts;
 * this file pins the route contract (authentication, authorization,
 * validation, error category mapping) end-to-end via Fastify inject.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { startApp, stopApp, getApp, login, authPost } from '../../test/api-helpers.js';

describe('POST /api/extract', () => {
  let ownerToken: string;
  let workerToken: string;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    // The ExtractionService requires OPENROUTER_API_KEY to be set (it throws
    // a validation error otherwise). Set a test value BEFORE startApp so
    // validateEnvRuntime picks it up. Tests that reach the upstream mock fetch.
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
  });

  // ---------------------------------------------------------------
  // AC-100: Unauthenticated requests are rejected
  // ---------------------------------------------------------------
  it('AC-100: unauthenticated request is rejected with auth error', async () => {
    const res = await getApp().inject({
      method: 'POST',
      url: '/api/extract',
      payload: { text: 'any email text' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });

  // ---------------------------------------------------------------
  // AC-101: customer:write permission required
  // ---------------------------------------------------------------
  it('AC-101: worker role (no customer:write) is rejected with authorization error', async () => {
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
  // AC-103: Successful extraction returns structured fields
  // ---------------------------------------------------------------
  it('AC-103: successful extraction returns customer + project sections with nulls for missing data', async () => {
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
  // AC-104: Upstream failure mapped to server error, no leak
  // ---------------------------------------------------------------
  it('AC-104: upstream service failure is mapped to a server error with no internal details leaked', async () => {
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
});
