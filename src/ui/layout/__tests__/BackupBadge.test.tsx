/**
 * Backup badge rendering — AC-612 [crit]: each state shows the colour and
 * label of its ui/index.md §8.1.2 badge-table row, followed by the last
 * backup run's time when there is one.
 *
 * Condition → state is pinned by `src/domain/__tests__/backupBadge.test.ts`;
 * this file pins state → what the owner sees.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { BackupBadgeState } from '@/domain/backupBadge';
import { BackupBadge } from '@/ui/layout/BackupBadge';

afterEach(cleanup);

/** 12:00 Berlin (CEST) on a Friday. */
const AT = '2026-04-17T10:00:00.000Z';
const AT_DE = '12:00 Fr. 17.04.2026';

// One row per badge-table row, in table order: state, colour class,
// label as rendered. Label and colour are the table's own; the colour
// column maps to the module's state classes.
const T = ` (${AT_DE})`;
const ROWS: ReadonlyArray<[BackupBadgeState, string, string]> = [
  [{ kind: 'unknown', label: 'Status unbekannt' }, 'stateUnknown', 'Status unbekannt'],
  [{ kind: 'red', reason: 'backup-never-run' }, 'stateRed', 'Backup: noch nie ausgeführt'],
  [
    { kind: 'red', reason: 'last-run-failed', lastBackupAt: AT },
    'stateRed',
    `Backup: fehlgeschlagen${T}`,
  ],
  [
    { kind: 'red', reason: 'drill-failed', lastBackupAt: AT },
    'stateRed',
    `Drill: fehlgeschlagen${T}`,
  ],
  [
    { kind: 'red', reason: 'drill-never-run', lastBackupAt: AT },
    'stateRed',
    `Drill: noch nie ausgeführt${T}`,
  ],
  [{ kind: 'red', reason: 'backup-stale', lastBackupAt: AT }, 'stateRed', `Backup: veraltet${T}`],
  [{ kind: 'red', reason: 'drill-expired', lastBackupAt: AT }, 'stateRed', `Drill: überfällig${T}`],
  [
    { kind: 'amber', reason: 'drill-stale', lastBackupAt: AT },
    'stateAmber',
    `Backup: aktuell, Drill-Schlüssel neu laden${T}`,
  ],
  [
    { kind: 'amber', reason: 'backup-aging', lastBackupAt: AT },
    'stateAmber',
    `Backup: wird alt${T}`,
  ],
  [{ kind: 'green', lastBackupAt: AT }, 'stateGreen', `Backup: aktuell${T}`],
];

describe('AC-612: backup badge — colour and label per badge-table row', () => {
  it.each(ROWS)('%#: renders %s as %s, %s', (state, colourClass, label) => {
    render(<BackupBadge state={state} />);
    const badge = screen.getByTestId('backup-badge');
    expect(badge).toHaveClass(colourClass);
    expect(badge).toHaveAttribute('aria-label', label);
    expect(badge).toHaveAttribute('title', label);
  });

  it('shows no time for "Backup: noch nie ausgeführt" even when one is passed', () => {
    // No run to point at. The type admits `lastBackupAt` on every red
    // reason, so the renderer, not the type, enforces the rule.
    render(<BackupBadge state={{ kind: 'red', reason: 'backup-never-run', lastBackupAt: AT }} />);
    expect(screen.getByTestId('backup-badge')).toHaveAttribute(
      'aria-label',
      'Backup: noch nie ausgeführt',
    );
  });

  it('shows the bare label when a non-green state has no last run time', () => {
    render(<BackupBadge state={{ kind: 'red', reason: 'drill-never-run' }} />);
    expect(screen.getByTestId('backup-badge')).toHaveAttribute(
      'aria-label',
      'Drill: noch nie ausgeführt',
    );
  });
});
