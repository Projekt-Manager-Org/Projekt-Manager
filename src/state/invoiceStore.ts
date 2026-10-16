/**
 * Per-project invoice state (ui/project-detail.md §8.15.11, ADR-0026).
 *
 * Scoped to the `/projects/:id` block — keyed by `projectId` so the same
 * store can hold rows for multiple projects without cross-bleed (the
 * detail page only mounts one, but background refetches from the SSE
 * channel may target any project whose list the user has already seen).
 *
 * Mutation surface — draft create / patch / delete, issue, cancel — mirrors
 * the API endpoints 1:1. Every write (including cancel) refetches the
 * parent project's list so the local cache stays consistent with the
 * server's ordering / number allocation. A cancel call therefore lands
 * the flipped original AND its freshly minted Storno sibling in the same
 * `fetchByProject` response — no separate re-resolve step is needed.
 *
 * Session expiry is funnelled through the shared helper. Error messages
 * are decoded from the server's `code` field to the German UI copy in
 * `STRINGS.invoices.*` so the surface can branch on a stable enum
 * (`code`) rather than the raw message.
 */

import { create } from 'zustand';
import { STRINGS } from '@/config/strings';
import type { Invoice } from '@/domain/invoice';
import {
  invoicesApi,
  type ApiFailure,
  type InvoiceCreateDraftInput,
  type InvoiceUpdateDraftInput,
} from '@/api/client';
import { handleSessionExpired } from './sessionExpired';
import { isVersionConflict } from './versionedWrites';

/**
 * Result of a write action. `'ok'` — server committed; the per-project
 * list has been refetched. `'validation'` — server returned a 422 with a
 * decoded German message on `errorMessage`; the caller keeps the form
 * open and surfaces the message inline. `'conflict'` — stale write
 * (behavior.md §9.5); the list has been refetched and `invoice` is the
 * fresh row (absent if it is gone). `'error'` — generic failure; same
 * surfacing rule but the message is the generic catch-all.
 */
export type InvoiceWriteOutcome =
  | { status: 'ok'; invoice?: Invoice }
  | { status: 'validation'; errorMessage: string; missingFields?: string[] }
  | { status: 'conflict'; errorMessage: string; invoice?: Invoice }
  | { status: 'error'; errorMessage: string };

interface InvoiceState {
  /** Per-project invoice cache. Empty array means "fetched, no rows". */
  byProject: Record<string, Invoice[]>;
  /** Per-project loading flag — set while the GET is in flight. */
  loadingByProject: Record<string, boolean>;
  /** Per-project error message — set on the last GET / refetch only. */
  errorByProject: Record<string, string | null>;

  fetchByProject: (projectId: string) => Promise<void>;
  createDraft: (
    projectId: string,
    payload: InvoiceCreateDraftInput,
  ) => Promise<InvoiceWriteOutcome>;
  /**
   * The versioned writes carry `startVersion`: the draft version the
   * form or the confirmation dialog opened with (behavior.md §9.5).
   */
  updateDraft: (
    invoiceId: string,
    projectId: string,
    startVersion: number,
    payload: InvoiceUpdateDraftInput,
  ) => Promise<InvoiceWriteOutcome>;
  deleteDraft: (
    invoiceId: string,
    projectId: string,
    startVersion: number,
  ) => Promise<InvoiceWriteOutcome>;
  issue: (
    invoiceId: string,
    projectId: string,
    startVersion: number,
  ) => Promise<InvoiceWriteOutcome>;
  cancel: (invoiceId: string, projectId: string, reason: string) => Promise<InvoiceWriteOutcome>;
}

function decodeErrorMessage(code: string, serverMessage: string): string {
  switch (code) {
    case 'INVOICE_FROZEN':
      return STRINGS.invoices.errorFrozen;
    case 'INVOICE_NOT_ISSUED':
      return STRINGS.invoices.errorNotIssued;
    case 'INVOICE_ALREADY_CANCELLED':
      return STRINGS.invoices.errorAlreadyCancelled;
    case 'INVOICE_PROJECT_STATE':
      return STRINGS.invoices.errorProjectState;
    case 'COMPANY_PROFILE_REQUIRED':
      return STRINGS.invoices.errorCompanyProfileRequired;
    default:
      return serverMessage || STRINGS.errors.mutationFailed;
  }
}

function extractMissingFields(details: unknown): string[] | undefined {
  if (details && typeof details === 'object' && 'missingFields' in details) {
    const value = (details as { missingFields: unknown }).missingFields;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return value;
    }
  }
  return undefined;
}

export const useInvoiceStore = create<InvoiceState>((set, get) => {
  /** Stale write: refetch the project's invoices, hand back the fresh row. */
  async function refetchAfterConflict(
    invoiceId: string,
    projectId: string,
    result: ApiFailure,
  ): Promise<InvoiceWriteOutcome> {
    await get().fetchByProject(projectId);
    const invoice = get().byProject[projectId]?.find((i) => i.id === invoiceId);
    return {
      status: 'conflict',
      errorMessage: result.error.message,
      ...(invoice ? { invoice } : {}),
    };
  }

  return {
    byProject: {},
    loadingByProject: {},
    errorByProject: {},

    fetchByProject: async (projectId) => {
      set((s) => ({
        loadingByProject: { ...s.loadingByProject, [projectId]: true },
        errorByProject: { ...s.errorByProject, [projectId]: null },
      }));
      const result = await invoicesApi.listByProject(projectId);
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          // Reset the loading flag before bouncing so any re-render of
          // the section after the session-expired toast does not get
          // stuck on a stale spinner.
          set((s) => ({
            loadingByProject: { ...s.loadingByProject, [projectId]: false },
          }));
          return;
        }
        set((s) => ({
          loadingByProject: { ...s.loadingByProject, [projectId]: false },
          errorByProject: { ...s.errorByProject, [projectId]: result.error.message },
        }));
        return;
      }
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: result.data.data },
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
      }));
    },

    createDraft: async (projectId, payload) => {
      const result = await invoicesApi.createDraft(projectId, payload);
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return { status: 'error', errorMessage: STRINGS.auth.sessionExpired };
        }
        const message = decodeErrorMessage(result.error.code, result.error.message);
        if (result.category === 'validation') {
          const missing = extractMissingFields(result.details);
          return {
            status: 'validation',
            errorMessage: message,
            ...(missing !== undefined ? { missingFields: missing } : {}),
          };
        }
        return { status: 'error', errorMessage: message };
      }
      await get().fetchByProject(projectId);
      return { status: 'ok', invoice: result.data };
    },

    updateDraft: async (invoiceId, projectId, startVersion, payload) => {
      const result = await invoicesApi.updateDraft(invoiceId, startVersion, payload);
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return { status: 'error', errorMessage: STRINGS.auth.sessionExpired };
        }
        if (isVersionConflict(result)) return refetchAfterConflict(invoiceId, projectId, result);
        const message = decodeErrorMessage(result.error.code, result.error.message);
        if (result.category === 'validation') {
          const missing = extractMissingFields(result.details);
          return {
            status: 'validation',
            errorMessage: message,
            ...(missing !== undefined ? { missingFields: missing } : {}),
          };
        }
        return { status: 'error', errorMessage: message };
      }
      await get().fetchByProject(projectId);
      return { status: 'ok', invoice: result.data };
    },

    deleteDraft: async (invoiceId, projectId, startVersion) => {
      const result = await invoicesApi.deleteDraft(invoiceId, startVersion);
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return { status: 'error', errorMessage: STRINGS.auth.sessionExpired };
        }
        if (isVersionConflict(result)) return refetchAfterConflict(invoiceId, projectId, result);
        return {
          status: 'error',
          errorMessage: decodeErrorMessage(result.error.code, result.error.message),
        };
      }
      await get().fetchByProject(projectId);
      return { status: 'ok' };
    },

    issue: async (invoiceId, projectId, startVersion) => {
      const result = await invoicesApi.issue(invoiceId, startVersion);
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return { status: 'error', errorMessage: STRINGS.auth.sessionExpired };
        }
        if (isVersionConflict(result)) return refetchAfterConflict(invoiceId, projectId, result);
        const message = decodeErrorMessage(result.error.code, result.error.message);
        // `COMPANY_PROFILE_REQUIRED` is a domain-level precondition gate, not
        // a request-validation error — the server tags it with its own code
        // (api.md §14.4) and `classifyCode` defaults it to `server_error`.
        // For the surface, however, it carries actionable `details.missingFields`
        // the F3 banner consumes, so it routes through the `validation`
        // outcome branch alongside genuine VALIDATION_ERROR responses.
        const isValidationLike =
          result.category === 'validation' || result.error.code === 'COMPANY_PROFILE_REQUIRED';
        if (isValidationLike) {
          const missing = extractMissingFields(result.details);
          return {
            status: 'validation',
            errorMessage: message,
            ...(missing !== undefined ? { missingFields: missing } : {}),
          };
        }
        return { status: 'error', errorMessage: message };
      }
      await get().fetchByProject(projectId);
      return { status: 'ok', invoice: result.data };
    },

    cancel: async (invoiceId, projectId, reason) => {
      const result = await invoicesApi.cancel(invoiceId, reason);
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return { status: 'error', errorMessage: STRINGS.auth.sessionExpired };
        }
        return {
          status: 'error',
          errorMessage: decodeErrorMessage(result.error.code, result.error.message),
        };
      }
      await get().fetchByProject(projectId);
      return { status: 'ok', invoice: result.data.original };
    },
  };
});
