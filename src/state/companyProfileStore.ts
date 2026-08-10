/**
 * Company-profile singleton state (ui/daten.md §8.11.4, ADR-0026).
 *
 * Owner-mutated only — no cross-session race worth wiring an SSE
 * subscription for. The Daten view's CompanyProfileSection drives both
 * `fetch()` (mount + post-save refresh) and `save()` (PUT).
 *
 * Session expiry is funnelled through the shared helper so the bounce-
 * to-login surface stays uniform across stores.
 */

import { create } from 'zustand';
import type { CompanyProfile } from '@/domain/invoice';
import { companyProfileApi, type CompanyProfileInput } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';

/**
 * Payload accepted by `save`. The full `CompanyProfileInput` shape per
 * api.md §14.2.15 (PUT — every writable field present, including
 * `logoBinaryDescriptorId`). The Section round-trips the descriptor
 * value loaded by GET back through PUT so any server-side state
 * (logo upload pipeline lands in #189) survives an owner save.
 */
export type CompanyProfileSavePayload = CompanyProfileInput;

/**
 * Result of `save`. `'ok'` — PUT committed, `data` refreshed.
 * `'validation'` — server returned a 422 (VALIDATION_ERROR or
 * COMPANY_PROFILE_REQUIRED); the caller may inspect `saveError` for the
 * server-supplied German copy and the optional `missingFields` for
 * field-level targeting. `'error'` — generic failure; the message lives
 * on `saveError`.
 */
export type SaveOutcome =
  { status: 'ok' } | { status: 'validation'; missingFields: string[] } | { status: 'error' };

interface CompanyProfileState {
  data: CompanyProfile | null;
  loading: boolean;
  /**
   * Error from the most recent `fetch()`. Distinct from `saveError`
   * because the form (the only `saveError` consumer) is not mounted
   * until `data` is non-null — a failed initial GET would otherwise hide
   * the diagnostic behind an empty section. Surfaced by the section's
   * `!data` branch with a retry affordance. Cleared at the start of
   * every `fetch()` attempt.
   */
  fetchError: string | null;
  /**
   * Error from the most recent `save()`. Surfaced inline by the form.
   * Cleared at the start of every save attempt and exposed via
   * `clearSaveError()` for the caller's dismiss affordance.
   */
  saveError: string | null;

  fetch: () => Promise<void>;
  save: (payload: CompanyProfileSavePayload) => Promise<SaveOutcome>;
  clearSaveError: () => void;
}

function extractMissingFields(details: unknown): string[] {
  if (details && typeof details === 'object' && 'missingFields' in details) {
    const value = (details as { missingFields: unknown }).missingFields;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return value;
    }
  }
  return [];
}

export const useCompanyProfileStore = create<CompanyProfileState>((set) => ({
  data: null,
  loading: false,
  fetchError: null,
  saveError: null,

  fetch: async () => {
    set({ loading: true, fetchError: null });
    const result = await companyProfileApi.get();
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        set({ loading: false });
        return;
      }
      set({ loading: false, fetchError: result.error.message });
      return;
    }
    set({ data: result.data, loading: false });
  },

  save: async (payload) => {
    set({ saveError: null });
    const result = await companyProfileApi.put(payload);
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return { status: 'error' };
      }
      const missingFields = extractMissingFields(result.details);
      set({ saveError: result.error.message });
      if (
        result.error.code === 'VALIDATION_ERROR' ||
        result.error.code === 'COMPANY_PROFILE_REQUIRED'
      ) {
        return { status: 'validation', missingFields };
      }
      return { status: 'error' };
    }
    set({ data: result.data });
    return { status: 'ok' };
  },

  clearSaveError: () => set({ saveError: null }),
}));
