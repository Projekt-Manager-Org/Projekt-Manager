/**
 * What an `Ausstellen` / `Verwerfen` confirmation acts on (ui/project-detail.md
 * §8.15.11, AC-382): the draft as the dialog opened — recipient, lines,
 * `taxMode`, `performanceDate`, totals. Rendered from the snapshot the
 * dialog sends the version of, never from the live row: a background
 * refresh behind the dialog must not change what the user confirms.
 */

import { STRINGS } from '@/config/strings';
import { labelForTaxMode, type Invoice } from '@/domain/invoice';
import { formatCurrencyDE, formatDateDE } from '@/domain/dateFormat';
import styles from './InvoiceDraftPreview.module.css';

export function InvoiceDraftPreview({ invoice }: { invoice: Invoice }) {
  const { recipient, totals } = invoice;
  return (
    <div className={styles.preview} data-testid="invoice-draft-preview">
      <dl className={styles.meta}>
        <dt>{STRINGS.invoices.detailHeadingRecipient}</dt>
        <dd>
          {recipient.name || '—'}
          {recipient.address && (
            <>
              <br />
              {recipient.address.street}, {recipient.address.zip} {recipient.address.city}
            </>
          )}
        </dd>
        <dt>{STRINGS.invoices.detailLabelPerformanceDate}</dt>
        <dd>{invoice.performanceDate ? formatDateDE(invoice.performanceDate) : '—'}</dd>
        <dt>{STRINGS.invoices.detailLabelTaxMode}</dt>
        <dd>
          {labelForTaxMode(invoice.taxMode, {
            standard: STRINGS.companyProfile.taxModeStandard,
            reverseCharge: STRINGS.companyProfile.taxModeReverseCharge,
          })}
        </dd>
      </dl>
      <ul className={styles.lines} aria-label={STRINGS.invoices.detailHeadingLines}>
        {invoice.lines.map((line, i) => (
          <li key={i}>
            <span>
              {line.quantity} {line.unit} {line.description}
            </span>
            <span>{formatCurrencyDE(line.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <dl className={styles.totals}>
        <div className={styles.totalsRow}>
          <dt>{STRINGS.invoices.totalsNet}</dt>
          <dd>{formatCurrencyDE(totals.netGrandTotal)}</dd>
        </div>
        {totals.perRate.map((r) => (
          <div key={r.taxRate} className={styles.totalsRow}>
            <dt>{STRINGS.invoices.totalsTaxAt(r.taxRate)}</dt>
            <dd>{formatCurrencyDE(r.taxAmount)}</dd>
          </div>
        ))}
        <div className={styles.totalsRow}>
          <dt>{STRINGS.invoices.totalsGross}</dt>
          <dd>{formatCurrencyDE(totals.grossGrandTotal)}</dd>
        </div>
      </dl>
    </div>
  );
}
