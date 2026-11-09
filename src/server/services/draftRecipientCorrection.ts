/**
 * A customer correction reaches open drafts (data-model.md §5.15, §6.4).
 * Runs inside the customer edit's transaction.
 */

import type { MutatingDatabase } from '../db/connection.js';
import { projectAuditLabel } from '../../domain/audit.js';
import type {
  InvoiceLine,
  InvoiceRecipientSnapshot,
  InvoiceTotals,
  TaxMode,
} from '../../domain/invoice.js';
import { getCustomerDraftsForMutation, updateInvoiceDraft } from '../repositories/invoice-read.js';
import type { AuditLogRow } from './audit-publisher.js';
import { mutateInTx, type MutateContext } from './mutate.js';

type Address = InvoiceRecipientSnapshot['address'];

const normalized = (value: string | null | undefined): string => (value ?? '').trim();

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalized(a) === normalized(b);
}

function sameAddress(a: Address, b: Address): boolean {
  return sameText(a?.street, b?.street) && sameText(a?.zip, b?.zip) && sameText(a?.city, b?.city);
}

/**
 * Keyed on values, not on the fields the edit sent: the customer form sends
 * every field, changed or not.
 */
function follow<T>(held: T, previous: T, next: T, same: (a: T, b: T) => boolean): T {
  return !same(previous, next) && same(held, previous) ? next : held;
}

/** The draft's recipient after the correction, or null when nothing changes. */
function correctedRecipient(
  held: InvoiceRecipientSnapshot,
  previous: InvoiceRecipientSnapshot,
  next: InvoiceRecipientSnapshot,
): InvoiceRecipientSnapshot | null {
  const heldAddress = held.address ?? null;
  const heldUstId = held.ustId ?? null;
  const name = follow(held.name, previous.name, next.name, sameText);
  const address = follow<Address>(heldAddress, previous.address, next.address, sameAddress);
  const ustId = follow(heldUstId, previous.ustId, next.ustId, sameText);
  if (name === held.name && address === heldAddress && ustId === heldUstId) return null;
  return { name, address, ustId };
}

/** Returns one audit row per changed draft, for dispatch after commit. */
export async function applyCustomerCorrectionToDrafts(
  tx: MutatingDatabase,
  ctx: MutateContext,
  userId: string,
  customerId: string,
  previous: InvoiceRecipientSnapshot,
  next: InvoiceRecipientSnapshot,
): Promise<AuditLogRow[]> {
  const auditRows: AuditLogRow[] = [];
  for (const { invoice, project } of await getCustomerDraftsForMutation(tx, customerId)) {
    const held = invoice.recipient as InvoiceRecipientSnapshot;
    const recipient = correctedRecipient(held, previous, next);
    if (!recipient) continue;
    const { auditRow } = await mutateInTx(tx, ctx, {
      entityType: 'invoice',
      action: 'update',
      run: async (innerTx) => ({
        entityId: invoice.id,
        entityLabel: null,
        value: await updateInvoiceDraft(innerTx, invoice.id, {
          taxMode: invoice.taxMode as TaxMode,
          lines: invoice.lines as InvoiceLine[],
          totals: invoice.totals as InvoiceTotals,
          recipient,
          performanceDate: invoice.performanceDate,
          updatedBy: userId,
        }),
        before: { recipient: held },
        after: { recipient },
        ancestorEntityType: 'project',
        ancestorEntityId: project.id,
        ancestorEntityLabel: projectAuditLabel(project),
      }),
    });
    auditRows.push(auditRow);
  }
  return auditRows;
}
