/**
 * Per-project invoice block (ui/project-detail.md §8.15.11, ADR-0026).
 *
 * Argumented C-SIZE exception (review/conventions-code.md §C-SIZE,
 * 200 LOC guideline): this file is ~470 LOC. It assembles a single
 * per-project invoice surface — invoices list, row-level actions
 * (Bearbeiten / Verwerfen / Ausstellen / Stornieren / PDF download),
 * `Neue Rechnung` CTA, COMPANY_PROFILE_REQUIRED banner, and the
 * `Alle Rechnungen anzeigen` cross-link — all bound to one project's
 * store slice. Splitting per affordance would scatter the surface
 * across files without separating responsibility (no piece has its
 * own state or fetch).
 *
 * Surfaces the project's invoices as a list with row-level actions
 * (issue / cancel / PDF), the `Neue Rechnung` CTA, the inline draft
 * form, and the Storno confirmation dialog. Mounted from
 * `ProjectDetailPage` between the Attachments section and the Activity
 * Feed; the page never holds invoice state directly.
 *
 * Permission gating: the whole section is hidden for callers without
 * `invoice:read` (workers — server is authoritative via the repository
 * scope predicate). The `Neue Rechnung` CTA is additionally gated on
 * `invoice:write` AND `project.status === 'rechnung_faellig'` per
 * spec §8.15.11.
 *
 * Realtime: a global `invoice_changed` SSE subscription
 * (state/invoiceSseSubscription.ts) refreshes every project's invoice
 * list when another session issues / cancels.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { STRINGS } from '@/config/strings';
import type { WorkflowState } from '@/config/stateConfig';
import type { Invoice } from '@/domain/invoice';
import { buildInvoiceDownloadFilename } from '@/domain/invoice';
import { orderInvoicesWithStornoGrouping } from '@/domain/invoiceGrouping';
import { formatCurrencyDE, formatDateDE } from '@/domain/dateFormat';
import { useInvoiceStore } from '@/state/invoiceStore';
import { useProjectStore } from '@/state/projectStore';
import { useConfirmStore } from '@/state/confirmStore';
import { useToastStore } from '@/state/toastStore';
import { usePermission } from '@/hooks/usePermission';
import { downloadAuthedFile } from '@/ui/utils/downloadFile';
import { InvoiceDraftForm } from './InvoiceDraftForm';
import { InvoiceCancelDialog } from './InvoiceCancelDialog';
import styles from './InvoiceSection.module.css';

/**
 * Translate the server's missing-field path ("address.zip", "ustId", …)
 * to its German display label. The path strings are pinned at the API
 * layer (api.md §14.2.15 + CompanyProfileService), so this map is the
 * client-side decoder. Unknown paths fall back to the raw key — operator
 * triage still reads it, and a missing translation surfaces as text
 * rather than a silent drop.
 */
function labelForCompanyProfileField(path: string): string {
  switch (path) {
    case 'companyName':
      return STRINGS.companyProfile.companyName;
    case 'address.street':
      return STRINGS.companyProfile.street;
    case 'address.zip':
      return STRINGS.companyProfile.zip;
    case 'address.city':
      return STRINGS.companyProfile.city;
    case 'taxId':
      return STRINGS.companyProfile.taxId;
    case 'ustId':
      return STRINGS.companyProfile.ustId;
    case 'defaultTaxMode':
      return STRINGS.companyProfile.defaultTaxMode;
    default:
      return path;
  }
}

interface Props {
  projectId: string;
  projectStatus: WorkflowState;
}

export function InvoiceSection({ projectId, projectStatus }: Props) {
  const canRead = usePermission('invoice:read');
  const canWrite = usePermission('invoice:write');

  const invoices = useInvoiceStore((s) => s.byProject[projectId]);
  const loading = useInvoiceStore((s) => s.loadingByProject[projectId] ?? false);
  const error = useInvoiceStore((s) => s.errorByProject[projectId] ?? null);
  const fetchByProject = useInvoiceStore((s) => s.fetchByProject);
  const issueInvoice = useInvoiceStore((s) => s.issue);
  const cancelInvoice = useInvoiceStore((s) => s.cancel);
  const deleteDraft = useInvoiceStore((s) => s.deleteDraft);

  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
  const requestConfirm = useConfirmStore((s) => s.request);
  const showToast = useToastStore((s) => s.show);

  const [formOpen, setFormOpen] = useState(false);
  const [editingDraft, setEditingDraft] = useState<Invoice | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Invoice | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // F3 — dedicated banner state for COMPANY_PROFILE_REQUIRED. Separated
  // from the generic `actionError` so the user reads it as "do this and
  // try again" rather than a transient mutation failure. Cleared on the
  // next successful action or when the user dismisses it by issuing.
  const [missingProfileFields, setMissingProfileFields] = useState<string[] | null>(null);

  useEffect(() => {
    if (!canRead) return;
    void fetchByProject(projectId);
  }, [canRead, fetchByProject, projectId]);

  // Deep-link intent: `?editDraft=:invoiceId` on this route asks the
  // section to open its modal form on that draft. Used by the standalone
  // /rechnungen list to deliver the user straight into the editor for a
  // draft row (the form lives here, not there). Derived — not pulled
  // into local state via an effect — so the URL stays the source of
  // truth: refresh re-opens, browser-back leaves the page cleanly. The
  // param is stripped on `onClose` so the form doesn't reappear after
  // the user dismisses it.
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const urlEditDraftId = searchParams.get('editDraft');
  const urlEditDraft = useMemo(() => {
    if (!urlEditDraftId || !invoices) return null;
    return (
      invoices.find(
        (inv) => inv.id === urlEditDraftId && inv.status === 'draft' && !inv.cancellationOf,
      ) ?? null
    );
  }, [urlEditDraftId, invoices]);

  // The Storno row's display number lookup. Map id -> Invoice so the
  // row can render `Storno zu RE-YYYY-NNNN` even when the original sits
  // elsewhere in the array.
  const invoicesById = useMemo(() => {
    const map = new Map<string, Invoice>();
    for (const inv of invoices ?? []) {
      map.set(inv.id, inv);
    }
    return map;
  }, [invoices]);

  // Storno grouping rule (ui/invoices.md §8.16.1) — see helper docstring.
  const orderedInvoices = useMemo(
    () => orderInvoicesWithStornoGrouping(invoices ?? []),
    [invoices],
  );

  if (!canRead) return null;

  const showCreateCta = canWrite && projectStatus === 'rechnung_faellig';

  const handleIssue = async (invoice: Invoice) => {
    setActionError(null);
    setMissingProfileFields(null);
    const ok = await requestConfirm(STRINGS.invoices.issueConfirmBody, {
      title: STRINGS.invoices.issueConfirmTitle,
      confirmLabel: STRINGS.invoices.issueConfirmOk,
    });
    if (!ok) return;
    const outcome = await issueInvoice(invoice.id, projectId);
    if (
      outcome.status === 'validation' &&
      outcome.missingFields &&
      outcome.missingFields.length > 0
    ) {
      // F3 — surface the dedicated COMPANY_PROFILE_REQUIRED banner with
      // the named fields + a link to /daten. The row state stays intact
      // so the user can fix the profile and retry. The server validates
      // recipient fields the same way; recipient.* paths are typed-input
      // problems the user fixes in the form itself, so we route only the
      // company-profile paths to the banner.
      const companyProfilePaths = outcome.missingFields.filter(
        (path) => !path.startsWith('recipient.') && !['lines', 'performanceDate'].includes(path),
      );
      if (companyProfilePaths.length > 0) {
        setMissingProfileFields(companyProfilePaths);
        return;
      }
    }
    if (outcome.status !== 'ok') {
      setActionError(outcome.errorMessage);
      return;
    }
    // The issue path flips the project status server-side (AC-287). Refresh
    // the project so the Kanban / detail header reflect the new state without
    // requiring a manual reload.
    void useProjectStore.getState().fetchProject(projectId);
  };

  const handleDeleteDraft = async (invoice: Invoice) => {
    setActionError(null);
    const ok = await requestConfirm(STRINGS.invoices.deleteDraftConfirm);
    if (!ok) return;
    const outcome = await deleteDraft(invoice.id, projectId);
    if (outcome.status !== 'ok') {
      setActionError(outcome.errorMessage);
    }
  };

  const handleCancelConfirm = async (reason: string) => {
    if (!cancelTarget) return;
    setCancelSubmitting(true);
    setCancelError(null);
    const outcome = await cancelInvoice(cancelTarget.id, projectId, reason);
    setCancelSubmitting(false);
    if (outcome.status !== 'ok') {
      setCancelError(outcome.errorMessage);
      return;
    }
    setCancelTarget(null);
  };

  const downloadPdf = (invoice: Invoice) => {
    // Fetch the PDF bytes and save them via a blob URL (see
    // `downloadAuthedFile`) — a direct `<a download>` at the attachment
    // endpoint leaves mobile/PWA browsers on a blank page.
    void downloadAuthedFile(
      `/api/invoices/${invoice.id}/pdf`,
      buildInvoiceDownloadFilename(invoice),
    ).catch(() => showToast('error', STRINGS.invoices.downloadPdfError));
  };

  const renderEmpty = !loading && (invoices ?? []).length === 0;

  return (
    <section
      className={styles.section}
      aria-label={STRINGS.invoices.sectionHeading}
      data-testid="project-invoice-section"
    >
      <div className={styles.header}>
        <h3 className={styles.heading}>{STRINGS.invoices.sectionHeading}</h3>
        {showCreateCta && (
          <button
            type="button"
            className={styles.createButton}
            onClick={() => {
              setEditingDraft(null);
              setFormOpen(true);
            }}
            data-testid="invoice-draft-create"
          >
            {STRINGS.invoices.newInvoice}
          </button>
        )}
      </div>

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}
      {missingProfileFields && (
        <div
          className={styles.companyProfileBanner}
          role="status"
          data-testid="invoice-company-profile-required-banner"
        >
          <h4 className={styles.companyProfileBannerHeading}>
            {STRINGS.invoices.companyProfileBannerHeading}
          </h4>
          <p>
            {STRINGS.invoices.companyProfileBannerBody(
              missingProfileFields.map(labelForCompanyProfileField).join(', '),
            )}
          </p>
          <Link
            to="/rechnungen"
            className={styles.companyProfileBannerLink}
            data-testid="invoice-company-profile-link"
          >
            {STRINGS.invoices.companyProfileBannerLink}
          </Link>
        </div>
      )}
      {actionError && (
        <div className={styles.errorBanner} role="alert">
          {actionError}
        </div>
      )}

      {renderEmpty ? (
        <div className={styles.empty} data-testid="invoice-list-empty">
          {STRINGS.invoices.empty}
        </div>
      ) : (
        <div className={styles.list} data-testid="invoice-list">
          {orderedInvoices.map((invoice) => (
            <InvoiceRow
              key={invoice.id}
              invoice={invoice}
              originalNumber={
                invoice.cancellationOf
                  ? (invoicesById.get(invoice.cancellationOf)?.number ?? null)
                  : null
              }
              canWrite={canWrite}
              onIssue={() => void handleIssue(invoice)}
              onEditDraft={() => {
                setEditingDraft(invoice);
                setFormOpen(true);
              }}
              onDeleteDraft={() => void handleDeleteDraft(invoice)}
              onCancel={() => {
                setCancelError(null);
                setCancelTarget(invoice);
              }}
              onDownloadPdf={() => downloadPdf(invoice)}
            />
          ))}
        </div>
      )}

      {/* Cross-link to the standalone list view, pre-filtered to this
          project (ui/project-detail.md §8.15.11). Rendered unconditionally
          for `invoice:read` holders — the link is read-only, not a write
          affordance. */}
      <div className={styles.crossLink}>
        <Link
          to={`/rechnungen?projectId=${projectId}`}
          className={styles.crossLinkAnchor}
          data-testid="invoice-cross-link-list"
        >
          {STRINGS.invoices.crossLinkToList}
        </Link>
      </div>

      {(formOpen || urlEditDraft !== null) && (
        <InvoiceDraftForm
          projectId={projectId}
          draft={editingDraft ?? urlEditDraft}
          defaultPerformanceDate={project?.plannedEnd ?? null}
          fallbackRecipient={{
            name: project?.customer?.name ?? '',
            street: project?.customer?.address?.street ?? '',
            zip: project?.customer?.address?.zip ?? '',
            city: project?.customer?.address?.city ?? '',
          }}
          onClose={() => {
            setFormOpen(false);
            setEditingDraft(null);
            if (searchParams.has('editDraft')) {
              const next = new URLSearchParams(searchParams);
              next.delete('editDraft');
              setSearchParams(next, { replace: true });
            }
            // If the user reached the editor by clicking a draft on the
            // filtered /rechnungen list, return them there. The prefix
            // check is a strict allow-list — router state can't easily
            // be tampered with, but the guard keeps the surface honest.
            const state: unknown = location.state;
            const returnTo =
              state &&
              typeof state === 'object' &&
              'returnTo' in state &&
              typeof (state as { returnTo: unknown }).returnTo === 'string'
                ? (state as { returnTo: string }).returnTo
                : null;
            if (returnTo && returnTo.startsWith('/rechnungen')) {
              navigate(returnTo);
            }
          }}
        />
      )}

      <InvoiceCancelDialog
        isOpen={cancelTarget !== null}
        submitting={cancelSubmitting}
        errorMessage={cancelError}
        onConfirm={(reason) => void handleCancelConfirm(reason)}
        onClose={() => {
          if (cancelSubmitting) return;
          setCancelTarget(null);
          setCancelError(null);
        }}
      />
    </section>
  );
}

interface InvoiceRowProps {
  invoice: Invoice;
  /** Cancellation original's `number`, when this row is a Storno sibling. */
  originalNumber: string | null;
  canWrite: boolean;
  onIssue: () => void;
  onEditDraft: () => void;
  onDeleteDraft: () => void;
  onCancel: () => void;
  onDownloadPdf: () => void;
}

function statusLabelClass(invoice: Invoice): {
  label: string;
  className: string;
  rowClassName: string;
} {
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

function InvoiceRow({
  invoice,
  originalNumber,
  canWrite,
  onIssue,
  onEditDraft,
  onDeleteDraft,
  onCancel,
  onDownloadPdf,
}: InvoiceRowProps) {
  const status = statusLabelClass(invoice);
  const isStorno = invoice.cancellationOf !== null;
  const isDraft = invoice.status === 'draft';
  const isIssued = invoice.status === 'issued' && !isStorno;
  // Storno rows are status='issued' with a non-null cancellationOf; they
  // should not expose Cancel (the cancellation atom would create a Storno
  // of a Storno — not a thing). PDF download remains.
  // Cancelled originals expose PDF only.

  return (
    <div className={status.rowClassName} data-testid={`invoice-row-${invoice.id}`}>
      <div>
        <div className={styles.cellNumber} data-testid="invoice-number">
          {invoice.number ?? '—'}
        </div>
        {isStorno && originalNumber && (
          <div className={styles.stornoOfHint} data-testid="invoice-storno-of">
            {STRINGS.invoices.stornoOfLabel(originalNumber)}
          </div>
        )}
      </div>
      <div>
        <span className={status.className} data-testid="invoice-status-badge">
          {status.label}
        </span>
      </div>
      <div>{invoice.issueDate ? formatDateDE(invoice.issueDate) : '—'}</div>
      <div className={styles.cellRecipient}>{invoice.recipient.name}</div>
      <div className={styles.cellTotal}>{formatCurrencyDE(invoice.totals.grossGrandTotal)}</div>
      <div className={styles.actions}>
        {isDraft && canWrite && (
          <>
            <button
              type="button"
              className={styles.actionButton}
              onClick={onEditDraft}
              data-testid="invoice-draft-edit"
            >
              {STRINGS.invoices.editDraftAction}
            </button>
            <button
              type="button"
              className={`${styles.actionButton} ${styles.actionDanger}`}
              onClick={onDeleteDraft}
              data-testid="invoice-draft-delete"
              title={STRINGS.invoices.deleteDraftAction}
            >
              {STRINGS.invoices.discardAction}
            </button>
            <button
              type="button"
              className={styles.actionButton}
              onClick={onIssue}
              data-testid="invoice-issue-button"
            >
              {STRINGS.invoices.issueAction}
            </button>
          </>
        )}
        {!isDraft && (
          <button
            type="button"
            className={styles.actionButton}
            onClick={onDownloadPdf}
            data-testid="invoice-download-pdf"
          >
            {STRINGS.invoices.downloadPdfAction}
          </button>
        )}
        {isIssued && canWrite && (
          <button
            type="button"
            className={`${styles.actionButton} ${styles.actionDanger}`}
            onClick={onCancel}
            data-testid="invoice-cancel-button"
          >
            {STRINGS.invoices.cancelAction}
          </button>
        )}
      </div>
    </div>
  );
}
