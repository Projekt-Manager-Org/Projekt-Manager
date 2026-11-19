/**
 * Unit tests: ExtractionService — LLM response parsing and error handling.
 *
 * These tests mock global `fetch` and `getEnv` to test the service logic
 * without hitting OpenRouter. They verify JSON parsing, markdown fence
 * stripping, null-coalescing, and error propagation.
 *
 * The LLM's extraction quality is NOT tested here — that requires manual
 * testing with real API calls (use sample emails from test/fixtures).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExtractionService } from '../services/ExtractionService.js';
import { SAMPLE_EMAILS } from '../../test/fixtures/sample-emails.js';

// Mock getEnv to control OPENROUTER_API_KEY presence
vi.mock('../config/env.js', () => ({
  getEnv: vi.fn(),
}));

import { getEnv } from '../config/env.js';
const mockGetEnv = vi.mocked(getEnv);

const mockLog = {
  info: vi.fn(),
  error: vi.fn(),
};

function mockFetchResponse(content: string, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  });
}

function mockFetchEmptyResponse() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [] }),
  });
}

describe('ExtractionService', () => {
  let service: ExtractionService;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    service = new ExtractionService();
    mockGetEnv.mockReturnValue({
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_MODEL: 'test-model',
    } as ReturnType<typeof getEnv>);
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ---------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------
  describe('input validation', () => {
    it('throws when OPENROUTER_API_KEY is not set', async () => {
      mockGetEnv.mockReturnValue({
        OPENROUTER_API_KEY: undefined,
      } as ReturnType<typeof getEnv>);

      await expect(service.extract('some email', mockLog)).rejects.toThrow('nicht konfiguriert');
    });

    it('AC-102: throws on blank input', async () => {
      await expect(service.extract('   ', mockLog)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('nicht leer'),
      });
    });
  });

  // ---------------------------------------------------------------
  // JSON parsing
  // ---------------------------------------------------------------
  describe('response parsing', () => {
    it('parses clean JSON response', async () => {
      const json = JSON.stringify(SAMPLE_EMAILS[0]!.expected);
      globalThis.fetch = mockFetchResponse(json);

      const result = await service.extract('test email', mockLog);

      expect(result.customer.name).toBe(SAMPLE_EMAILS[0]!.expected.customer.name);
      expect(result.customer.phone).toBe(SAMPLE_EMAILS[0]!.expected.customer.phone);
      expect(result.project.title).toBe(SAMPLE_EMAILS[0]!.expected.project.title);
    });

    it('strips ```json ... ``` markdown fences', async () => {
      const json = JSON.stringify(SAMPLE_EMAILS[1]!.expected);
      globalThis.fetch = mockFetchResponse('```json\n' + json + '\n```');

      const result = await service.extract('test email', mockLog);

      expect(result.customer.name).toBe(SAMPLE_EMAILS[1]!.expected.customer.name);
    });

    it('strips ``` ... ``` fences without json tag', async () => {
      const json = JSON.stringify(SAMPLE_EMAILS[2]!.expected);
      globalThis.fetch = mockFetchResponse('```\n' + json + '\n```');

      const result = await service.extract('test email', mockLog);

      expect(result.customer.name).toBe(SAMPLE_EMAILS[2]!.expected.customer.name);
    });

    it('null-coalesces missing fields', async () => {
      globalThis.fetch = mockFetchResponse(
        JSON.stringify({
          customer: { name: 'Test' },
          project: {},
        }),
      );

      const result = await service.extract('test email', mockLog);

      expect(result.customer.name).toBe('Test');
      expect(result.customer.phone).toBeNull();
      expect(result.customer.email).toBeNull();
      expect(result.customer.street).toBeNull();
      expect(result.customer.zip).toBeNull();
      expect(result.customer.city).toBeNull();
      expect(result.project.title).toBeNull();
      expect(result.project.description).toBeNull();
      expect(result.project.siteAddress).toBeNull();
    });

    it('handles null customer/project objects gracefully', async () => {
      globalThis.fetch = mockFetchResponse(JSON.stringify({ customer: null, project: null }));

      const result = await service.extract('test email', mockLog);

      expect(result.customer.name).toBeNull();
      expect(result.project.title).toBeNull();
      expect(result.project.siteAddress).toBeNull();
    });

    it('returns siteAddress as a full triple when the LLM emits all three fields', async () => {
      globalThis.fetch = mockFetchResponse(
        JSON.stringify({
          customer: { name: 'Schmidt HV' },
          project: {
            title: 'Treppenhaus',
            siteAddress: { street: 'Goethestr. 18', zip: '51103', city: 'Köln' },
          },
        }),
      );

      const result = await service.extract('test email', mockLog);

      expect(result.project.siteAddress).toEqual({
        street: 'Goethestr. 18',
        zip: '51103',
        city: 'Köln',
      });
    });

    it('collapses a partial siteAddress (missing field) to null', async () => {
      globalThis.fetch = mockFetchResponse(
        JSON.stringify({
          customer: { name: 'Test' },
          project: {
            title: 'X',
            siteAddress: { street: 'Goethestr. 18', zip: null, city: 'Köln' },
          },
        }),
      );

      const result = await service.extract('test email', mockLog);

      expect(result.project.siteAddress).toBeNull();
    });

    it('collapses a non-string siteAddress field to null', async () => {
      globalThis.fetch = mockFetchResponse(
        JSON.stringify({
          customer: { name: 'Test' },
          project: {
            title: 'X',
            siteAddress: { street: 'Goethestr. 18', zip: 51103, city: 'Köln' },
          },
        }),
      );

      const result = await service.extract('test email', mockLog);

      expect(result.project.siteAddress).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------
  describe('error handling', () => {
    it('throws on non-OK HTTP response', async () => {
      globalThis.fetch = mockFetchResponse('', false, 401);

      await expect(service.extract('test email', mockLog)).rejects.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith({ status: 401 }, 'openrouter_api_error');
    });

    it('throws on empty choices array', async () => {
      globalThis.fetch = mockFetchEmptyResponse();

      await expect(service.extract('test email', mockLog)).rejects.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith({}, 'openrouter_empty_response');
    });

    it('throws on unparseable response (not JSON)', async () => {
      globalThis.fetch = mockFetchResponse('This is not JSON at all');

      await expect(service.extract('test email', mockLog)).rejects.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(SyntaxError) }),
        'extraction_json_parse_failed',
      );
    });

    it('re-throws AppError (validation/server) without wrapping', async () => {
      mockGetEnv.mockReturnValue({
        OPENROUTER_API_KEY: undefined,
      } as ReturnType<typeof getEnv>);

      try {
        await service.extract('test', mockLog);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('nicht konfiguriert');
      }
    });
  });

  // ---------------------------------------------------------------
  // API call structure
  // ---------------------------------------------------------------
  describe('API call', () => {
    it('AC-737: sends the email text and a fixed prompt, nothing else, to OpenRouter', async () => {
      const mockFetch = mockFetchResponse(
        JSON.stringify({ customer: { name: 'Test' }, project: { title: 'Test' } }),
      );
      globalThis.fetch = mockFetch;

      await service.extract('email body here', mockLog);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer test-key');

      const body = JSON.parse(opts.body);
      expect(body.model).toBe('test-model');
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1].role).toBe('user');
      expect(body.messages[1].content).toBe('email body here');

      // The system message is a fixed prompt: no stored data rides along.
      await service.extract('another email', mockLog);
      const second = JSON.parse(mockFetch.mock.calls[1]![1].body);
      expect(second.messages[0].content).toBe(body.messages[0].content);
    });

    it('logs success on completed extraction', async () => {
      globalThis.fetch = mockFetchResponse(
        JSON.stringify({ customer: { name: 'X' }, project: {} }),
      );

      await service.extract('test', mockLog);

      expect(mockLog.info).toHaveBeenCalledWith({}, 'extraction_completed');
    });
  });
});
