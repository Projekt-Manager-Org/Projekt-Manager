/**
 * Modal wrapper around {@link SiteAddressGroup} for the project detail
 * page. Replaces the inline edit panel — see ui/project-detail.md
 * §8.15.2.
 *
 * Behaviour:
 *   - Loads the current `siteAddress` into the group; the toggle ON path
 *     submits `null`, the OFF path submits the trimmed triple. AC-281.
 *   - Surfaces the AC-284 partial-fill validation message inline.
 *   - Save dispatches PATCH via the project store with the version the
 *     modal opened at; on success the modal closes. On failure the
 *     modal stays open with the store's message; after a stale write
 *     (behavior.md §9.5) it reloads the refetched address and version.
 *   - Escape / overlay click cancels; both are no-ops while a save is
 *     in flight (mirrors CustomerEditForm).
 */

import { useCallback, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import type { Address } from '@/domain/types';
import { useProjectStore } from '@/state/projectStore';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { SiteAddressGroup, type SiteAddressGroupHandle } from '@/ui/management/SiteAddressGroup';
import managementStyles from '@/ui/management/Management.module.css';
import styles from './ProjectDetail.module.css';

interface Props {
  projectId: string;
  /** Project version when the modal opened — the edit's start version. */
  version: number;
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

export function SiteAddressEditModal({
  projectId,
  version,
  initial,
  customerAddress,
  onClose,
}: Props) {
  const updateProject = useProjectStore((s) => s.updateProject);
  // The edit's base: the version and address the modal opened with,
  // replaced only by the refetch after a stale write.
  const [base, setBase] = useState({ version, initial });

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
    const outcome = await updateProject(projectId, base.version, { siteAddress: result.value });
    setSubmitting(false);
    if (outcome === 'ok') {
      onClose();
      return;
    }
    const store = useProjectStore.getState();
    setError(store.mutationError);
    const fresh = store.projects.find((p) => p.id === projectId);
    if (outcome === 'conflict' && fresh) {
      setBase({ version: fresh.version, initial: fresh.siteAddress });
    }
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
          // Re-seed the group's own field state from a refetched base.
          key={base.version}
          initial={base.initial}
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
