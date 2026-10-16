/**
 * Inline invoice-draft form (ui/invoices.md §8.16.2).
 *
 * Argumented C-SIZE exception (review/conventions-code.md §C-SIZE,
 * 200 LOC guideline): this file is ~540 LOC. It owns one cohesive
 * editing surface — recipient block, line-items table, tax mode,
 * performance date, totals preview, client-side validation, and
 * modal-dialog plumbing — all riding through a single PATCH per save.
 * Extracting `InvoiceLinesTable` is the obvious refinement and is
 * tracked separately; the rest of the form is one round-trip and one
 * state owner, so further splitting would split responsibility.
 *
 * Mounted from `InvoiceSection` when the user clicks `+ Neue Rechnung` on
 * a project in `rechnung_faellig`. The form drives a two-call sequence:
 * first `createDraft` to mint the row server-side (which pre-fills the
 * `recipient` snapshot from the project's customer), then `updateDraft`
 * on every save while the form is open. The split keeps the recipient
 * snapshot under server control — the client never has to copy the
 * customer fields out of `project.customer` and risk a stale read.
 *
 * Editing an existing draft: the form mounts with that draft's id and
 * skips the create step.
 *
 * Line totals are computed client-side as a UX preview only; the server
 * re-derives `lineTotal` + the totals block on every PATCH and POST
 * /issue (AC-286).
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import {
  TAX_MODES,
  computeInvoiceTotals,
  labelForTaxMode,
  round2,
  type Invoice,
  type InvoiceLine,
  type InvoiceRecipientSnapshot,
  type TaxMode,
} from '@/domain/invoice';
import { formatCurrencyDE } from '@/domain/dateFormat';
import { useDialogA11y } from '@/ui/common/useDialogA11y';
import { useInvoiceStore } from '@/state/invoiceStore';
import { dateInputValue } from '../dateInputValue';
import styles from './InvoiceSection.module.css';

const TITLE_ID = 'invoice-draft-form-title';

/**
 * Default VAT percentage pre-filled on every new line. 19 % is the
 * German standard rate (UStG §12 (1)); 7 % (reduced) and 0 %
 * (e.g. Kleinunternehmer §19) are also accepted by the input — the
 * server validates the actual rate against the tax mode at issue time.
 */
const DEFAULT_TAX_RATE_PERCENT = '19';

interface Props {
  projectId: string;
  /**
   * Existing draft to edit. `null` means we are creating a fresh draft —
   * on first save the store dispatches `createDraft` to mint it server-
   * side; the response carries the server-allocated id which subsequent
   * saves use to PATCH.
   */
  draft: Invoice | null;
  /** Project planned-end ISO date — pre-fills the performance date input. */
  defaultPerformanceDate: string | null;
  /** Customer snapshot for the recipient block when no draft is loaded yet. */
  fallbackRecipient: { name: string; street: string; zip: string; city: string };
  onClose: () => void;
}

interface LineDraft {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxRate: string;
}

interface RecipientDraft {
  name: string;
  street: string;
  zip: string;
  city: string;
  /**
   * Carried through the round-trip but not yet editable in the form —
   * the per-recipient `USt-IdNr.` input is a future spec amendment. The
   * draft create endpoint pre-fills this from the customer snapshot;
   * preserving it on PATCH keeps any pre-existing value intact instead
   * of wiping it on every save (F1).
   */
  ustId: string | null;
}

function emptyLine(): LineDraft {
  return {
    description: '',
    quantity: '1',
    unit: '',
    unitPrice: '',
    taxRate: DEFAULT_TAX_RATE_PERCENT,
  };
}

function linesFromInvoice(inv: Invoice): LineDraft[] {
  if (inv.lines.length === 0) return [emptyLine()];
  return inv.lines.map((l) => ({
    description: l.description,
    quantity: String(l.quantity),
    unit: l.unit,
    unitPrice: String(l.unitPrice),
    taxRate: String(l.taxRate),
  }));
}

function recipientFromInvoice(inv: Invoice): RecipientDraft {
  return {
    name: inv.recipient.name,
    street: inv.recipient.address?.street ?? '',
    zip: inv.recipient.address?.zip ?? '',
    city: inv.recipient.address?.city ?? '',
    ustId: inv.recipient.ustId ?? null,
  };
}

function parseNumber(value: string): number {
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function toWireLines(lines: LineDraft[]): InvoiceLine[] {
  return lines
    .filter((l) => l.description.trim().length > 0 || parseNumber(l.unitPrice) !== 0)
    .map((l) => {
      const quantity = parseNumber(l.quantity);
      const unitPrice = parseNumber(l.unitPrice);
      const taxRate = parseNumber(l.taxRate);
      return {
        description: l.description.trim(),
        quantity,
        unit: l.unit.trim(),
        unitPrice,
        lineTotal: round2(quantity * unitPrice),
        taxRate,
      };
    });
}

function toWireRecipient(r: RecipientDraft): InvoiceRecipientSnapshot {
  const street = r.street.trim();
  const zip = r.zip.trim();
  const city = r.city.trim();
  const hasAddress = street.length > 0 || zip.length > 0 || city.length > 0;
  return {
    name: r.name.trim(),
    address: hasAddress ? { street, zip, city } : null,
    ustId: r.ustId,
  };
}

export function InvoiceDraftForm({
  projectId,
  draft,
  defaultPerformanceDate,
  fallbackRecipient,
  onClose,
}: Props) {
  const createDraft = useInvoiceStore((s) => s.createDraft);
  const updateDraft = useInvoiceStore((s) => s.updateDraft);

  const [recipient, setRecipient] = useState<RecipientDraft>(
    // The fallback path has no carried `ustId` to preserve (no draft has
    // been minted yet); the server's recipient pre-fill on createDraft
    // populates it from the customer snapshot on the round-trip back.
    draft ? recipientFromInvoice(draft) : { ...fallbackRecipient, ustId: null },
  );
  const [lines, setLines] = useState<LineDraft[]>(draft ? linesFromInvoice(draft) : [emptyLine()]);
  const [taxMode, setTaxMode] = useState<TaxMode>(draft?.taxMode ?? 'standard');
  const [performanceDate, setPerformanceDate] = useState<string>(
    dateInputValue(draft?.performanceDate ?? defaultPerformanceDate),
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Track the server-assigned id so consecutive saves PATCH the same row
  // rather than POSTing a fresh one. `useRef` (not `useState`) because the
  // value is read inside `handleSave` and we don't need a re-render on
  // update; a setState here would have to be flushed before the next
  // `handleSave` call could see it.
  const draftIdRef = useRef<string | null>(draft?.id ?? null);
  // The draft version the form opened with — the edit's start version
  // (behavior.md §9.5). A background refresh of the row never moves it;
  // only the refetch after a stale write does.
  const startVersionRef = useRef<number | null>(draft?.version ?? null);

  // Modal accessibility: focus trap, body scroll lock, Escape-to-close.
  // Same hook the cancel dialog uses so the two surfaces match. Escape
  // is suppressed while a save is in flight — the in-flight lock from
  // [behavior.md §9.5] also applies to the close affordance.
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const onEscape = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);
  const onOpenedFocus = useCallback(() => firstFieldRef.current?.focus(), []);
  useDialogA11y({ isOpen: true, dialogRef, onOpenedFocus, onEscape });

  // Read-only totals preview (ui/invoices.md §8.16.2 — "the visible
  // totals are a UX preview"). The server re-derives over the wire-shape
  // lines at issue time and remains authoritative.
  const previewTotals = useMemo(
    () => computeInvoiceTotals(toWireLines(lines), taxMode),
    [lines, taxMode],
  );

  const handleSave = async () => {
    if (submitting) return;
    setErrorMessage(null);

    const wireLines = toWireLines(lines);
    const wireRecipient = toWireRecipient(recipient);
    const wirePerformanceDate = performanceDate ? performanceDate : null;

    // Client-side aggregate validation: block the submit if no line
    // carries both a description and a non-zero unit price. Without
    // this short-circuit the server returns 422 with the same intent
    // but no actionable field hints; the inline German message is the
    // affordance the user can act on. The server remains authoritative
    // on field-level validation (AC-303).
    const hasUsableLine = wireLines.some((l) => l.description.length > 0 && l.unitPrice !== 0);
    if (!hasUsableLine) {
      setErrorMessage(STRINGS.invoices.formEmptyLinesError);
      return;
    }

    setSubmitting(true);

    const currentDraftId = draftIdRef.current;
    const startVersion = startVersionRef.current;
    const outcome =
      currentDraftId && startVersion !== null
        ? await updateDraft(currentDraftId, projectId, startVersion, {
            lines: wireLines,
            recipient: wireRecipient,
            taxMode,
            performanceDate: wirePerformanceDate,
          })
        : await createDraft(projectId, {
            lines: wireLines,
            recipient: wireRecipient,
            taxMode,
            performanceDate: wirePerformanceDate,
          });

    setSubmitting(false);

    if (outcome.status === 'ok') {
      // Capture the server-assigned id so if the user somehow re-opens
      // the same form instance the next save PATCHes; in the current UI
      // the form closes immediately on success, but the ref hand-off
      // is correct either way.
      if (outcome.invoice) {
        draftIdRef.current = outcome.invoice.id;
        startVersionRef.current = outcome.invoice.version;
      }
      onClose();
      return;
    }
    if (outcome.status === 'conflict' && outcome.invoice) {
      // Show the refetched draft; the user redoes the edit from there.
      const fresh = outcome.invoice;
      setRecipient(recipientFromInvoice(fresh));
      setLines(linesFromInvoice(fresh));
      setTaxMode(fresh.taxMode);
      setPerformanceDate(dateInputValue(fresh.performanceDate ?? defaultPerformanceDate));
      startVersionRef.current = fresh.version;
    }
    setErrorMessage(outcome.errorMessage);
  };

  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
  const removeLine = (idx: number) =>
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((_, i) => i !== idx)));
  const updateLine = (idx: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  return (
    <div className={styles.formOverlay} data-testid="invoice-form-overlay">
      <div
        ref={dialogRef}
        className={styles.formPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
      >
        <form
          data-testid="invoice-form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <h2 id={TITLE_ID} className={styles.formTitle}>
            {draft ? STRINGS.invoices.editDraftTitle : STRINGS.invoices.newInvoice}
          </h2>

          <section className={styles.formSection}>
            <h3 className={styles.formSectionHeading}>{STRINGS.invoices.formRecipientHeading}</h3>
            <p className={styles.formHint}>{STRINGS.invoices.formRecipientFrozenHint}</p>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label className={styles.formLabel} htmlFor="invoice-recipient-name">
                  {STRINGS.invoices.formRecipientName}
                </label>
                <input
                  ref={firstFieldRef}
                  id="invoice-recipient-name"
                  className={styles.formInput}
                  value={recipient.name}
                  onChange={(e) => setRecipient((r) => ({ ...r, name: e.target.value }))}
                  disabled={submitting}
                  data-testid="invoice-recipient-name-input"
                />
              </div>
              <div className={styles.formField}>
                <label className={styles.formLabel} htmlFor="invoice-recipient-street">
                  {STRINGS.invoices.formRecipientStreet}
                </label>
                <input
                  id="invoice-recipient-street"
                  className={styles.formInput}
                  value={recipient.street}
                  onChange={(e) => setRecipient((r) => ({ ...r, street: e.target.value }))}
                  disabled={submitting}
                />
              </div>
              <div className={styles.formField}>
                <label className={styles.formLabel} htmlFor="invoice-recipient-zip">
                  {STRINGS.invoices.formRecipientZip}
                </label>
                <input
                  id="invoice-recipient-zip"
                  className={styles.formInput}
                  value={recipient.zip}
                  onChange={(e) => setRecipient((r) => ({ ...r, zip: e.target.value }))}
                  disabled={submitting}
                />
              </div>
              <div className={styles.formField}>
                <label className={styles.formLabel} htmlFor="invoice-recipient-city">
                  {STRINGS.invoices.formRecipientCity}
                </label>
                <input
                  id="invoice-recipient-city"
                  className={styles.formInput}
                  value={recipient.city}
                  onChange={(e) => setRecipient((r) => ({ ...r, city: e.target.value }))}
                  disabled={submitting}
                />
              </div>
            </div>
          </section>

          <section className={styles.formSection}>
            <h3 className={styles.formSectionHeading}>{STRINGS.invoices.formLinesHeading}</h3>
            <div className={styles.lineTableScroll}>
              <table className={styles.lineTable}>
                <thead>
                  <tr>
                    <th>{STRINGS.invoices.formLineDescription}</th>
                    <th>{STRINGS.invoices.formLineQuantity}</th>
                    <th>{STRINGS.invoices.formLineUnit}</th>
                    <th>{STRINGS.invoices.formLineUnitPrice}</th>
                    <th>{STRINGS.invoices.formLineTaxRate}</th>
                    <th className={styles.lineActions} aria-hidden="true"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => {
                    // Row 0 carries the un-suffixed testids the E2E pins
                    // (`invoice-line-description-input`, etc.); subsequent
                    // rows carry the `-${idx}` suffix.
                    const suffix = idx === 0 ? '' : `-${idx}`;
                    return (
                      <tr key={idx}>
                        <td>
                          <input
                            className={styles.formInput}
                            value={line.description}
                            onChange={(e) => updateLine(idx, { description: e.target.value })}
                            disabled={submitting}
                            data-testid={`invoice-line-description-input${suffix}`}
                          />
                        </td>
                        <td>
                          <input
                            className={styles.formInput}
                            value={line.quantity}
                            onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                            disabled={submitting}
                            inputMode="decimal"
                            data-testid={`invoice-line-quantity-input${suffix}`}
                          />
                        </td>
                        <td>
                          <input
                            className={styles.formInput}
                            value={line.unit}
                            onChange={(e) => updateLine(idx, { unit: e.target.value })}
                            disabled={submitting}
                            data-testid={`invoice-line-unit-input${suffix}`}
                          />
                        </td>
                        <td>
                          <input
                            className={styles.formInput}
                            value={line.unitPrice}
                            onChange={(e) => updateLine(idx, { unitPrice: e.target.value })}
                            disabled={submitting}
                            inputMode="decimal"
                            data-testid={`invoice-line-unit-price-input${suffix}`}
                          />
                        </td>
                        <td>
                          <input
                            className={styles.formInput}
                            value={line.taxRate}
                            onChange={(e) => updateLine(idx, { taxRate: e.target.value })}
                            disabled={submitting}
                            inputMode="decimal"
                            data-testid={`invoice-line-tax-rate-input${suffix}`}
                          />
                        </td>
                        <td className={styles.lineActions}>
                          <button
                            type="button"
                            className={styles.lineRemoveButton}
                            onClick={() => removeLine(idx)}
                            disabled={submitting || lines.length === 1}
                            aria-label={STRINGS.invoices.formRemoveLine}
                            title={STRINGS.invoices.formRemoveLine}
                          >
                            {'×'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className={styles.addLineButton}
              onClick={addLine}
              disabled={submitting}
            >
              {STRINGS.invoices.formAddLine}
            </button>
          </section>

          <div className={styles.formGrid}>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor="invoice-tax-mode">
                {STRINGS.invoices.formTaxMode}
              </label>
              <select
                id="invoice-tax-mode"
                className={styles.formSelect}
                value={taxMode}
                onChange={(e) => setTaxMode(e.target.value as TaxMode)}
                disabled={submitting}
                data-testid="invoice-tax-mode-select"
              >
                {TAX_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {labelForTaxMode(mode, {
                      standard: STRINGS.companyProfile.taxModeStandard,
                      kleinunternehmer: STRINGS.companyProfile.taxModeKleinunternehmer,
                      reverseCharge: STRINGS.companyProfile.taxModeReverseCharge,
                    })}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor="invoice-performance-date">
                {STRINGS.invoices.formPerformanceDate}
              </label>
              <input
                id="invoice-performance-date"
                type="date"
                className={styles.formInput}
                value={performanceDate}
                onChange={(e) => setPerformanceDate(e.target.value)}
                disabled={submitting}
                data-testid="invoice-performance-date-input"
              />
            </div>
          </div>

          <section
            className={styles.totalsBlock}
            aria-labelledby="invoice-totals-heading"
            data-testid="invoice-totals-preview"
          >
            <h3 id="invoice-totals-heading" className={styles.formSectionHeading}>
              {STRINGS.invoices.totalsHeading}
            </h3>
            <dl className={styles.totalsList}>
              <div className={styles.totalsRow}>
                <dt>{STRINGS.invoices.totalsNet}</dt>
                <dd data-testid="invoice-totals-net">
                  {formatCurrencyDE(previewTotals.netGrandTotal)}
                </dd>
              </div>
              {previewTotals.perRate.map((band) => (
                <div className={styles.totalsRow} key={band.taxRate}>
                  <dt>{STRINGS.invoices.totalsTaxAt(band.taxRate)}</dt>
                  <dd data-testid={`invoice-totals-tax-${band.taxRate}`}>
                    {formatCurrencyDE(band.taxAmount)}
                  </dd>
                </div>
              ))}
              <div className={`${styles.totalsRow} ${styles.totalsGrossRow}`}>
                <dt>{STRINGS.invoices.totalsGross}</dt>
                <dd data-testid="invoice-totals-gross">
                  {formatCurrencyDE(previewTotals.grossGrandTotal)}
                </dd>
              </div>
            </dl>
          </section>

          {errorMessage && (
            <div className={styles.errorBanner} role="alert" data-testid="invoice-form-error">
              {errorMessage}
            </div>
          )}

          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onClose}
              disabled={submitting}
            >
              {STRINGS.ui.cancel}
            </button>
            <button
              type="submit"
              className={styles.primaryButton}
              disabled={submitting}
              data-testid="invoice-form-save"
            >
              {STRINGS.invoices.saveAction}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
