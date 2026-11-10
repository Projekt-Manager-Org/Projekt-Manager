/**
 * User management view — list, create, deactivate, reactivate, reset password.
 *
 * Only accessible to users with user:manage permission.
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 22–24.
 */

import { useEffect, useState } from 'react';
import { useUserStore } from '@/state/userStore';
import { usePermission } from '@/hooks/usePermission';
import { STRINGS } from '@/config/strings';
import type { User } from '@/domain/types';
import { UserCreateForm } from './UserCreateForm';
import { UserDetailPanel } from './UserDetailPanel';
import styles from './Management.module.css';

export function UserManagement() {
  const canManage = usePermission('user:manage');

  const users = useUserStore((s) => s.users);
  const loading = useUserStore((s) => s.loading);
  const error = useUserStore((s) => s.error);
  const fetchUsers = useUserStore((s) => s.fetchUsers);
  const clearError = useUserStore((s) => s.clearError);

  const [formOpen, setFormOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const openCreateForm = () => {
    clearError();
    setSelectedUser(null);
    setFormOpen(true);
  };

  const handleRowClick = (u: User) => {
    setSelectedUser(u);
    setFormOpen(false);
    clearError();
  };

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        {canManage && (
          <button
            className={styles.createButton}
            onClick={openCreateForm}
            data-testid="user-create-button"
          >
            {STRINGS.ui.create}
          </button>
        )}
      </div>

      {error && !formOpen && !selectedUser && <div className={styles.error}>{error}</div>}

      <table className={styles.table} data-testid="user-table">
        <thead>
          <tr>
            <th>{STRINGS.ui.username}</th>
            <th>{STRINGS.ui.displayName}</th>
            <th>{STRINGS.ui.roles}</th>
            <th>{STRINGS.ui.email}</th>
            <th>{STRINGS.ui.status}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr
              key={u.id}
              className={`${styles.clickableRow} ${u.active ? '' : `${styles.rowInactive} deactivated`}`}
              onClick={() => handleRowClick(u)}
            >
              <td data-label={STRINGS.ui.username}>{u.username}</td>
              <td data-label={STRINGS.ui.displayName}>{u.displayName}</td>
              <td data-label={STRINGS.ui.roles}>
                {u.roles.map((r) => STRINGS.roles[r] ?? r).join(', ')}
              </td>
              <td data-label={STRINGS.ui.email}>{u.email ?? '—'}</td>
              <td data-label={STRINGS.ui.status}>
                <span
                  className={`${styles.badge} ${u.active ? styles.badgeActive : styles.badgeInactive}`}
                >
                  {u.active ? STRINGS.ui.active : STRINGS.ui.inactive}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && users.length === 0 && (
        <div className={styles.noResults}>{STRINGS.ui.noResults}</div>
      )}

      {formOpen && <UserCreateForm onClose={() => setFormOpen(false)} />}

      {selectedUser && !formOpen && (
        <UserDetailPanel user={selectedUser} onClose={() => setSelectedUser(null)} />
      )}
    </div>
  );
}
