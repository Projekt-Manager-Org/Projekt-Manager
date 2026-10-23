import { afterAll, beforeAll } from 'vitest';

/**
 * Run the enclosing suite under `tz`. Node applies a runtime
 * `process.env.TZ` change only in the main thread of a process, so a
 * `threads` pool would silently keep the host zone — the check makes
 * that fail loudly instead of letting a zone-sensitive test go blind.
 */
export function useTimezone(tz: string): void {
  const originalTZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = tz;
    const active = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (active !== tz) throw new Error(`timezone switch to ${tz} ignored (still ${active})`);
  });
  afterAll(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });
}
