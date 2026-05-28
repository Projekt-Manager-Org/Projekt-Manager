import { describe, it, expect } from 'vitest';
import { formatBackupTimestampDE, formatDateOnly, formatDateTimeDE } from '../dateFormat';

// Z-suffixed inputs anchor the assertion to a single moment in time;
// the formatters bind to Europe/Berlin, so the expected wall clock is
// the same regardless of the runner's TZ (local dev on Berlin, CI on
// UTC, any future runner elsewhere).
describe('formatBackupTimestampDE', () => {
  it('formats as HH:mm EEE dd.MM.yyyy with German weekday', () => {
    // 2026-04-26T12:00Z → 14:00 Berlin (CEST, UTC+2), Sunday.
    expect(formatBackupTimestampDE('2026-04-26T12:00:00Z')).toBe('14:00 So. 26.04.2026');
  });

  it('uses the correct German weekday abbreviation for a weekday run', () => {
    // 2026-04-22T07:30Z → 09:30 Berlin (CEST), Wednesday — guards
    // against a regression that hardcodes one weekday or off-by-ones
    // the day index.
    expect(formatBackupTimestampDE('2026-04-22T07:30:00Z')).toBe('09:30 Mi. 22.04.2026');
  });

  it('zero-pads hour, minute, day, and month', () => {
    // 2026-01-05T02:07Z → 03:07 Berlin (CET, UTC+1 in winter), Monday.
    // Exercises the winter-vs-summer offset branch too.
    expect(formatBackupTimestampDE('2026-01-05T02:07:00Z')).toBe('03:07 Mo. 05.01.2026');
  });
});

describe('formatDateTimeDE', () => {
  it('formats UTC instants in Europe/Berlin wall clock (summer, UTC+2)', () => {
    // 2026-05-28T12:30Z → 14:30 CEST. Pins the audit-log/Aktivität
    // contract: the rendered timestamp must be Berlin time, not host
    // time — otherwise a node process on a UTC host (CI, default
    // cloud VM) would silently render the wrong wall clock.
    expect(formatDateTimeDE('2026-05-28T12:30:00Z')).toBe('28.05.2026 14:30');
  });

  it('formats UTC instants in Europe/Berlin wall clock (winter, UTC+1)', () => {
    // 2026-01-15T12:30Z → 13:30 CET.
    expect(formatDateTimeDE('2026-01-15T12:30:00Z')).toBe('15.01.2026 13:30');
  });
});

describe('formatDateOnly', () => {
  it('returns the local calendar date of the given Date instance', () => {
    // `new Date(2026, 6, 1)` always represents 2026-07-01 00:00 in the
    // local timezone, regardless of system TZ — so the local calendar
    // date is always 2026-07-01. The previously-used pattern
    // `d.toISOString().slice(0, 10)` returns the UTC date, which under
    // TZ east of UTC would yield 2026-06-30 here.
    expect(formatDateOnly(new Date(2026, 6, 1))).toBe('2026-07-01');
  });

  it('pads month and day to two digits', () => {
    expect(formatDateOnly(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(formatDateOnly(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});
