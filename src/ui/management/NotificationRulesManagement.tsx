/**
 * Notification Rules admin view — `ui/management.md §8.14`.
 *
 * Owner-only surface (gated on `notifications:manage` per AC-75).
 * Lists every rule with a compact recipient summary, opens a single
 * form for create / edit, and deletes through the shared confirm
 * dialog (AC-199 form conditionals live in `NotificationRuleForm`).
 *
 * State flows through `notificationRuleStore` so the UI layer never
 * imports the API client directly (ARCHITECTURE.md § Architecture Overview +
 * eslint restricted imports).
 */

import { useEffect, useState } from 'react';
import type { NotificationRule } from '@/domain/notifications';
import { NOTIFICATION_EVENT_LABELS } from '@/config/notificationEvents';
import { usePermission } from '@/hooks/usePermission';
import { useConfirmStore } from '@/state/confirmStore';
import { useNotificationRuleStore } from '@/state/notificationRuleStore';
import { STRINGS } from '@/config/strings';
import { STATE_CONFIGS } from '@/config/stateConfig';
import { NotificationRuleForm } from './NotificationRuleForm';
import styles from './Management.module.css';
import localStyles from './NotificationRulesManagement.module.css';

function stateFilterLabel(stateFilter: string | null): string {
  if (!stateFilter) return STRINGS.notifications.rules.summaryEmpty;
  const cfg = STATE_CONFIGS.find((c) => c.key === stateFilter);
  return cfg?.label ?? stateFilter;
}

/** Compose the recipient summary shown in the `Empfänger` column. */
function recipientSummary(rule: NotificationRule): string {
  const parts: string[] = [];
  const { roles, includeAssignedWorkers, userIds } = rule.recipientSpec;
  if (roles.length > 0) {
    const labels = roles.map((r) => STRINGS.roles[r] ?? r).join(', ');
    parts.push(STRINGS.notifications.rules.summaryRoles(labels));
  }
  if (includeAssignedWorkers) {
    parts.push(STRINGS.notifications.rules.summaryAssignedWorkers);
  }
  if (userIds.length > 0) {
    parts.push(STRINGS.notifications.rules.summaryUsers(userIds.length));
  }
  return parts.length > 0 ? parts.join(' · ') : STRINGS.notifications.rules.summaryEmpty;
}

export function NotificationRulesManagement() {
  const canManage = usePermission('notifications:manage');

  const rules = useNotificationRuleStore((s) => s.rules);
  const loading = useNotificationRuleStore((s) => s.loading);
  const error = useNotificationRuleStore((s) => s.error);
  const fetchRules = useNotificationRuleStore((s) => s.fetchRules);
  const deleteRule = useNotificationRuleStore((s) => s.deleteRule);
  const clearError = useNotificationRuleStore((s) => s.clearError);

  const requestConfirm = useConfirmStore((s) => s.request);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<NotificationRule | null>(null);

  useEffect(() => {
    void fetchRules();
  }, [fetchRules]);

  const openCreate = () => {
    clearError();
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (rule: NotificationRule) => {
    clearError();
    setEditing(rule);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const handleSaved = () => {
    closeForm();
  };

  const handleDelete = async (rule: NotificationRule) => {
    const confirmed = await requestConfirm(STRINGS.notifications.rules.deleteConfirm);
    if (!confirmed) return;
    await deleteRule(rule.id);
  };

  return (
    <div className={styles.container} data-testid="notification-rules-view">
      <div className={styles.toolbar}>
        {canManage && (
          <button
            className={styles.createButton}
            onClick={openCreate}
            data-testid="notification-rule-create-button"
          >
            {STRINGS.notifications.rules.createButton}
          </button>
        )}
      </div>

      {error && !formOpen && <div className={styles.error}>{error}</div>}

      <table className={styles.table} data-testid="notification-rules-list">
        <thead>
          <tr>
            <th>{STRINGS.notifications.rules.colEvent}</th>
            <th>{STRINGS.notifications.rules.colFilter}</th>
            <th>{STRINGS.notifications.rules.colRecipients}</th>
            <th>{STRINGS.notifications.rules.colEnabled}</th>
            <th>{STRINGS.notifications.rules.colActions}</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id} data-testid={`notification-rule-row-${rule.id}`}>
              <td data-label={STRINGS.notifications.rules.colEvent}>
                {NOTIFICATION_EVENT_LABELS[rule.eventClass] ?? rule.eventClass}
              </td>
              <td data-label={STRINGS.notifications.rules.colFilter}>
                {stateFilterLabel(rule.stateFilter)}
              </td>
              <td
                data-label={STRINGS.notifications.rules.colRecipients}
                className={localStyles.recipientCell}
              >
                {recipientSummary(rule)}
              </td>
              <td data-label={STRINGS.notifications.rules.colEnabled}>
                <span
                  className={`${styles.badge} ${rule.enabled ? styles.badgeActive : styles.badgeInactive}`}
                  data-testid="notification-rule-enabled-indicator"
                  data-enabled={rule.enabled ? 'true' : 'false'}
                >
                  {rule.enabled ? STRINGS.ui.active : STRINGS.ui.inactive}
                </span>
              </td>
              <td>
                {canManage && (
                  <div className={localStyles.actionsCell}>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={() => openEdit(rule)}
                      data-testid="notification-rule-edit-button"
                    >
                      {STRINGS.ui.edit}
                    </button>
                    <button
                      type="button"
                      className={styles.dangerButton}
                      onClick={() => void handleDelete(rule)}
                      data-testid="notification-rule-delete-button"
                    >
                      {STRINGS.ui.delete}
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && rules.length === 0 && (
        <div className={styles.noResults}>{STRINGS.notifications.rules.emptyList}</div>
      )}

      {formOpen && (
        <NotificationRuleForm rule={editing} onClose={closeForm} onSaved={handleSaved} />
      )}
    </div>
  );
}
