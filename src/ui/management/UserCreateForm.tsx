/**
 * Create form for a new user. Owns username, display name, password,
 * password confirmation, and role selection.
 */

import { useCallback, useState } from 'react';
import { useUserStore } from '@/state/userStore';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { STRINGS } from '@/config/strings';
import styles from './Management.module.css';

const AVAILABLE_ROLES = Object.keys(STRINGS.roles);

interface Props {
  onClose: () => void;
}

export function UserCreateForm({ onClose }: Props) {
  const createUser = useUserStore((s) => s.createUser);
  const error = useUserStore((s) => s.error);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const passwordsMatch = password === passwordConfirm;

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const canSubmit =
    !submitting &&
    username.trim().length > 0 &&
    displayName.trim().length > 0 &&
    password.trim().length > 0 &&
    passwordsMatch &&
    selectedRoles.length > 0;

  const handleCreate = async () => {
    if (!canSubmit) return;
    setSubmitting(true);

    const trimmedEmail = email.trim();
    const ok = await createUser({
      username: username.trim(),
      displayName: displayName.trim(),
      password,
      roles: selectedRoles,
      email: trimmedEmail ? trimmedEmail : null,
    });

    setSubmitting(false);
    if (ok) onClose();
  };

  const close = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  useEscapeKey(close);

  return (
    <div className={styles.formOverlay}>
      <div className={styles.formPanel}>
        <h2 className={styles.formTitle}>
          {STRINGS.entities.user} {STRINGS.ui.create}
        </h2>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.username} *</label>
          <input
            className={styles.formInput}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting}
            data-testid="user-username-input"
            autoFocus
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.displayName} *</label>
          <input
            className={styles.formInput}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={submitting}
            data-testid="user-displayname-input"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.email}</label>
          <input
            className={styles.formInput}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            data-testid="user-email-input"
            autoComplete="email"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.auth.password} *</label>
          <input
            className={styles.formInput}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            data-testid="user-password-input"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.password.confirm} *</label>
          <input
            className={styles.formInput}
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            disabled={submitting}
            data-testid="user-password-confirm-input"
          />
          {password && passwordConfirm && !passwordsMatch && (
            <div className={styles.error}>{STRINGS.password.mismatch}</div>
          )}
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.roles} *</label>
          <div className={styles.checkboxGroup}>
            {AVAILABLE_ROLES.map((role) => (
              <label key={role} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={selectedRoles.includes(role)}
                  onChange={() => toggleRole(role)}
                  disabled={submitting}
                  data-testid={`user-role-${role}`}
                />
                {STRINGS.roles[role]}
              </label>
            ))}
          </div>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.formActions}>
          <button className={styles.cancelButton} onClick={close} disabled={submitting}>
            {STRINGS.ui.cancel}
          </button>
          <button
            className={styles.submitButton}
            onClick={handleCreate}
            disabled={!canSubmit}
            data-testid="user-submit"
          >
            {STRINGS.ui.create}
          </button>
        </div>
      </div>
    </div>
  );
}
