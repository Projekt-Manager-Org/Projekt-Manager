/**
 * Single row on the standalone /rechnungen list (ui/invoices.md §8.16.1).
 *
 * The row is a clickable container — `<div role="button">` with explicit
 * keyboard handling — so action affordances can sit as DOM siblings
 * (HTML forbids `<a>` and `<button>` inside `<button>`). Action clicks
 * `stopPropagation` so they do not double-fire navigation.
 *
 * Navigation per topology:
 *   - draft  → `/projects/:projectId?editDraft=:invoiceId`. The
 *               per-project block hosts the only editable surface for a
 *               draft, so the deep link carries the draft id; the
 *               receiving `InvoiceSection` auto-opens its modal form on
 *               that draft (otherwise the user lands mid-flow and has to
 *               click `Bearbeiten` a second time).
 *   - issued → `/rechnungen/:id` (the per-invoice viewer, §8.16.3).
 *   - storno → `/rechnungen/:id`.
 *   - cancelled original → `/rechnungen/:id`.
 *
 * Row actions per topology:
 *   - draft  → `Bearbeiten` (same deep link as the row click — opens the
 *               project block's draft form), `Verwerfen` (delete draft
 *               inline).
 *   - issued / storno / cancelled → `PDF herunterladen`.
 *
 * `Ausstellen` is intentionally NOT exposed here — issuing requires the
 * project context (status flip via project store, refetch of the
 * project), which is the per-project block's responsibility.
 */

import { useLocation, useNavigate } from 'react-router-dom';
import { STRINGS } from '@/config/strings';
import { buildInvoiceDownloadFilename, type Invoice } from '@/domain/invoice';
import { formatCurrencyDE, formatDateDE } from '@/domain/dateFormat';
import { useInvoiceListStore } from '@/state/invoiceListStore';
import { useInvoiceStore } from '@/state/invoiceStore';
import { useConfirmStore } from '@/state/confirmStore';
import { useToastStore } from '@/state/toastStore';
import { usePermission } from '@/hooks/usePermission';
import { downloadAuthedFile } from '@/ui/utils/downloadFile';
import styles from './InvoiceListView.module.css';

interface RowAttrs {
  label: string;
  className: string;
  rowClassName: string;
}

function statusAttrs(invoice: Invoice): RowAttrs {
  if (invoice.cancellationOf) {
    return {
      label: STRINGS.invoices.statusStorno,
      className: `${styles.statusBadge} ${styles.statusStorno}`,
      rowClassName: `${styles.row} ${styles.rowStorno}`,
    };
  }
  switch (invoice.status) {
    case 'draft':
      return {
        label: STRINGS.invoices.statusDraft,
        className: styles.statusBadge,
        rowClassName: styles.row,
      };
    case 'issued':
      return {
        label: STRINGS.invoices.statusIssued,
        className: `${styles.statusBadge} ${styles.statusIssued}`,
        rowClassName: styles.row,
      };
    case 'cancelled':
      return {
        label: STRINGS.invoices.statusCancelled,
        className: `${styles.statusBadge} ${styles.statusCancelled}`,
        rowClassName: `${styles.row} ${styles.rowCancelled}`,
      };
  }
}

interface Props {
  invoice: Invoice;
  /** Original's `number`, when this row is a Storno sibling. */
  originalNumber: string | null;
}

export function InvoiceListRow({ invoice, originalNumber }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const canWrite = usePermission('invoice:write');
  const fetchList = useInvoiceListStore((s) => s.fetch);
  const deleteDraft = useInvoiceStore((s) => s.deleteDraft);
  const requestConfirm = useConfirmStore((s) => s.request);
  const showToast = useToastStore((s) => s.show);
  const attrs = statusAttrs(invoice);
  const isDraft = invoice.status === 'draft';
  const showDownload = invoice.status !== 'draft';

  // Deep link: the `editDraft` param tells `InvoiceSection` to open its
  // modal form on this draft, so the user lands in the editor rather
  // than on the bare project page expecting a second click. We pass the
  // originating list URL via router state so the editor's `Abbrechen`
  // returns the user to the same filtered list rather than stranding
  // them on the project page.
  const returnTo = `${location.pathname}${location.search}`;
  const navigateToDraftEditor = () =>
    navigate(`/projects/${invoice.projectId}?editDraft=${invoice.id}`, {
      state: { returnTo },
    });
  const navigateToDetail = () => navigate(`/rechnungen/${invoice.id}`);
  // Drafts open in the per-project block (the only place a draft is
  // editable). Issued / cancelled / Storno rows open in the per-invoice
  // viewer (§8.16.3). Both are deep-linkable surfaces.
  const navigateOnRowClick = isDraft ? navigateToDraftEditor : navigateToDetail;

  // Fetch the PDF bytes and save them via a blob URL (see
  // `downloadAuthedFile`) — a direct `<a download>` at the attachment
  // endpoint leaves mobile/PWA browsers on a blank page.
  const downloadPdf = () => {
    void downloadAuthedFile(
      `/api/invoices/${invoice.id}/pdf`,
      buildInvoiceDownloadFilename(invoice),
    ).catch(() => showToast('error', STRINGS.invoices.downloadPdfError));
  };

  const handleDeleteDraft = async () => {
    const ok = await requestConfirm(STRINGS.invoices.deleteDraftConfirm);
    if (!ok) return;
    const outcome = await deleteDraft(invoice.id, invoice.projectId);
    if (outcome.status === 'ok') void fetchList();
  };

  const selectedIds = useInvoiceListStore((s) => s.selectedIds);
  const toggleSelection = useInvoiceListStore((s) => s.toggleSelection);
  const isSelected = selectedIds.has(invoice.id);

  return (
    <div
      role="button"
      tabIndex={0}
      className={attrs.rowClassName}
      onClick={navigateOnRowClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigateOnRowClick();
        }
      }}
      data-testid={`invoice-row-${invoice.id}`}
    >
      <div className={styles.cellSelect} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          className={styles.selectCheckbox}
          checked={isSelected}
          disabled={isDraft}
          onChange={() => toggleSelection(invoice.id)}
          aria-label={STRINGS.invoices.selectRowAria(invoice.number)}
          title={isDraft ? STRINGS.invoices.draftNotExportableTooltip : undefined}
          data-testid="invoice-select"
        />
      </div>
      <div className={styles.cellNumberBlock}>
        <div className={styles.cellNumber} data-testid="invoice-number">
          {invoice.number ?? '—'}
        </div>
        {invoice.cancellationOf && originalNumber && (
          <div className={styles.stornoOfHint} data-testid="invoice-storno-of">
            {STRINGS.invoices.stornoOfLabel(originalNumber)}
          </div>
        )}
      </div>
      <div className={styles.cellStatusWrap}>
        <span className={attrs.className} data-testid="invoice-status-badge">
          {attrs.label}
        </span>
      </div>
      <div className={styles.cellDate}>
        {invoice.issueDate ? formatDateDE(invoice.issueDate) : '—'}
      </div>
      <div className={styles.cellRecipient}>{invoice.recipient.name}</div>
      <div className={styles.cellTotal}>{formatCurrencyDE(invoice.totals.grossGrandTotal)}</div>
      <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
        {isDraft && canWrite && (
          <>
            <button
              type="button"
              className={styles.actionButton}
              onClick={navigateToDraftEditor}
              data-testid="invoice-draft-edit"
            >
              {STRINGS.invoices.editDraftAction}
            </button>
            <button
              type="button"
              className={`${styles.actionButton} ${styles.actionDanger}`}
              onClick={() => void handleDeleteDraft()}
              data-testid="invoice-draft-delete"
              aria-label={STRINGS.invoices.deleteDraftAction}
              title={STRINGS.invoices.deleteDraftAction}
            >
              {STRINGS.invoices.discardAction}
            </button>
          </>
        )}
        {showDownload && (
          <button
            type="button"
            className={styles.actionButton}
            onClick={downloadPdf}
            data-testid="invoice-download-pdf"
          >
            {STRINGS.invoices.downloadPdfAction}
          </button>
        )}
      </div>
    </div>
  );
}
