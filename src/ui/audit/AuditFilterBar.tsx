/**
 * Filter bar for the global Aktivität view — `ui/management.md §8.13`.
 *
 * Split from `AuditManagement.tsx` so the parent stays under the C-SIZE
 * budget. The parent owns the `LocalFilters` state and the derived
 * `appliedFilters` / `filterKey`; this component renders the form and
 * surfaces validation state via props, so the filter bar itself is
 * purely presentational.
 */

import type { ChangeEvent } from 'react';
import { STRINGS } from '@/config/strings';
import { AUDIT_ACTION_KEYS, AUDIT_ACTION_LABELS } from '@/config/auditActionLabels';
import type { AuditEntityType } from '@/domain/audit';
import type { User } from '@/domain/types';
import styles from './AuditManagement.module.css';

export interface LocalFilters {
  entityType?: AuditEntityType;
  entityLabelQuery?: string;
  actorId?: string;
  action?: string;
  from?: string;
  to?: string;
}

interface Props {
  local: LocalFilters;
  entityTypeOptions: { value: AuditEntityType; label: string }[];
  /** User list — populated only when the caller holds `user:read`. */
  users: User[];
  /**
   * When true, render the actor field as a `<select>` over `users`;
   * otherwise fall back to a free-text UUID input. Gated on the
   * caller's `user:read` permission.
   */
  canReadUsers: boolean;
  /**
   * aria-invalid source for the entityLabelQuery input. Mirrored in the
   * caller as a `<div className={validationError}>` below the bar.
   */
  entityLabelHasError: boolean;
  /** aria-invalid source for the actor UUID input (free-text variant). */
  actorIdHasError: boolean;
  onChange: (patch: Partial<LocalFilters>) => void;
  onClear: () => void;
}

export function AuditFilterBar({
  local,
  entityTypeOptions,
  users,
  canReadUsers,
  entityLabelHasError,
  actorIdHasError,
  onChange,
  onClear,
}: Props) {
  const handleEntityTypeChange = (e: ChangeEvent<HTMLSelectElement>) =>
    onChange({
      entityType: (e.target.value || undefined) as AuditEntityType | undefined,
    });

  return (
    <div className={styles.filterBar}>
      <div className={styles.filterField}>
        <label className={styles.filterLabel} htmlFor="audit-filter-entity-type">
          {STRINGS.audit.filterEntityType}
        </label>
        <select
          id="audit-filter-entity-type"
          className={styles.filterSelect}
          value={local.entityType ?? ''}
          onChange={handleEntityTypeChange}
          data-testid="audit-filter-entity-type"
        >
          <option value="">{STRINGS.audit.allEntityTypes}</option>
          {entityTypeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.filterField}>
        <label className={styles.filterLabel} htmlFor="audit-filter-entity-label">
          {STRINGS.audit.filterEntityLabel}
        </label>
        <input
          id="audit-filter-entity-label"
          type="text"
          className={styles.filterInput}
          value={local.entityLabelQuery ?? ''}
          onChange={(e) => onChange({ entityLabelQuery: e.target.value || undefined })}
          placeholder={STRINGS.audit.filterEntityLabelPlaceholder}
          data-testid="audit-filter-entity-label"
          aria-invalid={entityLabelHasError ? 'true' : 'false'}
        />
      </div>

      <div className={styles.filterField}>
        <label className={styles.filterLabel} htmlFor="audit-filter-actor">
          {STRINGS.audit.filterActor}
        </label>
        {canReadUsers ? (
          <select
            id="audit-filter-actor"
            className={styles.filterSelect}
            value={local.actorId ?? ''}
            onChange={(e) => onChange({ actorId: e.target.value || undefined })}
            data-testid="audit-filter-actor"
          >
            <option value="">{STRINGS.audit.allActors}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
        ) : (
          <input
            id="audit-filter-actor"
            type="text"
            className={styles.filterInput}
            value={local.actorId ?? ''}
            onChange={(e) => onChange({ actorId: e.target.value || undefined })}
            placeholder="UUID"
            data-testid="audit-filter-actor"
            aria-invalid={actorIdHasError ? 'true' : 'false'}
          />
        )}
      </div>

      <div className={styles.filterField}>
        <label className={styles.filterLabel} htmlFor="audit-filter-action">
          {STRINGS.audit.filterAction}
        </label>
        <select
          id="audit-filter-action"
          className={styles.filterSelect}
          value={local.action ?? ''}
          onChange={(e) => onChange({ action: e.target.value || undefined })}
          data-testid="audit-filter-action"
        >
          <option value="">{STRINGS.audit.allActions}</option>
          {AUDIT_ACTION_KEYS.map((key) => (
            <option key={key} value={key}>
              {AUDIT_ACTION_LABELS[key]}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.filterField}>
        <label className={styles.filterLabel} htmlFor="audit-filter-from">
          {STRINGS.audit.filterFrom}
        </label>
        <input
          id="audit-filter-from"
          type="date"
          className={styles.filterInput}
          value={local.from ?? ''}
          onChange={(e) => onChange({ from: e.target.value || undefined })}
          data-testid="audit-filter-from"
        />
      </div>

      <div className={styles.filterField}>
        <label className={styles.filterLabel} htmlFor="audit-filter-to">
          {STRINGS.audit.filterTo}
        </label>
        <input
          id="audit-filter-to"
          type="date"
          className={styles.filterInput}
          value={local.to ?? ''}
          onChange={(e) => onChange({ to: e.target.value || undefined })}
          data-testid="audit-filter-to"
        />
      </div>

      <div className={styles.filterActions}>
        <button
          type="button"
          className={styles.clearButton}
          onClick={onClear}
          data-testid="audit-clear-filters"
        >
          {STRINGS.ui.clearFilter}
        </button>
      </div>
    </div>
  );
}
