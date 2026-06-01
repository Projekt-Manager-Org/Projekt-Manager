import { describe, it, expect } from 'vitest';
import { computeSummary } from '../summary';
import type { Project } from '../types';

// `computeSummary` drives the board's at-a-glance "inaction" surfaces:
// the per-column aged-buffer badge (agedBufferCounts) and the calendar
// view's "X Projekte ohne Termin" counter (projectsWithoutDates).

const NOW = new Date('2026-05-31T12:00:00Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function makeProject(p: Partial<Project> & Pick<Project, 'status' | 'statusChangedAt'>): Project {
  return {
    id: 'id',
    number: '2026-001',
    title: 'Test',
    customerId: 'c',
    customer: null,
    siteAddress: null,
    plannedStart: null,
    plannedEnd: null,
    assignedWorkers: null,
    estimatedValue: null,
    notes: null,
    deleted: false,
    createdAt: daysAgo(60),
    updatedAt: daysAgo(60),
    createdBy: null,
    updatedBy: null,
    ...p,
  };
}

describe('computeSummary — aged buffer counts', () => {
  it('counts only buffer projects past their threshold, grouped by state', () => {
    const projects = [
      makeProject({ status: 'abgerechnet', statusChangedAt: daysAgo(34) }), // aged
      makeProject({ status: 'abgerechnet', statusChangedAt: daysAgo(41) }), // aged
      makeProject({ status: 'abgerechnet', statusChangedAt: daysAgo(5) }), // fresh
      makeProject({ status: 'angebot', statusChangedAt: daysAgo(20) }), // aged (>14)
      makeProject({ status: 'rechnung_faellig', statusChangedAt: daysAgo(99) }), // action — never aged
      makeProject({ status: 'in_arbeit', statusChangedAt: daysAgo(99) }), // active — never aged
    ];

    const summary = computeSummary(projects, NOW);

    const byState = new Map(summary.agedBufferCounts.map((c) => [c.state, c]));
    expect(byState.get('abgerechnet')).toEqual({
      state: 'abgerechnet',
      count: 2,
      thresholdDays: 30,
    });
    expect(byState.get('angebot')).toEqual({ state: 'angebot', count: 1, thresholdDays: 14 });
    // Action and active states never contribute.
    expect(byState.has('rechnung_faellig')).toBe(false);
    expect(byState.has('in_arbeit')).toBe(false);
  });

  it('emits no aged-buffer entries when every buffer project is fresh', () => {
    const projects = [makeProject({ status: 'abgerechnet', statusChangedAt: daysAgo(5) })];
    expect(computeSummary(projects, NOW).agedBufferCounts).toEqual([]);
  });
});

describe('computeSummary — projects without dates', () => {
  it('counts projects missing both planned dates', () => {
    const projects = [
      makeProject({ status: 'anfrage', statusChangedAt: daysAgo(1) }), // no dates
      makeProject({ status: 'geplant', statusChangedAt: daysAgo(1), plannedStart: daysAgo(0) }),
      makeProject({ status: 'geplant', statusChangedAt: daysAgo(1), plannedEnd: daysAgo(0) }),
    ];
    expect(computeSummary(projects, NOW).projectsWithoutDates).toBe(1);
  });
});
