/**
 * Edit form for an existing customer. Owns its own field state,
 * initialized from the passed-in customer.
 */

import { useCallback, useState } from 'react';
import { useCustomerStore } from '@/state/customerStore';
import { usePermission } from '@/hooks/usePermission';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { STRINGS } from '@/config/strings';
import type { Customer, CustomerSummary } from '@/domain/types';
import { readAddressDraft } from '@/domain/address';
import { CustomerFields } from './CustomerCreateForm';
import styles from './Management.module.css';

interface Props {
  // Accept the narrower CustomerSummary so the project detail page can
  // pass its embedded `project.customer` directly. The summary must carry
  // every field the form edits: a save sends them all, so a missing one
  // would be wiped. A full Customer still satisfies this type (superset).
  customer: Customer | CustomerSummary;
  onClose: () => void;
  /** Optional hook fired after a successful save, before close. */
  onSaved?: () => void;
  /** Optional hook fired after a stale write reset the form to the refetched customer. */
  onConflict?: () => void;
}

export function CustomerEditForm({ customer, onClose, onSaved, onConflict }: Props) {
  const updateCustomer = useCustomerStore((s) => s.updateCustomer);
  const error = useCustomerStore((s) => s.error);
  const canWrite = usePermission('customer:write');

  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone ?? '');
  const [email, setEmail] = useState(customer.email ?? '');
  const [street, setStreet] = useState(customer.address?.street ?? '');
  const [zip, setZip] = useState(customer.address?.zip ?? '');
  const [city, setCity] = useState(customer.address?.city ?? '');
  const [ustId, setUstId] = useState(customer.ustId ?? '');
  const [notes, setNotes] = useState(customer.notes ?? '');
  const [addressError, setAddressError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The version the form opened at — the edit's start version
  // (behavior.md §9.5); replaced only by the refetch after a stale write.
  const [startVersion, setStartVersion] = useState(customer.version);

  const resetTo = (fresh: Customer) => {
    setName(fresh.name);
    setPhone(fresh.phone ?? '');
    setEmail(fresh.email ?? '');
    setStreet(fresh.address?.street ?? '');
    setZip(fresh.address?.zip ?? '');
    setCity(fresh.address?.city ?? '');
    setUstId(fresh.ustId ?? '');
    setNotes(fresh.notes ?? '');
    setStartVersion(fresh.version);
  };

  const handleUpdate = async () => {
    if (submitting || !name.trim()) return;

    const addressDraft = readAddressDraft(street, zip, city);
    if (addressDraft.kind === 'partial') {
      setAddressError(STRINGS.customers.addressPartial);
      return;
    }
    setAddressError(null);
    setSubmitting(true);

    const outcome = await updateCustomer(customer.id, startVersion, {
      name: name.trim(),
      phone: phone.trim() || null,
      email: email.trim() || null,
      address: addressDraft.value,
      ustId: ustId.trim() || null,
      notes: notes.trim() || null,
    });

    setSubmitting(false);
    if (outcome.status === 'ok') {
      onSaved?.();
      onClose();
    } else if (outcome.status === 'conflict') {
      resetTo(outcome.customer);
      onConflict?.();
    }
  };

  const close = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  useEscapeKey(close);

  const disabled = !canWrite || submitting;

  return (
    <div className={styles.formOverlay}>
      <form
        className={styles.formPanel}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canWrite) return;
          void handleUpdate();
        }}
      >
        <h2 className={styles.formTitle}>
          {STRINGS.entities.customer} {canWrite ? STRINGS.ui.edit : STRINGS.ui.viewDetails}
        </h2>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.name} *</label>
          <input
            className={styles.formInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled}
            data-testid="customer-name-input"
            autoFocus
          />
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
          disabled={disabled}
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
          {canWrite && (
            <button
              type="submit"
              className={styles.submitButton}
              disabled={submitting || !name.trim()}
              data-testid="customer-save"
            >
              {STRINGS.ui.save}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
