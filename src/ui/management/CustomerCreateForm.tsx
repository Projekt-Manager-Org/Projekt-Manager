/**
 * Create form for a new customer. Owns its own field state plus the
 * duplicate-name autocomplete and idempotent-UUID machinery.
 *
 * On exact-name match, soft-confirms before submit — legitimate
 * duplicates are allowed, but the user must opt in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomerStore } from '@/state/customerStore';
import { useConfirmStore } from '@/state/confirmStore';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { STRINGS } from '@/config/strings';
import type { Customer } from '@/domain/types';
import { normalizeName } from '@/domain/nameNormalize';
import { readAddressDraft } from '@/domain/address';
import { MenuBackdrop } from '../common/MenuBackdrop';
import styles from './Management.module.css';

const AUTOCOMPLETE_DEBOUNCE_MS = 300;

interface Props {
  onClose: () => void;
  onSelectExisting: (customer: Customer) => void;
}

export function CustomerCreateForm({ onClose, onSelectExisting }: Props) {
  const searchCustomers = useCustomerStore((s) => s.searchCustomers);
  const createCustomer = useCustomerStore((s) => s.createCustomer);
  const error = useCustomerStore((s) => s.error);
  const requestConfirm = useConfirmStore((s) => s.request);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [street, setStreet] = useState('');
  const [zip, setZip] = useState('');
  const [city, setCity] = useState('');
  const [ustId, setUstId] = useState('');
  const [notes, setNotes] = useState('');
  const [addressError, setAddressError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Client-supplied UUID for idempotent create. Stable across re-renders
  // so a retry after a transient failure replays rather than duplicating.
  const createIdRef = useRef<string>(crypto.randomUUID());

  const [matches, setMatches] = useState<Customer[]>([]);
  const [matchDropdownOpen, setMatchDropdownOpen] = useState(false);
  // Monotonic request id — a slow fetch must not commit its results if
  // the user has since typed and kicked off a newer fetch.
  const searchRequestIdRef = useRef(0);

  // Debounced duplicate-name search. Empty name is handled via derivation
  // (effectiveMatches below) — setting state synchronously inside this
  // effect body is what React 19's set-state-in-effect rule rejects.
  useEffect(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const timer = setTimeout(async () => {
      const myReq = ++searchRequestIdRef.current;
      const results = await searchCustomers(trimmed);
      if (myReq !== searchRequestIdRef.current) return;
      setMatches(results);
      if (results.length > 0) setMatchDropdownOpen(true);
    }, AUTOCOMPLETE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [name, searchCustomers]);

  // Suppress stale matches and dropdown when the name field is empty —
  // derivation instead of resetting state synchronously in an effect.
  const exactMatch = useMemo(() => {
    const key = normalizeName(name);
    if (!key) return null;
    return matches.find((c) => normalizeName(c.name) === key) ?? null;
  }, [matches, name]);
  const effectiveMatches = name.trim() ? matches : [];
  const effectiveDropdownOpen = matchDropdownOpen && effectiveMatches.length > 0;

  const handleCreate = async () => {
    if (submitting || !name.trim()) return;

    const addressDraft = readAddressDraft(street, zip, city);
    if (addressDraft.kind === 'partial') {
      setAddressError(STRINGS.customers.addressPartial);
      return;
    }
    setAddressError(null);

    // Set submitting BEFORE any await so a second click cannot slip past
    // the guard. `useConfirmStore.request` does not block pointer events
    // on the underlying form and its preemption semantic silently
    // cancels the first request if a second one opens — the combination
    // would discard the user's first submit with no feedback.
    setSubmitting(true);

    // Soft-confirm on an exact case-insensitive duplicate — legitimate
    // duplicates are allowed but the user must opt in.
    if (exactMatch) {
      const proceed = await requestConfirm(STRINGS.customers.duplicateNameConfirm(name.trim()), {
        confirmLabel: STRINGS.ui.createAnyway,
      });
      if (!proceed) {
        setSubmitting(false);
        return;
      }
    }

    const outcome = await createCustomer({
      id: createIdRef.current,
      name: name.trim(),
      phone: phone.trim() || null,
      email: email.trim() || null,
      address: addressDraft.value,
      ustId: ustId.trim() || null,
      notes: notes.trim() || null,
    });

    setSubmitting(false);

    if (outcome.status === 'ok' || outcome.status === 'conflict') {
      // Conflict path: the backing row already exists with different data.
      // The form instance is unrecoverable — close it. The store has
      // already refreshed the list and set its error message.
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
          {STRINGS.entities.customer} {STRINGS.ui.create}
        </h2>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.name} *</label>
          <div className={styles.selectWrapper}>
            <input
              className={styles.formInput}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setMatchDropdownOpen(true);
              }}
              onFocus={() => {
                if (effectiveMatches.length > 0) setMatchDropdownOpen(true);
              }}
              onBlur={() => {
                // Tab-away path: closes the dropdown when keyboard focus
                // leaves the input. Mouse outside-click is handled by
                // MenuBackdrop instead. The 150 ms delay allows a click
                // on an option (which prevent-defaults its mousedown to
                // suppress this blur) to commit even if the order of
                // events flips on some browsers.
                window.setTimeout(() => setMatchDropdownOpen(false), 150);
              }}
              disabled={submitting}
              data-testid="customer-name-input"
              autoFocus
              autoComplete="off"
            />
            {effectiveDropdownOpen && (
              <>
                <MenuBackdrop onClose={() => setMatchDropdownOpen(false)} />
                <div className={styles.selectDropdown} data-testid="customer-match-dropdown">
                  {effectiveMatches.map((c) => (
                    <div
                      key={c.id}
                      className={styles.selectOption}
                      onMouseDown={(e) => {
                        // Prevent the input's blur from firing before click.
                        e.preventDefault();
                      }}
                      onClick={() => onSelectExisting(c)}
                      data-testid={`customer-match-${c.id}`}
                    >
                      {c.name}
                      {c.phone ? (
                        <span className={styles.selectOptionSecondary}> — {c.phone}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <CustomerFields
          street={street}
          setStreet={setStreet}
          zip={zip}
          setZip={setZip}
          city={city}
          setCity={setCity}
          phone={phone}
          setPhone={setPhone}
          email={email}
          setEmail={setEmail}
          ustId={ustId}
          setUstId={setUstId}
          notes={notes}
          setNotes={setNotes}
          addressError={addressError}
          disabled={submitting}
        />

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
            disabled={submitting || !name.trim()}
            data-testid="customer-submit"
          >
            {STRINGS.ui.create}
          </button>
        </div>
      </form>
    </div>
  );
}

interface CustomerFieldsProps {
  street: string;
  setStreet: (v: string) => void;
  zip: string;
  setZip: (v: string) => void;
  city: string;
  setCity: (v: string) => void;
  phone: string;
  setPhone: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  ustId: string;
  setUstId: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  addressError: string | null;
  disabled: boolean;
}

export function CustomerFields(props: CustomerFieldsProps) {
  return (
    <>
      <div className={styles.formGroup}>
        <label className={styles.formLabel}>{STRINGS.ui.street}</label>
        <input
          className={styles.formInput}
          value={props.street}
          onChange={(e) => props.setStreet(e.target.value)}
          disabled={props.disabled}
          data-testid="customer-street-input"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>{STRINGS.ui.zip}</label>
        <input
          className={styles.formInput}
          value={props.zip}
          onChange={(e) => props.setZip(e.target.value)}
          disabled={props.disabled}
          data-testid="customer-zip-input"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>{STRINGS.ui.city}</label>
        <input
          className={styles.formInput}
          value={props.city}
          onChange={(e) => props.setCity(e.target.value)}
          disabled={props.disabled}
          data-testid="customer-city-input"
        />
      </div>

      {props.addressError && (
        <div className={styles.fieldHintError} data-testid="customer-address-error" role="status">
          {props.addressError}
        </div>
      )}

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>{STRINGS.ui.phone}</label>
        <input
          className={styles.formInput}
          value={props.phone}
          onChange={(e) => props.setPhone(e.target.value)}
          disabled={props.disabled}
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>{STRINGS.ui.email}</label>
        <input
          className={styles.formInput}
          value={props.email}
          onChange={(e) => props.setEmail(e.target.value)}
          disabled={props.disabled}
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>{STRINGS.companyProfile.ustId}</label>
        <input
          className={styles.formInput}
          value={props.ustId}
          onChange={(e) => props.setUstId(e.target.value)}
          disabled={props.disabled}
          data-testid="customer-ustid-input"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>{STRINGS.ui.notes}</label>
        <textarea
          className={styles.formTextarea}
          value={props.notes}
          onChange={(e) => props.setNotes(e.target.value)}
          disabled={props.disabled}
          data-testid="customer-notes-input"
        />
      </div>
    </>
  );
}
