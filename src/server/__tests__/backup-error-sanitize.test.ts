/**
 * Unit tests for `sanitizeErrorMessage` — the defense-in-depth helper
 * that strips credential-shaped substrings from any error message
 * before it lands on the `meta_backup_status` error fields (returned
 * verbatim to the owner via `backupStatus` on `GET /api/auth/me`).
 *
 * Covers the security-audit C1 finding: a `pg_dump` subprocess error
 * that echoes `DATABASE_URL` into stderr used to bubble the embedded
 * password through to the status surface. The service-side fix is
 * two-pronged — the subprocess now receives discrete PG* vars instead
 * of DATABASE_URL, AND every write to an error field runs through this
 * sanitizer as belt-and-suspenders.
 */

import { describe, it, expect } from 'vitest';

import { sanitizeErrorMessage } from '../services/backup.js';

describe('sanitizeErrorMessage (C1)', () => {
  it('strips password from a pasted connection string', () => {
    const raw =
      'pg_dump: error: connection to server at "db" failed: ' +
      'authentication failed for user "pm" (conninfo was ' +
      'postgresql://pm:hunter2@db:5432/projekt_manager)';
    const out = sanitizeErrorMessage(raw);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('pm:hunter2');
    expect(out).toContain('postgresql://<redacted>@db');
  });

  it('strips password from a postgres:// short scheme', () => {
    const raw = 'connect: postgres://pm:secret@h/d';
    const out = sanitizeErrorMessage(raw);
    expect(out).not.toContain('secret');
    expect(out).toContain('<redacted>');
  });

  it('strips query-string password=', () => {
    const raw =
      'connect: dbname=x user=pm password=hunter2 host=h ' +
      '— url echoed as host=h?password=hunter2&sslmode=require';
    const out = sanitizeErrorMessage(raw);
    expect(out).not.toMatch(/password=hunter2/);
    expect(out).toContain('password=<redacted>');
  });

  it('strips a known-secret literal anywhere in the message', () => {
    const raw = 'libpq error: the value hunter2 was not accepted';
    const out = sanitizeErrorMessage(raw, ['hunter2']);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('<redacted>');
  });

  it('returns a safe fallback when the raw message is empty', () => {
    expect(sanitizeErrorMessage('')).toBe('<no error message>');
  });

  it('is a no-op when no credentials are present', () => {
    const raw = 'tier-1-mismatch on users';
    expect(sanitizeErrorMessage(raw)).toBe(raw);
  });

  it('handles multiple URLs in the same message', () => {
    const raw = 'tried postgresql://a:1@h1/d then postgresql://b:2@h2/d — both failed';
    const out = sanitizeErrorMessage(raw);
    expect(out).not.toContain('a:1');
    expect(out).not.toContain('b:2');
    expect((out.match(/postgresql:\/\/<redacted>@/g) ?? []).length).toBe(2);
  });
});
