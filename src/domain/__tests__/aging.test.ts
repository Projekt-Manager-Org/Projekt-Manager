import { describe, it, expect } from 'vitest';
import { getDaysInState, isAgingBold, getAgingText, isBufferAged } from '../aging';
import type { WorkflowState } from '@/config/stateConfig';

// The aging helpers are the concrete implementation of the kickoff's core
// motivation — "make inaction visible" (kickoff.md §core). Buffer states
// carry an `agingThresholdDays`; once a project sits past it the card shows
// "seit N Tagen" and the column raises the aged-buffer badge. Thresholds
// (stateConfig.ts): angebot 14, geplant 21, abnahme 7, abgerechnet 30.
// Action states age in bold only; active/done never age.

const NOW = new Date('2026-05-31T12:00:00Z');

/** ISO timestamp `days` calendar-days before NOW, same time-of-day so
 *  `differenceInCalendarDays` returns exactly `days`. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

describe('getDaysInState', () => {
  it('counts whole calendar days since the status changed', () => {
    expect(getDaysInState(daysAgo(0), NOW)).toBe(0);
    expect(getDaysInState(daysAgo(1), NOW)).toBe(1);
    expect(getDaysInState(daysAgo(30), NOW)).toBe(30);
    expect(getDaysInState(daysAgo(786), NOW)).toBe(786);
  });
});

describe('isBufferAged', () => {
  it('is true once a buffer project reaches its threshold, false below', () => {
    expect(isBufferAged('abgerechnet', daysAgo(29), NOW)).toBe(false);
    expect(isBufferAged('abgerechnet', daysAgo(30), NOW)).toBe(true); // boundary
    expect(isBufferAged('abgerechnet', daysAgo(34), NOW)).toBe(true);
  });

  it('respects each buffer state its own threshold', () => {
    expect(isBufferAged('angebot', daysAgo(13), NOW)).toBe(false);
    expect(isBufferAged('angebot', daysAgo(14), NOW)).toBe(true);
    expect(isBufferAged('abnahme', daysAgo(6), NOW)).toBe(false);
    expect(isBufferAged('abnahme', daysAgo(7), NOW)).toBe(true);
    expect(isBufferAged('geplant', daysAgo(21), NOW)).toBe(true);
  });

  it('never ages non-buffer states, however old', () => {
    // action states have no threshold; active/done are out of scope.
    for (const state of ['rechnung_faellig', 'anfrage', 'beauftragt', 'in_arbeit', 'erledigt']) {
      expect(isBufferAged(state as WorkflowState, daysAgo(999), NOW)).toBe(false);
    }
  });
});

describe('getAgingText', () => {
  it('returns "seit N Tagen" for an aged buffer project', () => {
    expect(getAgingText('abgerechnet', daysAgo(34), NOW)).toBe('seit 34 Tagen');
    expect(getAgingText('abgerechnet', daysAgo(30), NOW)).toBe('seit 30 Tagen'); // boundary
  });

  it('returns null below the threshold', () => {
    expect(getAgingText('abgerechnet', daysAgo(29), NOW)).toBeNull();
  });

  it('returns null for non-buffer states', () => {
    expect(getAgingText('rechnung_faellig', daysAgo(999), NOW)).toBeNull();
    expect(getAgingText('in_arbeit', daysAgo(999), NOW)).toBeNull();
    expect(getAgingText('erledigt', daysAgo(999), NOW)).toBeNull();
  });
});

describe('isAgingBold', () => {
  it('bolds action states once past agingBoldDays', () => {
    expect(isAgingBold('anfrage', daysAgo(2), NOW)).toBe(false);
    expect(isAgingBold('anfrage', daysAgo(3), NOW)).toBe(true); // boundary
    expect(isAgingBold('rechnung_faellig', daysAgo(3), NOW)).toBe(true);
  });

  it('bolds buffer states at their threshold', () => {
    expect(isAgingBold('abgerechnet', daysAgo(29), NOW)).toBe(false);
    expect(isAgingBold('abgerechnet', daysAgo(30), NOW)).toBe(true);
    expect(isAgingBold('angebot', daysAgo(14), NOW)).toBe(true);
  });

  it('never bolds active or done states', () => {
    expect(isAgingBold('in_arbeit', daysAgo(999), NOW)).toBe(false);
    expect(isAgingBold('erledigt', daysAgo(999), NOW)).toBe(false);
  });
});
