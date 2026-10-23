/**
 * Create form for a new project. Owns its own field state plus the
 * number-preflight and idempotent-UUID machinery. Returns control via
 * onClose when the user cancels or a successful/conflict create lands.
 */

import { useCallback, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useProjectManagementStore } from '@/state/projectManagementStore';
import { MenuBackdrop } from '../common/MenuBackdrop';
import { SiteAddressGroup, type SiteAddressGroupHandle } from './SiteAddressGroup';
import styles from './Management.module.css';

type NumberPreflightStatus = 'idle' | 'checking' | 'available' | 'taken';

interface Props {
  onClose: () => void;
}

export function ProjectCreateForm({ onClose }: Props) {
  const customers = useProjectManagementStore((s) => s.customers);
  const searchProjects = useProjectManagementStore((s) => s.searchProjects);
  const createProject = useProjectManagementStore((s) => s.createProject);
  const error = useProjectManagementStore((s) => s.error);

  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Surfaces the AC-485 all-or-none Baustelle validation. Cleared on
  // every fresh submit attempt; only set when read() returns `partial`.
  const [siteAddressError, setSiteAddressError] = useState<string | null>(null);

  // Client-supplied UUID for idempotent create. Stable across re-renders
  // so a retry after a transient failure replays rather than duplicating.
  const createIdRef = useRef<string>(crypto.randomUUID());

  // Imperative handle on the Baustelle group — read at submit time so the
  // group owns its draft and the parent never reaches into its internals.
  const siteAddressRef = useRef<SiteAddressGroupHandle | null>(null);

  const [numberStatus, setNumberStatus] = useState<NumberPreflightStatus>('idle');
  // Monotonic request id so two overlapping blurs cannot commit out of
  // order — the response that completes second may carry the older value.
  const numberPreflightReqRef = useRef(0);

  const handleNumberBlur = async () => {
    const trimmed = number.trim();
    if (!trimmed) {
      numberPreflightReqRef.current++;
      setNumberStatus('idle');
      return;
    }
    const myReq = ++numberPreflightReqRef.current;
    setNumberStatus('checking');
    const results = await searchProjects(trimmed);
    // Only commit if this is still the latest request — a later blur
    // (or a change-driven reset) must win.
    if (myReq !== numberPreflightReqRef.current) return;
    const taken = results.some((p) => p.number === trimmed);
    setNumberStatus(taken ? 'taken' : 'available');
  };

  const handleCreate = async () => {
    if (submitting || !number.trim() || !title.trim() || !customerId) return;

    // AC-485: all-or-none on the Baustelle group. `read()` distinguishes
    // a valid value (null OR full triple) from a partial fill; partial
    // blocks submit and surfaces the German validation hint.
    const siteResult = siteAddressRef.current?.read() ?? { kind: 'valid', value: null };
    if (siteResult.kind === 'partial') {
      setSiteAddressError(STRINGS.projects.siteAddressPartial);
      return;
    }
    setSiteAddressError(null);

    setSubmitting(true);

    const outcome = await createProject({
      id: createIdRef.current,
      number: number.trim(),
      title: title.trim(),
      customerId,
      siteAddress: siteResult.value,
    });

    setSubmitting(false);

    if (outcome.status === 'ok' || outcome.status === 'conflict') {
      onClose();
    }
  };

  const close = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  useEscapeKey(close);

  return (
    <div className={styles.formOverlay}>
      <form
        className={styles.formPanel}
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <h2 className={styles.formTitle}>
          {STRINGS.entities.project} {STRINGS.ui.create}
        </h2>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.number} *</label>
          <input
            className={styles.formInput}
            value={number}
            onChange={(e) => {
              setNumber(e.target.value);
              // Clear the preflight verdict on edit — re-runs on the
              // next blur. Bump the request id so a still-in-flight
              // fetch from the prior value cannot commit its result.
              numberPreflightReqRef.current++;
              if (numberStatus !== 'idle') setNumberStatus('idle');
            }}
            onBlur={() => void handleNumberBlur()}
            disabled={submitting}
            data-testid="project-number-input"
            autoFocus
          />
          {numberStatus === 'taken' && (
            <div className={styles.fieldHintError} data-testid="project-number-taken" role="status">
              {STRINGS.projects.numberTaken(number.trim())}
            </div>
          )}
          {numberStatus === 'available' && (
            <div
              className={styles.fieldHintOk}
              data-testid="project-number-available"
              role="status"
            >
              {STRINGS.projects.numberAvailable}
            </div>
          )}
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.title} *</label>
          <input
            className={styles.formInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={submitting}
            data-testid="project-title-input"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.customer} *</label>
          <div className={styles.selectWrapper} data-testid="project-customer-select">
            <input
              className={styles.formInput}
              value={customerId ? (customers.find((c) => c.id === customerId)?.name ?? '') : ''}
              readOnly
              onClick={() => !submitting && setCustomerDropdownOpen(!customerDropdownOpen)}
              disabled={submitting}
              placeholder={STRINGS.ui.search}
            />
            {customerDropdownOpen && (
              <>
                <MenuBackdrop onClose={() => setCustomerDropdownOpen(false)} />
                <div className={styles.selectDropdown}>
                  {customers.map((c) => (
                    <div
                      key={c.id}
                      className={styles.selectOption}
                      onClick={() => {
                        setCustomerId(c.id);
                        setCustomerDropdownOpen(false);
                      }}
                    >
                      {c.name}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <SiteAddressGroup
          initial={null}
          customerAddress={customers.find((c) => c.id === customerId)?.address ?? null}
          disabled={submitting}
          handleRef={siteAddressRef}
        />
        {siteAddressError && (
          <div
            className={styles.fieldHintError}
            data-testid="project-site-address-error"
            role="status"
          >
            {siteAddressError}
          </div>
        )}

        {error && <div className={styles.error}>{error}</div>}

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
            disabled={submitting || !number.trim() || !title.trim() || !customerId}
            data-testid="project-submit"
          >
            {STRINGS.ui.create}
          </button>
        </div>
      </form>
    </div>
  );
}
