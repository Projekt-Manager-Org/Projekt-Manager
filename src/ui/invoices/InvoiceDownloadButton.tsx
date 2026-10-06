/**
 * The PDF download affordance shared by every surface that offers it —
 * list row, per-invoice viewer, per-project block (ui/invoices.md
 * §8.16.6).
 *
 * While the invoice is backup-pending the PDF is withheld server-side
 * (architecture.md §11.14), so the button renders disabled with the
 * `Wird gesichert…` label and its tooltip. The release arrives as
 * `invoice_changed`; the surfaces refetch and this re-renders enabled.
 */

import { STRINGS } from '@/config/strings';

interface InvoiceDownloadButtonProps {
  backupPending: boolean;
  label: string;
  onClick: () => void;
  className: string;
  testId: string;
}

export function InvoiceDownloadButton({
  backupPending,
  label,
  onClick,
  className,
  testId,
}: InvoiceDownloadButtonProps) {
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={backupPending}
      title={backupPending ? STRINGS.invoices.backupPendingTooltip : undefined}
      data-testid={testId}
    >
      {backupPending ? STRINGS.invoices.backupPendingLabel : label}
    </button>
  );
}
