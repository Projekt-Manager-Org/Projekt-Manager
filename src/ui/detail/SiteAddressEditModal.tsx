/**
 * Modal wrapper around {@link SiteAddressGroup} for the project detail
 * page. Replaces the inline edit panel — see ui/project-detail.md
 * §8.15.2.
 *
 * Behaviour:
 *   - Loads the current `siteAddress` into the group; the toggle ON path
 *     submits `null`, the OFF path submits the trimmed triple. AC-281.
 *   - Surfaces the AC-284 partial-fill validation message inline.
 *   - Save dispatches PATCH via the project management store; on success
 *     the modal closes. The store has already written its own user-facing
 *     error on failure — the modal stays open so the user can retry.
 *   - Escape / overlay click cancels; both are no-ops while a save is
 *     in flight (mirrors CustomerEditForm).
 */

import { useCallback, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import type { Address } from '@/domain/types';
import { useProjectManagementStore } from '@/state/projectManagementStore';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { SiteAddressGroup, type SiteAddressGroupHandle } from '@/ui/management/SiteAddressGroup';
import managementStyles from '@/ui/management/Management.module.css';
import styles from './ProjectDetail.module.css';

interface Props {
  projectId: string;
  initial: Address | null;
  /**
   * Customer's billing address — surfaced through the group so the
   * disabled inputs visually reflect the address the project will
   * inherit when the toggle is ON. `null` when the customer has no
   * stored address.
   */
  customerAddress: Address | null;
  onClose: () => void;
}

export function SiteAddressEditModal({ projectId, initial, customerAddress, onClose }: Props) {
  const updateProject = useProjectManagementStore((s) => s.updateProject);

  const handleRef = useRef<SiteAddressGroupHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSave = async () => {
    if (submitting) return;
    const result = handleRef.current?.read() ?? { kind: 'valid', value: null };
    if (result.kind === 'partial') {
      setError(STRINGS.projects.siteAddressPartial);
      return;
    }
    setError(null);
    setSubmitting(true);
    const ok = await updateProject(projectId, { siteAddress: result.value });
    setSubmitting(false);
    if (ok) onClose();
  };

  const close = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  useEscapeKey(close);

  return (
    <div className={managementStyles.formOverlay} data-testid="site-address-modal">
      <form
        className={managementStyles.formPanel}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <h2 className={managementStyles.formTitle}>{STRINGS.projects.siteAddressLabel}</h2>

        <SiteAddressGroup
          initial={initial}
          customerAddress={customerAddress}
          disabled={submitting}
          handleRef={handleRef}
        />

        {error && (
          <div
            className={styles.fieldHintError}
            role="status"
            data-testid="project-site-address-error"
          >
            {error}
          </div>
        )}

        <div className={managementStyles.formActions}>
          <button
            type="button"
            className={managementStyles.cancelButton}
            onClick={close}
            disabled={submitting}
          >
            {STRINGS.ui.cancel}
          </button>
          <button
            type="submit"
            className={managementStyles.submitButton}
            disabled={submitting}
            data-testid="project-site-save"
          >
            {STRINGS.ui.save}
          </button>
        </div>
      </form>
    </div>
  );
}
