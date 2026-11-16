/**
 * "Alles anzeigen" toggle for the global Aktivität view (AC-660,
 * ui/management.md §8.13).
 *
 * Purely presentational: the parent owns the boolean state and the
 * filter-wiring decision. Unchecked (default) = recipient-scoped mode;
 * checked = full RBAC-scoped feed.
 *
 * State is local to the mount — the parent does not persist it; the
 * component has no side effects beyond firing `onChange`.
 */

import type { ChangeEvent } from 'react';
import { STRINGS } from '@/config/strings';
import styles from './AuditManagement.module.css';

interface Props {
  /** True when the user has flipped to the full RBAC-scoped feed. */
  showAll: boolean;
  onChange: (showAll: boolean) => void;
}

export function AuditScopeToggle({ showAll, onChange }: Props) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked);

  return (
    <label className={styles.scopeToggle}>
      <input
        type="checkbox"
        checked={showAll}
        onChange={handleChange}
        data-testid="activity-recipient-toggle"
      />
      <span>{STRINGS.audit.toggleShowAll}</span>
    </label>
  );
}
