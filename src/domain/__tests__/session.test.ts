import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isSessionExpired } from '../session';

describe('session expiry', () => {
  // Freeze the clock so the reference "now" is deterministic across runs.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-09T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // AC-27: a session past its expiresAt is treated as invalid
  it('AC-27: session past expiresAt is treated as expired', () => {
    // expiresAt is 1 minute before the frozen "now" → expired.
    expect(isSessionExpired({ expiresAt: '2026-04-09T09:59:00.000Z' })).toBe(true);
  });

  it('AC-27: session before expiresAt is treated as valid', () => {
    // expiresAt is 1 minute after the frozen "now" → valid.
    expect(isSessionExpired({ expiresAt: '2026-04-09T10:01:00.000Z' })).toBe(false);
  });

  // Boundary: expiresAt === now. Current impl uses strict `<`, so "exactly
  // now" means "not yet expired". Pin the semantic so a future change to
  // `<=` is visible in the diff.
  it('AC-27: session expiring exactly now is treated as valid (strict <)', () => {
    expect(isSessionExpired({ expiresAt: '2026-04-09T10:00:00.000Z' })).toBe(false);
  });
});
