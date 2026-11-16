/**
 * Notification rule form — create + edit (`ui/management.md §8.14`).
 *
 * AC-199 conditional rendering lives here:
 *   - `Ziel-Status` is rendered only for transition events.
 *   - `Zugewiesene Mitarbeiter benachrichtigen` is disabled and forced
 *     `false` for non-project events (`backup.failed`,
 *     `disk.threshold_reached`).
 *
 * The event dropdown is a native `<select>` to match the Playwright
 * `selectOption()` contract in `e2e/notification-rules.spec.ts`. The
 * user picker lives in a sibling component (`NotificationRuleUserPicker`)
 * to keep this file under the C-SIZE guideline.
 *
 * Server-side validation is authoritative (AC-190). The form
 * masks disallowed fields at submit time (state filter null on non-
 * transition events; assigned-workers false on non-project events) so
 * a stale-state UI never posts a payload the server will 422-reject on
 * shape grounds. The server message is still surfaced if the round-trip
 * fails on another branch.
 */

import { useCallback, useEffect, useState } from 'react';
import type { NotificationRule } from '@/domain/notifications';
import {
  NOTIFICATION_EVENT_CLASSES,
  NOTIFICATION_EVENT_LABELS,
  PROJECT_SCOPED_EVENT_CLASSES,
  TRANSITION_EVENT_CLASSES,
  type NotificationEventClass,
} from '@/config/notificationEvents';
import { ROLE_KEYS } from '@/config/roleKeys';
import { STATE_CONFIGS } from '@/config/stateConfig';
import { STRINGS } from '@/config/strings';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useNotificationRuleStore } from '@/state/notificationRuleStore';
import { useUserStore } from '@/state/userStore';
import { NotificationRuleUserPicker } from './NotificationRuleUserPicker';
import styles from './Management.module.css';

interface Props {
  /** Rule being edited; null on create. */
  rule: NotificationRule | null;
  onClose: () => void;
  onSaved: () => void;
}

const DEFAULT_EVENT_CLASS: NotificationEventClass = 'project.transition_forward';

export function NotificationRuleForm({ rule, onClose, onSaved }: Props) {
  const createRule = useNotificationRuleStore((s) => s.createRule);
  const updateRule = useNotificationRuleStore((s) => s.updateRule);
  const storeError = useNotificationRuleStore((s) => s.error);
  const clearStoreError = useNotificationRuleStore((s) => s.clearError);

  // Owner holds `user:read`, so this list call is in-scope for the only
  // role that reaches this form. Inactive rows are retained in the
  // picker's internal map so an already-selected user whose account was
  // just deactivated still renders as a name rather than a bare UUID.
  const users = useUserStore((s) => s.users);
  const fetchUsers = useUserStore((s) => s.fetchUsers);

  const [eventClass, setEventClass] = useState<NotificationEventClass>(
    rule?.eventClass ?? DEFAULT_EVENT_CLASS,
  );
  const [stateFilter, setStateFilter] = useState<string>(rule?.stateFilter ?? '');
  const [selectedRoles, setSelectedRoles] = useState<string[]>(rule?.recipientSpec.roles ?? []);
  const [includeAssignedWorkers, setIncludeAssignedWorkers] = useState<boolean>(
    rule?.recipientSpec.includeAssignedWorkers ?? false,
  );
  const [userIds, setUserIds] = useState<string[]>(rule?.recipientSpec.userIds ?? []);
  const [enabled, setEnabled] = useState<boolean>(rule?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  // Clear any stale store error from a prior form cycle so the banner
  // does not carry over between mounts. The cleanup clears it on exit
  // too, so navigating back to the list view starts clean.
  useEffect(() => {
    clearStoreError();
    return () => {
      clearStoreError();
    };
  }, [clearStoreError]);

  const isTransition = TRANSITION_EVENT_CLASSES.has(eventClass);
  const isProjectScoped = PROJECT_SCOPED_EVENT_CLASSES.has(eventClass);

  const close = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  useEscapeKey(close);

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const addUser = (id: string) => {
    setUserIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  const removeUser = (id: string) => {
    setUserIds((prev) => prev.filter((u) => u !== id));
  };

  // Effective values — apply the event-class masks at render / submit
  // time rather than syncing dependent state via effects. The disabled
  // toggle is forced `false` when `!isProjectScoped`; the state-filter
  // dropdown is not rendered when `!isTransition`.
  const effectiveStateFilter = isTransition && stateFilter !== '' ? stateFilter : null;
  const effectiveAssignedWorkers = isProjectScoped && includeAssignedWorkers;

  const hasRecipient = selectedRoles.length > 0 || effectiveAssignedWorkers || userIds.length > 0;
  const canSubmit = !submitting && hasRecipient;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);

    const payload = {
      eventClass,
      stateFilter: effectiveStateFilter,
      recipientSpec: {
        roles: selectedRoles,
        includeAssignedWorkers: effectiveAssignedWorkers,
        userIds,
      },
      enabled,
    };

    const ok = rule ? await updateRule(rule.id, payload) : await createRule(payload);

    setSubmitting(false);
    if (ok) onSaved();
  };

  return (
    <div className={styles.formOverlay}>
      <form
        className={styles.formPanel}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          void handleSubmit();
        }}
      >
        <h2 className={styles.formTitle}>
          {rule ? STRINGS.notifications.rules.editTitle : STRINGS.notifications.rules.createTitle}
        </h2>

        <div className={styles.formGroup}>
          <label className={styles.formLabel} htmlFor="notification-rule-event-select">
            {STRINGS.notifications.rules.event} *
          </label>
          <select
            id="notification-rule-event-select"
            className={styles.formSelect}
            value={eventClass}
            onChange={(e) => setEventClass(e.target.value as NotificationEventClass)}
            disabled={submitting}
            data-testid="notification-rule-event-select"
          >
            {NOTIFICATION_EVENT_CLASSES.map((ec) => (
              <option key={ec} value={ec}>
                {NOTIFICATION_EVENT_LABELS[ec]}
              </option>
            ))}
          </select>
        </div>

        {isTransition && (
          <div className={styles.formGroup}>
            <label className={styles.formLabel} htmlFor="notification-rule-state-filter">
              {STRINGS.notifications.rules.stateFilter}
            </label>
            <select
              id="notification-rule-state-filter"
              className={styles.formSelect}
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              disabled={submitting}
              data-testid="notification-rule-state-filter"
            >
              <option value="">{STRINGS.notifications.rules.stateFilterAny}</option>
              {STATE_CONFIGS.map((cfg) => (
                <option key={cfg.key} value={cfg.key}>
                  {cfg.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.notifications.rules.recipientRoles}</label>
          <div className={styles.checkboxGroup}>
            {ROLE_KEYS.map((role) => (
              <label key={role} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={selectedRoles.includes(role)}
                  onChange={() => toggleRole(role)}
                  disabled={submitting}
                  data-testid={`notification-rule-role-${role}`}
                />
                {STRINGS.roles[role] ?? role}
              </label>
            ))}
          </div>
        </div>

        <div className={styles.formGroup}>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={effectiveAssignedWorkers}
              onChange={(e) => setIncludeAssignedWorkers(e.target.checked)}
              disabled={submitting || !isProjectScoped}
              data-testid="notification-rule-assigned-workers-toggle"
            />
            {STRINGS.notifications.rules.recipientAssignedWorkers}
          </label>
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel} htmlFor="notification-rule-user-search">
            {STRINGS.notifications.rules.recipientUsers}
          </label>
          <NotificationRuleUserPicker
            users={users}
            selectedIds={userIds}
            onAdd={addUser}
            onRemove={removeUser}
            disabled={submitting}
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={submitting}
              data-testid="notification-rule-enabled-toggle"
            />
            {STRINGS.notifications.rules.enabled}
          </label>
        </div>

        {storeError && <div className={styles.error}>{storeError}</div>}

        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={close}
            disabled={submitting}
          >
            {STRINGS.ui.cancel}
          </button>
          <button
            type="submit"
            className={styles.submitButton}
            disabled={!canSubmit}
            data-testid="notification-rule-submit"
          >
            {STRINGS.ui.save}
          </button>
        </div>
      </form>
    </div>
  );
}
