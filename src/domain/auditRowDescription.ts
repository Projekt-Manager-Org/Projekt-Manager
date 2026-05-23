/**
 * One-line German description of an audit row derived from `(action,
 * payload)`. Pure function — no React, no i18n runtime.
 *
 * See ui/workflow-views.md §8.4.1 and ui/management.md §8.13.1 for the
 * UX target:
 *   - "Status geändert: Geplant → In Arbeit" for forward transitions
 *   - "Termine aktualisiert" for date updates
 *   - "Mitarbeiter zugewiesen: Jan Nowak" when workers are added, etc.
 *
 * Falls back to the action label from `auditActionLabels.ts` when no
 * richer derivation applies — the config-layer mapping remains the
 * single source of truth for the German copy.
 */

import { STATE_CONFIG_MAP, type WorkflowState } from '@/config/stateConfig';
import { labelForAuditAction } from '@/config/auditActionLabels';
import { STRINGS } from '@/config/strings';
import { isPayloadDiff } from './audit';
import type { AuditEntityType } from './audit';

/**
 * Shape of the `payload.counts` map the server writes on the single
 * `data_import` audit row (`api.md §14.2.4` — "Single import audit
 * row"). Every slot is required to be present in the payload (zero
 * when the slot was empty); the renderer below tolerates missing keys
 * as zero for defense in depth.
 */
interface ImportCounts {
  users?: number;
  company_profile?: number;
  customers?: number;
  projects?: number;
  project_workers?: number;
  invoices?: number;
  invoice_sequence?: number;
  attachments?: number;
}

function extractImportCounts(payload: unknown): ImportCounts | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as { counts?: unknown };
  if (!obj.counts || typeof obj.counts !== 'object') return null;
  const c = obj.counts as Record<string, unknown>;
  const out: ImportCounts = {};
  for (const key of [
    'users',
    'company_profile',
    'customers',
    'projects',
    'project_workers',
    'invoices',
    'invoice_sequence',
    'attachments',
  ] as const) {
    const v = c[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = v;
    }
  }
  return out;
}

function describeImportRestored(payload: unknown): string {
  const counts = extractImportCounts(payload);
  const prefix = STRINGS.audit.dataImportDescriptionPrefix;
  if (!counts) return prefix;

  const parts: string[] = [];
  if ((counts.users ?? 0) > 0) parts.push(STRINGS.audit.dataImportCountUsers(counts.users!));
  if ((counts.company_profile ?? 0) > 0) parts.push(STRINGS.audit.dataImportCountCompanyProfile);
  if ((counts.customers ?? 0) > 0)
    parts.push(STRINGS.audit.dataImportCountCustomers(counts.customers!));
  if ((counts.projects ?? 0) > 0)
    parts.push(STRINGS.audit.dataImportCountProjects(counts.projects!));
  if ((counts.project_workers ?? 0) > 0)
    parts.push(STRINGS.audit.dataImportCountProjectWorkers(counts.project_workers!));
  if ((counts.invoices ?? 0) > 0)
    parts.push(STRINGS.audit.dataImportCountInvoices(counts.invoices!));
  if ((counts.invoice_sequence ?? 0) > 0)
    parts.push(STRINGS.audit.dataImportCountInvoiceSequence(counts.invoice_sequence!));
  // `attachments` is always 0 on the text-leg audit (AC-311); we
  // omit it from the rendered list even when non-zero (defensive).

  if (parts.length === 0) return `${prefix}: ${STRINGS.audit.dataImportCountsEmpty}`;
  return `${prefix}: ${parts.join(', ')}`;
}

/**
 * Shape guard for the transition payload written by the server's
 * `mutate()` helper: `{ before: { status }, after: { status } }`. A
 * defensively narrow check — anything that doesn't match falls back
 * to the generic action label.
 */
function extractTransitionStates(
  payload: unknown,
): { from: WorkflowState; to: WorkflowState } | null {
  if (!isPayloadDiff(payload)) return null;
  const before = payload.before;
  const after = payload.after;
  const fromRaw = before?.status;
  const toRaw = after?.status;
  if (typeof fromRaw !== 'string' || typeof toRaw !== 'string') return null;
  if (!(fromRaw in STATE_CONFIG_MAP)) return null;
  if (!(toRaw in STATE_CONFIG_MAP)) return null;
  return { from: fromRaw as WorkflowState, to: toRaw as WorkflowState };
}

/**
 * Return a localized state label for a raw workflow-state key.
 * Typed so a caller who already narrowed to `WorkflowState` skips the
 * fallback branch.
 */
function stateLabel(state: WorkflowState): string {
  return STATE_CONFIG_MAP[state].label;
}

/**
 * Extract the `displayName` a project_worker audit payload writes into
 * its single side. The server includes the worker's display name in the
 * assignment audit row so the activity feed can render
 * "Mitarbeiter zugewiesen: Jan Nowak" without a second round-trip. The
 * extractor checks `after` first (create) then `before` (delete) and
 * returns null when neither side carries a string `displayName`.
 */
function extractWorkerDisplayName(payload: unknown): string | null {
  if (!isPayloadDiff(payload)) return null;
  const afterName = payload.after?.displayName;
  if (typeof afterName === 'string' && afterName.length > 0) return afterName;
  const beforeName = payload.before?.displayName;
  if (typeof beforeName === 'string' && beforeName.length > 0) return beforeName;
  return null;
}

/**
 * Detect whether an `update` payload on a project touched the planned
 * dates (plannedStart / plannedEnd). Either side of the diff having the
 * key is sufficient — an update that sets `plannedEnd` from null to a
 * value only places the key on `after`.
 */
function touchesPlannedDates(payload: unknown): boolean {
  if (!isPayloadDiff(payload)) return false;
  const keys = new Set<string>();
  if (payload.before) for (const k of Object.keys(payload.before)) keys.add(k);
  if (payload.after) for (const k of Object.keys(payload.after)) keys.add(k);
  return keys.has('plannedStart') || keys.has('plannedEnd');
}

/**
 * Produce the one-line description. Recognizes a small set of
 * enriched shapes; otherwise delegates to `labelForAuditAction` so
 * the UI surface stays stable even for actions the client has not
 * specifically learned yet.
 *
 * The recognized shapes mirror the exemplars in ui/workflow-views.md
 * §8.4.1:
 *   - "Status geändert: Geplant → In Arbeit" — project transition
 *   - "Termine aktualisiert"                 — project update w/ dates
 *   - "Mitarbeiter zugewiesen: Jan Nowak"    — project_worker create
 *   - "Zuweisung aufgehoben: Jan Nowak"      — project_worker delete
 *   - "Archiviert"                           — project archive
 */
export function describeAuditRow(args: {
  action: string;
  payload: unknown;
  entityType: AuditEntityType;
}): string {
  const { action, payload, entityType } = args;

  // Forward / backward transition — the two most visible actions in
  // the project-detail feed; worth a "from → to" rendering.
  if (action === 'transition:forward' || action === 'transition:backward') {
    const states = extractTransitionStates(payload);
    if (states) {
      return `Status geändert: ${stateLabel(states.from)} → ${stateLabel(states.to)}`;
    }
  }

  // Project update whose diff references the planned-date fields. This
  // is keyed on the presence of either `plannedStart` or `plannedEnd`
  // in the diff — not on the entity being a project in isolation, since
  // a notes-only update on a project should NOT render as "Termine
  // aktualisiert".
  if (entityType === 'project' && action === 'update' && touchesPlannedDates(payload)) {
    return 'Termine aktualisiert';
  }

  // Project-worker assignment and unassignment. The payload carries the
  // assigned user's displayName when the server has it (see
  // ProjectCrudService worker-assignment audit rows); the generic fallback
  // keeps the string parseable when the payload is null (e.g. an import
  // path that didn't supply one) or when an older row predates the
  // displayName field.
  if (entityType === 'project_worker') {
    const name = extractWorkerDisplayName(payload);
    if (action === 'create') {
      return name ? `Mitarbeiter zugewiesen: ${name}` : 'Mitarbeiter zugewiesen';
    }
    if (action === 'delete') {
      return name ? `Zuweisung aufgehoben: ${name}` : 'Zuweisung aufgehoben';
    }
  }

  // Soft-delete on project ships as the `archive` action (ADR-0017 —
  // non-destructive, recoverable). The label mapping in
  // auditActionLabels.ts already carries the German `"Archiviert"` so
  // the generic fallback below handles this cleanly — we rely on that
  // here instead of duplicating the label.

  // Data-import deployment event — render per-slot counts inline so
  // the operator sees what landed without expanding the payload
  // drawer (whose JSON shows English keys).
  if (entityType === 'data_import' && action === 'import_restored') {
    return describeImportRestored(payload);
  }

  // Generic fallback — the action label alone, localized via the
  // config-layer mapping. Unknown actions surface their raw string (see
  // `labelForAuditAction` docstring).
  return labelForAuditAction(action);
}
