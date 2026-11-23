/**
 * The session cookie's `Secure` flag — set in production outside the
 * HTTP-only evaluation mode (AC-775), left off inside it so sign-in
 * works over plain HTTP (AC-777).
 *
 * `getCookieSecure()` reads the validated env; the mock feeds it each
 * mode without running the production startup guards. The source pin
 * proves the sign-in route takes its flag from it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env.js')>();
  return { ...actual, getEnv: () => env.current };
});

const { getCookieSecure } = await import('../config/index.js');

beforeEach(() => {
  env.current = {};
});

describe('AC-775: Secure session cookie outside the evaluation mode', () => {
  it('is Secure in production', () => {
    env.current = { NODE_ENV: 'production' };
    expect(getCookieSecure()).toBe(true);
  });

  it('the sign-in route sets the flag from getCookieSecure()', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const authTs = readFileSync(path.resolve(here, '../routes/auth.ts'), 'utf8');
    expect(authTs).toMatch(/setCookie\(\s*'session'[\s\S]{0,200}?secure:\s*getCookieSecure\(\)/);
  });
});

describe('AC-777: no Secure flag in the evaluation mode', () => {
  it('is not Secure in the evaluation-mode configuration', () => {
    // docker-compose.http.yml: development mode with the flag set (AC-765
    // refuses the flag in production).
    env.current = { NODE_ENV: 'development', ALLOW_INSECURE_HTTP: 'true' };
    expect(getCookieSecure()).toBe(false);
  });
});
