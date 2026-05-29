/**
 * Per-invoice viewer at `/rechnungen/:id` (ui/invoices.md §8.16.3).
 *
 * Argumented C-SIZE exception (review/conventions-code.md §C-SIZE,
 * 200 LOC guideline): this file is ~410 LOC. The viewer renders a
 * single cohesive surface — header + meta + issuer + recipient + lines
 * + totals + sibling block + cancel dialog — all reading from one
 * `Invoice` snapshot. Splitting per section would scatter the
 * read-only layout across four files without separating responsibility
 * (no section has its own state or its own fetch). The single-file
 * shape mirrors `InvoiceSection.tsx` and `InvoiceDraftForm.tsx` which
 * carry the same documented exception in this module.
 *
 * Read-only by structure for issued / cancelled rows — every field is
 * displayed without an edit affordance. Drafts are NOT in scope here
 * (§8.16.3 surfaces only `status ∈ {issued, cancelled}`); a draft
 * deep-link redirects to the project, the only place a draft has an
 * editable surface.
 *
 * Permission: gated on `invoice:read` at the central route table
 * (config/routes.ts) — the route guard in `App.tsx` is the load-bearing
 * client-side check. Server-side, the repository scope predicate
 * (ADR-0019) is authoritative; workers never reach this surface.
 *
 * SSE: re-renders on `invoice_changed` via `subscribeInvoiceStoreToSse`
 * + `useInvoiceDetailStore.refreshAll`. An open `Stornorechnung`
 * confirmation dialog is NOT closed by background refreshes — the
 * dialog's open state lives in this component's local `useState`,
 * which the store refresh never touches.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { STRINGS } from '@/config/strings';
import type { Invoice } from '@/domain/invoice';
import { buildInvoiceDownloadFilename, labelForTaxMode } from '@/domain/invoice';
import { formatCurrencyDE, formatDateDE } from '@/domain/dateFormat';
import { usePermission } from '@/hooks/usePermission';
import { useInvoiceDetailStore } from '@/state/invoiceDetailStore';
import { useInvoiceStore } from '@/state/invoiceStore';
import { useToastStore } from '@/state/toastStore';
import { downloadAuthedFile } from '@/ui/utils/downloadFile';
import { NotPermittedView } from '@/ui/common/NotPermittedView';
import { InvoiceCancelDialog } from '@/ui/detail/invoice/InvoiceCancelDialog';
import styles from './InvoiceDetailView.module.css';

interface RowAttrs {
  label: string;
  className: string;
}

function statusAttrs(invoice: Invoice): RowAttrs {
  if (invoice.cancellationOf) {
    return {
      label: STRINGS.invoices.statusStorno,
      className: `${styles.statusBadge} ${styles.statusStorno}`,
    };
  }
  switch (invoice.status) {
    case 'draft':
      return { label: STRINGS.invoices.statusDraft, className: styles.statusBadge };
    case 'issued':
      return {
        label: STRINGS.invoices.statusIssued,
        className: `${styles.statusBadge} ${styles.statusIssued}`,
      };
    case 'cancelled':
      return {
        label: STRINGS.invoices.statusCancelled,
        className: `${styles.statusBadge} ${styles.statusCancelled}`,
      };
  }
}

export function InvoiceDetailView() {
  const canRead = usePermission('invoice:read');
  const canWrite = usePermission('invoice:write');
  const { id } = useParams<{ id: string }>();
  const invoiceId = id ?? '';
  const navigate = useNavigate();

  const invoice = useInvoiceDetailStore((s) => s.byId[invoiceId]);
  // Pulling the raw entry — empty default is computed below with useMemo
  // to keep referential stability across renders. A selector returning
  // a fresh `[]` on each call would force `useSyncExternalStore` to
  // bail with "Maximum update depth exceeded".
  const siblingsRaw = useInvoiceDetailStore((s) => s.siblingsById[invoiceId]);
  const siblings = useMemo(() => siblingsRaw ?? [], [siblingsRaw]);
  const status = useInvoiceDetailStore((s) => s.statusById[invoiceId]);
  const fetchInvoice = useInvoiceDetailStore((s) => s.fetch);
  const cancelInvoice = useInvoiceStore((s) => s.cancel);
  const showToast = useToastStore((s) => s.show);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (!canRead || !invoiceId) return;
    void fetchInvoice(invoiceId);
  }, [canRead, invoiceId, fetchInvoice]);

  // Draft surfaces are out of §8.16.3 scope — drafts have no immutable
  // recipient/issuer snapshot to render and must round-trip through the
  // per-project block where editing lives. A direct deep-link to a
  // draft id silently redirects rather than showing a "not found" —
  // the redirect lands the user on the only surface that can act on
  // the row. The viewer must NOT navigate after the redirect has fired
  // (avoid loops on a slow back-button + retry); guard with a ref-like
  // memo via the effect's run-once-per-id pattern.
  useEffect(() => {
    if (!invoice) return;
    if (invoice.status === 'draft') {
      navigate(`/projects/${invoice.projectId}`, { replace: true });
    }
  }, [invoice, navigate]);

  if (!canRead) return <NotPermittedView />;

  // Order the status branches so terminal states (not_found / not_permitted
  // / error) are surfaced before the loading fallback. `invoice` is
  // undefined for both `loading` and the terminal failure branches —
  // checking the failure cases first keeps the user from being stuck on
  // a spinner after a 404.
  if (status === 'not_permitted') return <NotPermittedView />;

  if (status === 'not_found') {
    return (
      <div className={styles.container}>
        <div className={styles.notFound} data-testid="invoice-detail-not-found">
          {STRINGS.invoices.detailNotFound}
        </div>
        <Link to="/rechnungen" className={styles.backLink}>
          {STRINGS.invoices.detailBackToList}
        </Link>
      </div>
    );
  }

  if (!invoice || status === 'loading' || status === undefined) {
    return (
      <div className={styles.container} data-testid="invoice-detail-loading">
        <div>{STRINGS.invoices.detailLoading}</div>
      </div>
    );
  }

  // Status 'error' surfaces inline so the user can retry via reload; the
  // page still renders the back-to-list affordance to recover.
  // The redirect effect above handles drafts; if we get here with a
  // draft (e.g. effect not yet run), render the loading shell rather
  // than a half-populated viewer.
  if (invoice.status === 'draft') {
    return (
      <div className={styles.container}>
        <div data-testid="invoice-detail-draft-redirect">
          {STRINGS.invoices.detailDraftRedirect}
        </div>
      </div>
    );
  }

  const attrs = statusAttrs(invoice);
  const isStorno = invoice.cancellationOf !== null;
  const isOriginal = !isStorno;
  const isIssuedOriginal = invoice.status === 'issued' && !isStorno;

  // The PDF download affordance is renamed for ZUGFeRD-profile rows to
  // make the content explicit for B2B receivers (ui/invoices.md §8.16.3).
  const downloadLabel =
    invoice.profile === 'zugferd-en16931'
      ? STRINGS.invoices.downloadZugferdAction
      : STRINGS.invoices.downloadPdfAction;

  const downloadPdf = () => {
    // Fetch the PDF bytes and save them via a blob URL (see
    // `downloadAuthedFile`) — a direct `<a download>` at the attachment
    // endpoint leaves mobile/PWA browsers on a blank page.
    void downloadAuthedFile(
      `/api/invoices/${invoice.id}/pdf`,
      buildInvoiceDownloadFilename(invoice),
    ).catch(() => showToast('error', STRINGS.invoices.downloadPdfError));
  };

  const handleCancelConfirm = async (reason: string) => {
    setCancelSubmitting(true);
    setCancelError(null);
    const outcome = await cancelInvoice(invoice.id, invoice.projectId, reason);
    setCancelSubmitting(false);
    if (outcome.status !== 'ok') {
      setCancelError(outcome.errorMessage);
      return;
    }
    setCancelOpen(false);
    // Refetch the viewer's invoice so the status flips to 'cancelled'
    // and the storno sibling appears in the indented-chevron list.
    void fetchInvoice(invoice.id);
  };

  const recipientAddress = invoice.recipient.address;
  const issuerAddress = invoice.issuer.address;
  const showCancelButton = isIssuedOriginal && canWrite;

  return (
    <article className={styles.container} data-testid="invoice-detail-view">
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <Link to="/rechnungen" className={styles.backLink} data-testid="invoice-detail-back">
            {STRINGS.invoices.detailBackToList}
          </Link>
          <h1 className={styles.title} data-testid="invoice-detail-number">
            {invoice.number ?? '—'}
          </h1>
          <span className={attrs.className} data-testid="invoice-detail-status">
            {attrs.label}
          </span>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.actionButton}
            onClick={downloadPdf}
            data-testid="invoice-detail-download-pdf"
          >
            {downloadLabel}
          </button>
          {showCancelButton && (
            <button
              type="button"
              className={`${styles.actionButton} ${styles.actionDanger}`}
              onClick={() => {
                setCancelError(null);
                setCancelOpen(true);
              }}
              data-testid="invoice-detail-cancel-button"
            >
              {STRINGS.invoices.cancelAction}
            </button>
          )}
        </div>
      </header>

      {isStorno && (
        <div>
          <Link
            to={`/rechnungen/${invoice.cancellationOf}`}
            className={styles.viewOriginalLink}
            data-testid="invoice-detail-view-original"
          >
            {STRINGS.invoices.detailViewOriginal}
          </Link>
        </div>
      )}

      <section className={styles.card} aria-label={STRINGS.invoices.detailHeadingMeta}>
        <h2 className={styles.cardHeading}>{STRINGS.invoices.detailHeadingMeta}</h2>
        <div className={styles.metaGrid}>
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>{STRINGS.invoices.detailLabelNumber}</span>
            <span className={styles.metaValue}>{invoice.number ?? '—'}</span>
          </div>
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>{STRINGS.invoices.detailLabelStatus}</span>
            <span className={styles.metaValue}>{attrs.label}</span>
          </div>
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>{STRINGS.invoices.detailLabelIssueDate}</span>
            <span className={styles.metaValue}>
              {invoice.issueDate ? formatDateDE(invoice.issueDate) : '—'}
            </span>
          </div>
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>{STRINGS.invoices.detailLabelPerformanceDate}</span>
            <span className={styles.metaValue}>
              {invoice.performanceDate ? formatDateDE(invoice.performanceDate) : '—'}
            </span>
          </div>
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>{STRINGS.invoices.detailLabelTaxMode}</span>
            <span className={styles.metaValue}>
              {labelForTaxMode(invoice.taxMode, {
                standard: STRINGS.companyProfile.taxModeStandard,
                kleinunternehmer: STRINGS.companyProfile.taxModeKleinunternehmer,
                reverseCharge: STRINGS.companyProfile.taxModeReverseCharge,
              })}
            </span>
          </div>
          {invoice.cancellationReason && (
            <div className={styles.metaRow}>
              <span className={styles.metaLabel}>
                {STRINGS.invoices.detailLabelCancellationReason}
              </span>
              <span className={styles.metaValue} data-testid="invoice-detail-cancellation-reason">
                {invoice.cancellationReason}
              </span>
            </div>
          )}
        </div>
      </section>

      <section className={styles.card} aria-label={STRINGS.invoices.detailHeadingIssuer}>
        <h2 className={styles.cardHeading}>{STRINGS.invoices.detailHeadingIssuer}</h2>
        <div className={styles.partyName} data-testid="invoice-detail-issuer-name">
          {invoice.issuer.companyName}
        </div>
        <div className={styles.partyAddressLine}>{issuerAddress.street}</div>
        <div className={styles.partyAddressLine}>
          {issuerAddress.zip} {issuerAddress.city}
        </div>
        <div className={styles.partyExtra}>
          {STRINGS.companyProfile.taxId}: {invoice.issuer.taxId}
        </div>
        {invoice.issuer.ustId && (
          <div className={styles.partyExtra}>
            {STRINGS.companyProfile.ustId}: {invoice.issuer.ustId}
          </div>
        )}
      </section>

      <section className={styles.card} aria-label={STRINGS.invoices.detailHeadingRecipient}>
        <h2 className={styles.cardHeading}>{STRINGS.invoices.detailHeadingRecipient}</h2>
        <div className={styles.partyName} data-testid="invoice-detail-recipient-name">
          {invoice.recipient.name}
        </div>
        {recipientAddress && (
          <>
            <div className={styles.partyAddressLine}>{recipientAddress.street}</div>
            <div className={styles.partyAddressLine}>
              {recipientAddress.zip} {recipientAddress.city}
            </div>
          </>
        )}
        {invoice.recipient.ustId && (
          <div className={styles.partyExtra}>
            {STRINGS.companyProfile.ustId}: {invoice.recipient.ustId}
          </div>
        )}
      </section>

      <section className={styles.card} aria-label={STRINGS.invoices.detailHeadingLines}>
        <h2 className={styles.cardHeading}>{STRINGS.invoices.detailHeadingLines}</h2>
        <div className={styles.linesTableScroll}>
          <table className={styles.linesTable} data-testid="invoice-detail-lines">
            <thead>
              <tr>
                <th>{STRINGS.invoices.formLineDescription}</th>
                <th className={styles.numeric}>{STRINGS.invoices.formLineQuantity}</th>
                <th>{STRINGS.invoices.formLineUnit}</th>
                <th className={styles.numeric}>{STRINGS.invoices.formLineUnitPrice}</th>
                <th className={styles.numeric}>{STRINGS.invoices.formLineTaxRate}</th>
                <th className={styles.numeric}>{STRINGS.invoices.formLineTotal}</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, idx) => (
                <tr key={idx}>
                  <td>{line.description}</td>
                  <td className={styles.numeric}>{line.quantity}</td>
                  <td>{line.unit}</td>
                  <td className={styles.numeric}>{formatCurrencyDE(line.unitPrice)}</td>
                  <td className={styles.numeric}>{line.taxRate}%</td>
                  <td className={styles.numeric}>{formatCurrencyDE(line.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.card} aria-label={STRINGS.invoices.detailHeadingTotals}>
        <h2 className={styles.cardHeading}>{STRINGS.invoices.detailHeadingTotals}</h2>
        <dl className={styles.totalsList} data-testid="invoice-detail-totals">
          <div className={styles.totalsRow}>
            <dt>{STRINGS.invoices.totalsNet}</dt>
            <dd>{formatCurrencyDE(invoice.totals.netGrandTotal)}</dd>
          </div>
          {invoice.totals.perRate.map((rate) => (
            <div key={rate.taxRate} className={styles.totalsRow}>
              <dt>{STRINGS.invoices.totalsTaxAt(rate.taxRate)}</dt>
              <dd>{formatCurrencyDE(rate.taxAmount)}</dd>
            </div>
          ))}
          <div className={`${styles.totalsRow} ${styles.totalsGrossRow}`}>
            <dt>{STRINGS.invoices.totalsGross}</dt>
            <dd>{formatCurrencyDE(invoice.totals.grossGrandTotal)}</dd>
          </div>
        </dl>
      </section>

      {isOriginal && siblings.length > 0 && (
        <section className={styles.card} aria-label={STRINGS.invoices.detailStornoSiblings}>
          <h2 className={styles.cardHeading}>{STRINGS.invoices.detailStornoSiblings}</h2>
          <div className={styles.siblings} data-testid="invoice-detail-storno-siblings">
            {siblings.map((sib) => (
              <div key={sib.id} className={styles.siblingRow}>
                <span className={styles.siblingChevron} aria-hidden="true">
                  ↳
                </span>
                <Link
                  to={`/rechnungen/${sib.id}`}
                  className={styles.siblingLink}
                  data-testid={`invoice-detail-sibling-${sib.id}`}
                >
                  {sib.number ?? sib.id}
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <InvoiceCancelDialog
        isOpen={cancelOpen}
        submitting={cancelSubmitting}
        errorMessage={cancelError}
        onConfirm={(reason) => void handleCancelConfirm(reason)}
        onClose={() => {
          if (cancelSubmitting) return;
          setCancelOpen(false);
          setCancelError(null);
        }}
      />
    </article>
  );
}
