/**
 * Deployment-level configuration for the unified data-exchange surface.
 * See api.md §14.2.4, architecture.md §12.2, and verification.md AC-160.
 */

/**
 * Phrase the caller must type (and submit in the request body) to commit a
 * destructive restore — a business-data import (`ImportService`) with
 * `override=true` into a non-empty target. Pure ASCII so it's safe to type
 * on any keyboard layout
 * during a disaster-recovery window, and long enough that muscle memory
 * doesn't fire the wipe by accident.
 *
 * Comparison on the server trims leading/trailing whitespace on the typed
 * value before comparing; the comparison is case-sensitive. See
 * ImportService for the gate logic and AC-160 for the testable contract.
 */
export const RESTORE_CONFIRMATION_PHRASE = 'LOESCHEN';

/**
 * Canonical phrase-match check shared by server and UI — trims leading
 * and trailing whitespace, compares case-sensitively. Exporting the
 * predicate (rather than the trim/compare idiom in two call sites) keeps
 * client-side gating and server-side re-validation provably identical.
 */
export function restorePhraseMatches(typed: string): boolean {
  return typed.trim() === RESTORE_CONFIRMATION_PHRASE;
}
