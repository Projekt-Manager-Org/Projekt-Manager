/**
 * Unit tests for the invoice-trigger decision (AC-372, architecture.md
 * §11.10 "Invoice trigger").
 *
 * The trigger polls every minute; this function decides whether that
 * poll starts a backup. Pinned: no run without a mark; a run while a
 * mark stands after a success (or before any run); after a failure, no
 * run until the retry delay has elapsed. The shared no-overlap guard is
 * pinned in `backup-runner-schedule.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { isInvoiceTriggerDue } from '../services/backup-trigger.js';

const NOW = new Date('2026-10-05T10:00:00.000Z');
const RETRY_MINUTES = 15;

function minutesAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000);
}

describe('isInvoiceTriggerDue (AC-372)', () => {
  it('is not due while no backup-pending mark exists, whatever the last outcome', () => {
    for (const lastBackup of [
      null,
      { ok: true, at: minutesAgo(60) },
      { ok: false, at: minutesAgo(60) },
    ]) {
      expect(
        isInvoiceTriggerDue({ hasMarks: false, lastBackup, now: NOW, retryMinutes: RETRY_MINUTES }),
      ).toBe(false);
    }
  });

  it('is due while a mark stands and the last run succeeded — even one that just finished', () => {
    expect(
      isInvoiceTriggerDue({
        hasMarks: true,
        lastBackup: { ok: true, at: minutesAgo(0) },
        now: NOW,
        retryMinutes: RETRY_MINUTES,
      }),
    ).toBe(true);
  });

  it('is due while a mark stands and no run has ever been recorded', () => {
    expect(
      isInvoiceTriggerDue({
        hasMarks: true,
        lastBackup: null,
        now: NOW,
        retryMinutes: RETRY_MINUTES,
      }),
    ).toBe(true);
  });

  it('waits the retry delay after a failed run, then is due again', () => {
    const due = (failedMinutesAgo: number) =>
      isInvoiceTriggerDue({
        hasMarks: true,
        lastBackup: { ok: false, at: minutesAgo(failedMinutesAgo) },
        now: NOW,
        retryMinutes: RETRY_MINUTES,
      });
    expect(due(0)).toBe(false);
    expect(due(RETRY_MINUTES - 1)).toBe(false);
    expect(due(RETRY_MINUTES)).toBe(true);
    expect(due(RETRY_MINUTES + 30)).toBe(true);
  });
});
