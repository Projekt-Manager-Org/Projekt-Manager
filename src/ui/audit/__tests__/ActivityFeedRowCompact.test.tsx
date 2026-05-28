/**
 * Activity dock compact row — AC-339.
 *
 * The dock surfaces the live audit feed as a glanceable strip — one
 * line per row, no payload drawer. This unit suite pins the row's
 * Aktor · Projekt · Beschreibung wiring and the timestamp/data-attribute
 * contract the e2e harness reads back (`data-action`, `data-created-at`,
 * `data-testid="activity-feed-row-<id>"`).
 *
 * The dock-level scenarios (toggle, route hide, Alt+A) live in
 * `src/ui/layout/__tests__/ActivityDock.test.tsx`; this file fences the
 * row component itself so a refactor of the row markup is caught here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AuditEntry } from '@/domain/audit';
import { ActivityFeedRowCompact } from '@/ui/audit/ActivityFeedRowCompact';

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

afterEach(() => {
  cleanup();
});

describe('ActivityFeedRowCompact — AC-339 single-line shape', () => {
  it('renders Aktor · Projekt · Beschreibung in one row with the actor display name', () => {
    render(<ActivityFeedRowCompact entry={makeEntry()} />);
    const row = screen.getByTestId('activity-feed-row-audit-1');
    expect(row).toHaveTextContent('Ola Owner');
    expect(row).toHaveTextContent('2026-001 Vorgang');
  });

  it('falls back to a neutral "Benutzer" label when actorDisplayName is null', () => {
    render(<ActivityFeedRowCompact entry={makeEntry({ actorDisplayName: null })} />);
    expect(screen.getByTestId('activity-feed-row-audit-1')).toHaveTextContent('Benutzer');
  });

  it('renders System (reason) for a system-actor row', () => {
    render(
      <ActivityFeedRowCompact
        entry={makeEntry({
          actorKind: 'system',
          actorId: null,
          actorDisplayName: null,
          actorReason: 'hidden-reaper',
        })}
      />,
    );
    expect(screen.getByTestId('activity-feed-row-audit-1')).toHaveTextContent(
      'System (hidden-reaper)',
    );
  });

  it('renders bare "System" when actorReason is null', () => {
    render(
      <ActivityFeedRowCompact
        entry={makeEntry({
          actorKind: 'system',
          actorId: null,
          actorDisplayName: null,
          actorReason: null,
        })}
      />,
    );
    const row = screen.getByTestId('activity-feed-row-audit-1');
    expect(row).toHaveTextContent('System');
    expect(row).not.toHaveTextContent('hidden-reaper');
  });

  it('renders em dash in the project slot for a top-level entity (customer)', () => {
    render(
      <ActivityFeedRowCompact
        entry={makeEntry({
          entityType: 'customer',
          entityLabel: 'Firma Weber',
          ancestorEntityLabel: null,
        })}
      />,
    );
    expect(screen.getByTestId('activity-feed-row-audit-1')).toHaveTextContent('—');
  });

  it('renders the ancestor project label for a child entity (attachment)', () => {
    render(
      <ActivityFeedRowCompact
        entry={makeEntry({
          entityType: 'attachment',
          entityId: 'att-77',
          entityLabel: 'rechnung.pdf',
          action: 'attachment:add',
          ancestorEntityLabel: '2026-002 Weber Innenraum',
        })}
      />,
    );
    expect(screen.getByTestId('activity-feed-row-audit-1')).toHaveTextContent(
      '2026-002 Weber Innenraum',
    );
  });

  it('exposes data-action and data-created-at for the e2e contract', () => {
    render(<ActivityFeedRowCompact entry={makeEntry({ action: 'transition:forward' })} />);
    const row = screen.getByTestId('activity-feed-row-audit-1');
    expect(row).toHaveAttribute('data-action', 'transition:forward');
    expect(row).toHaveAttribute('data-created-at', '2026-05-28T12:30:00Z');
  });

  it('does NOT render a payload drawer toggle — dock is a glanceable strip', () => {
    render(<ActivityFeedRowCompact entry={makeEntry()} />);
    expect(screen.queryByTestId('activity-feed-drawer-toggle')).toBeNull();
  });

  it('renders the German-formatted timestamp', () => {
    render(<ActivityFeedRowCompact entry={makeEntry()} />);
    // formatDateTimeDE produces DD.MM.YYYY HH:mm in Europe/Berlin.
    // The input 2026-05-28T12:30:00Z lands at 14:30 CEST (UTC+2).
    expect(screen.getByTestId('activity-feed-row-audit-1')).toHaveTextContent(/28\.05\.2026 14:30/);
  });
});
