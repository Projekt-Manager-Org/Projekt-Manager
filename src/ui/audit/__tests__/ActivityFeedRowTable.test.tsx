/**
 * Aktivität view table row — Projekt column (AC-342) and existing
 * actor / entity / action / payload cells.
 *
 * The full /audit page lives in `AuditManagement.tsx` and is exercised
 * end-to-end by `e2e/audit-management.spec.ts`; this unit-level test
 * pins the row's column-vs-data wiring without dragging in the
 * filter-bar, store, or SSE subscription. Each `it(…)` covers exactly
 * one column-level claim from AC-342 — per the project's one-AC-per-
 * test convention (review/conventions-tests.md, T-REDU / T-ACBS).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AuditEntry } from '@/domain/audit';
import { ActivityFeedRowTable } from '@/ui/audit/ActivityFeedRowTable';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'audit-1',
    createdAt: '2026-05-28T12:30:00Z',
    actorId: 'u-1',
    actorKind: 'user',
    actorReason: null,
    actorDisplayName: 'Ola Owner',
    entityType: 'project',
    entityId: 'p-1',
    entityLabel: '2026-001 Vorgang',
    ancestorEntityLabel: '2026-001 Vorgang',
    action: 'create',
    payload: null,
    correlationId: null,
    ...overrides,
  };
}

/**
 * Wrap a single `<tr>` in a minimal `<table><tbody>` so RTL can render
 * it — a bare `<tr>` outside a table is a DOM warning AND swallowed by
 * the hostNode parent.
 */
function renderRow(entry: AuditEntry) {
  return render(
    <table>
      <tbody>
        <ActivityFeedRowTable entry={entry} />
      </tbody>
    </table>,
  );
}

describe('ActivityFeedRowTable — Projekt column (AC-342)', () => {
  it('renders the ancestorEntityLabel snapshot in the project cell for a child entity (attachment)', () => {
    renderRow(
      makeEntry({
        entityType: 'attachment',
        entityId: 'att-77',
        entityLabel: 'rechnung.pdf',
        action: 'attachment:add',
        ancestorEntityLabel: '2026-002 Weber Innenraum',
      }),
    );

    expect(screen.getByTestId('audit-row-project')).toHaveTextContent('2026-002 Weber Innenraum');
  });

  it('renders the project label for a project row (self-ancestor — same as entityLabel)', () => {
    renderRow(
      makeEntry({
        entityType: 'project',
        entityLabel: '2026-001 Vorgang',
        ancestorEntityLabel: '2026-001 Vorgang',
      }),
    );

    expect(screen.getByTestId('audit-row-project')).toHaveTextContent('2026-001 Vorgang');
  });

  it('renders an em dash for top-level entries with no project ancestor (customer)', () => {
    renderRow(
      makeEntry({
        entityType: 'customer',
        entityLabel: 'Firma Weber GmbH',
        ancestorEntityLabel: null,
      }),
    );

    expect(screen.getByTestId('audit-row-project')).toHaveTextContent('—');
  });

  it('renders an em dash for the user entity type (top-level)', () => {
    renderRow(
      makeEntry({
        entityType: 'user',
        entityLabel: 'Bob Builder',
        ancestorEntityLabel: null,
      }),
    );

    expect(screen.getByTestId('audit-row-project')).toHaveTextContent('—');
  });
});
