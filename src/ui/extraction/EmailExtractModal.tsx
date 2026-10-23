/**
 * Email extraction modal — paste email text, extract customer + project data.
 *
 * Opened from a button in the Header. Contains a textarea for the email,
 * extracted customer/project fields for review, and a sequential save
 * (customer first, then project with returned customerId). See ADR-0015/0016.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  extractFromEmail,
  searchCustomers,
  createCustomerFromExtraction,
  createProjectFromExtraction,
} from '@/state/extractionActions';
import { useCustomerStore } from '@/state/customerStore';
import { useProjectManagementStore } from '@/state/projectManagementStore';
import { useProjectStore } from '@/state/projectStore';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { STRINGS } from '@/config/strings';
import type { Address, Customer } from '@/domain/types';
import { MenuBackdrop } from '../common/MenuBackdrop';
import { SiteAddressGroup, type SiteAddressGroupHandle } from '../management/SiteAddressGroup';
import styles from '../management/Management.module.css';

interface Props {
  onClose: () => void;
}

export function EmailExtractModal({ onClose }: Props) {
  // Extraction state
  const [emailText, setEmailText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState(false);

  // Customer fields
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [street, setStreet] = useState('');
  const [zip, setZip] = useState('');
  const [city, setCity] = useState('');

  // Existing customer match
  const [matchSearch, setMatchSearch] = useState('');
  const [matchResults, setMatchResults] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [matchDropdownOpen, setMatchDropdownOpen] = useState(false);

  // Project fields
  const [projectTitle, setProjectTitle] = useState('');
  const [projectNumber, setProjectNumber] = useState('');
  // Extracted Baustelle (work-site address) seed for the SiteAddressGroup
  // below. Set once when extraction completes; the group owns its own
  // editable draft from that point on. Null seeds the group with toggle ON
  // ("site = customer billing address"), matching the data-model.md §5.1
  // fallback rule for emails that mention only one address.
  const [extractedSiteAddress, setExtractedSiteAddress] = useState<Address | null>(null);
  // AC-485 partial-fill validation hint, set by handleSave on a partial read.
  const [siteAddressError, setSiteAddressError] = useState<string | null>(null);

  // Save state
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client-supplied UUIDs for idempotent create. Generated once per modal
  // instance (on mount) and stable across re-renders and retries. The
  // customer id is only used when the user creates a new customer; the
  // project id is only used when a project is actually being created. A
  // single stable id per slot lets a retry after a transient failure
  // collapse to a replay rather than duplicating the row.
  //
  // Freshness across logical opens depends on the parent unmounting the
  // modal between opens (see Header.tsx — `{extractOpen && <Modal/>}`).
  // If a future refactor keeps the modal mounted for transitions, these
  // refs would reuse UUIDs across logical opens — breaking idempotency
  // by turning a fresh create into a replay against a stale id.
  const customerCreateIdRef = useRef<string>(crypto.randomUUID());
  const projectCreateIdRef = useRef<string>(crypto.randomUUID());

  // Imperative handle on the Baustelle group — read at submit time so the
  // group owns its draft and the parent never reaches into its internals.
  const siteAddressRef = useRef<SiteAddressGroupHandle | null>(null);

  const fetchCustomers = useCustomerStore((s) => s.fetchCustomers);
  const fetchMgmtProjects = useProjectManagementStore((s) => s.fetchProjects);

  const safeClose = useCallback(() => {
    if (extracting || saving) return;
    onClose();
  }, [extracting, saving, onClose]);

  useEscapeKey(safeClose);

  // Search for existing customers when match search changes.
  // Empty search is handled via derivation (effectiveMatchResults below)
  // to avoid synchronous setState inside the effect body.
  useEffect(() => {
    if (!matchSearch.trim()) return;
    const timer = setTimeout(async () => {
      const results = await searchCustomers(matchSearch);
      setMatchResults(results);
    }, 300);
    return () => clearTimeout(timer);
  }, [matchSearch]);

  // When search is empty, suppress stale results without a synchronous setState.
  // Memoized so downstream useMemo deps (customerAddressPreview) only invalidate
  // when the underlying inputs actually change — a fresh `[]` literal each render
  // would re-fire dependents on every keystroke.
  const effectiveMatchResults = useMemo(
    () => (matchSearch.trim() ? matchResults : []),
    [matchSearch, matchResults],
  );

  const handleExtract = async () => {
    if (extracting || !emailText.trim()) return;
    setError(null);
    setExtracting(true);

    const result = await extractFromEmail(emailText);

    setExtracting(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    const { customer, project } = result.data;
    setCustomerName(customer.name ?? '');
    setPhone(customer.phone ?? '');
    setEmail(customer.email ?? '');
    setStreet(customer.street ?? '');
    setZip(customer.zip ?? '');
    setCity(customer.city ?? '');
    setMatchSearch(customer.name ?? '');
    setProjectTitle(project.title ?? '');
    setExtractedSiteAddress(project.siteAddress);
    setExtracted(true);
  };

  // Customer address fed to SiteAddressGroup as the disabled-toggle-ON
  // preview. Reflects either the matched existing customer's address or
  // the operator's typed draft for a new customer. Reactive — switching
  // matches or editing the typed address updates the preview live.
  const customerAddressPreview = useMemo<Address | null>(() => {
    if (selectedCustomerId) {
      return effectiveMatchResults.find((c) => c.id === selectedCustomerId)?.address ?? null;
    }
    const s = street.trim();
    const z = zip.trim();
    const c = city.trim();
    return s && z && c ? { street: s, zip: z, city: c } : null;
  }, [selectedCustomerId, effectiveMatchResults, street, zip, city]);

  const handleSave = async () => {
    if (saving) return;
    setError(null);

    // AC-485: all-or-none on the Baustelle group. Read the draft *before*
    // any network call so a partial fill blocks the save without creating
    // a stranded customer row from step 1.
    const siteResult = siteAddressRef.current?.read() ?? { kind: 'valid' as const, value: null };
    if (siteResult.kind === 'partial') {
      setSiteAddressError(STRINGS.projects.siteAddressPartial);
      return;
    }
    setSiteAddressError(null);

    setSaving(true);

    let custId = selectedCustomerId;

    // Step 1: create customer if no existing match selected
    if (!custId) {
      if (!customerName.trim()) {
        setError(STRINGS.customers.nameRequired);
        setSaving(false);
        return;
      }

      const address =
        street.trim() || zip.trim() || city.trim()
          ? { street: street.trim(), zip: zip.trim(), city: city.trim() }
          : null;

      const custResult = await createCustomerFromExtraction({
        id: customerCreateIdRef.current,
        name: customerName.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        address,
      });

      if (!custResult.ok) {
        setError(custResult.error.message);
        setSaving(false);
        return;
      }

      custId = custResult.data.id;
      // Record the committed id so a subsequent retry (e.g. project step
      // below failed transiently) skips the customer-create branch and
      // uses the existing row instead of replaying the create — which
      // would either waste an idempotent call or, if the user edited a
      // field between attempts, provoke an IDEMPOTENCY_CONFLICT.
      setSelectedCustomerId(custId);
    }

    // Step 2: create project if title is provided
    if (projectTitle.trim()) {
      const num = projectNumber.trim() || generateProjectNumber();

      const projResult = await createProjectFromExtraction({
        id: projectCreateIdRef.current,
        number: num,
        title: projectTitle.trim(),
        customerId: custId,
        siteAddress: siteResult.value,
      });

      if (!projResult.ok) {
        setError(projResult.error.message);
        setSaving(false);
        // Customer was already created — that's fine, it's a real customer
        return;
      }
    }

    // Refresh stores
    fetchCustomers();
    fetchMgmtProjects();
    useProjectStore.getState().fetchProjects();

    setSaving(false);
    onClose();
  };

  return (
    <div className={styles.formOverlay}>
      <form
        className={styles.formPanel}
        onSubmit={(e) => {
          e.preventDefault();
          if (!extracted) {
            if (extracting || !emailText.trim()) return;
            void handleExtract();
          } else {
            if (saving || (!selectedCustomerId && !customerName.trim())) return;
            void handleSave();
          }
        }}
      >
        <h2 className={styles.formTitle}>{STRINGS.ui.extractEmail}</h2>

        {!extracted ? (
          <>
            <div className={styles.formGroup}>
              <textarea
                className={styles.formTextarea}
                value={emailText}
                onChange={(e) => setEmailText(e.target.value)}
                placeholder={STRINGS.ui.extractPlaceholder}
                rows={10}
                autoFocus
                disabled={extracting}
                data-testid="extract-email-input"
              />
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={safeClose}
                disabled={extracting}
              >
                {STRINGS.ui.cancel}
              </button>
              <button
                type="submit"
                className={styles.submitButton}
                disabled={extracting || !emailText.trim()}
                data-testid="extract-submit"
              >
                {extracting ? (
                  <>
                    <span className={styles.spinner} />
                    {STRINGS.ui.extracting}
                  </>
                ) : (
                  <>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={{ verticalAlign: 'middle', marginRight: 6 }}
                    >
                      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
                      <path d="M5 3v4" />
                      <path d="M19 17v4" />
                      <path d="M3 5h4" />
                      <path d="M17 19h4" />
                    </svg>
                    {STRINGS.ui.extractButton}
                  </>
                )}
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Customer section */}
            <h3>{STRINGS.ui.customerData}</h3>

            {/* Existing customer search */}
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.existingCustomer}</label>
              <div className={styles.selectWrapper}>
                <input
                  className={styles.formInput}
                  value={
                    selectedCustomerId
                      ? (effectiveMatchResults.find((c) => c.id === selectedCustomerId)?.name ??
                        matchSearch)
                      : matchSearch
                  }
                  onChange={(e) => {
                    setMatchSearch(e.target.value);
                    setSelectedCustomerId(null);
                    setMatchDropdownOpen(true);
                  }}
                  onClick={() => effectiveMatchResults.length > 0 && setMatchDropdownOpen(true)}
                  placeholder={STRINGS.ui.search}
                  disabled={saving}
                  data-testid="extract-customer-search"
                />
                {matchDropdownOpen && effectiveMatchResults.length > 0 && (
                  <>
                    <MenuBackdrop onClose={() => setMatchDropdownOpen(false)} />
                    <div className={styles.selectDropdown}>
                      {effectiveMatchResults.map((c) => (
                        <div
                          key={c.id}
                          className={styles.selectOption}
                          onClick={() => {
                            setSelectedCustomerId(c.id);
                            setMatchSearch(c.name);
                            setMatchDropdownOpen(false);
                          }}
                        >
                          {c.name}
                          {c.phone ? ` — ${c.phone}` : ''}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            {!selectedCustomerId && (
              <>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>{STRINGS.ui.name} *</label>
                  <input
                    className={styles.formInput}
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    disabled={saving}
                    data-testid="extract-customer-name"
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>{STRINGS.ui.street}</label>
                  <input
                    className={styles.formInput}
                    value={street}
                    onChange={(e) => setStreet(e.target.value)}
                    disabled={saving}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>{STRINGS.ui.zip}</label>
                  <input
                    className={styles.formInput}
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                    disabled={saving}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>{STRINGS.ui.city}</label>
                  <input
                    className={styles.formInput}
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    disabled={saving}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>{STRINGS.ui.phone}</label>
                  <input
                    className={styles.formInput}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    disabled={saving}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>{STRINGS.ui.email}</label>
                  <input
                    className={styles.formInput}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={saving}
                  />
                </div>
              </>
            )}

            {/* Project section */}
            <h3>{STRINGS.ui.projectData}</h3>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.number}</label>
              <input
                className={styles.formInput}
                value={projectNumber}
                onChange={(e) => setProjectNumber(e.target.value)}
                placeholder={generateProjectNumber()}
                disabled={saving}
                data-testid="extract-project-number"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.title}</label>
              <input
                className={styles.formInput}
                value={projectTitle}
                onChange={(e) => setProjectTitle(e.target.value)}
                disabled={saving}
                data-testid="extract-project-title"
              />
            </div>

            <SiteAddressGroup
              initial={extractedSiteAddress}
              customerAddress={customerAddressPreview}
              disabled={saving}
              handleRef={siteAddressRef}
            />
            {siteAddressError && (
              <div
                className={styles.fieldHintError}
                data-testid="extract-project-site-address-error"
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
                onClick={safeClose}
                disabled={saving}
              >
                {STRINGS.ui.cancel}
              </button>
              <button
                type="submit"
                className={styles.submitButton}
                disabled={saving || (!selectedCustomerId && !customerName.trim())}
                data-testid="extract-save"
              >
                {STRINGS.ui.save}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function generateProjectNumber(): string {
  const year = new Date().getFullYear();
  const rand = String(Math.floor(Math.random() * 900) + 100);
  return `${year}-${rand}`;
}
