/**
 * Modal-dialog accessibility primitives — focus trap, focus
 * restoration, body scroll lock, optional Escape handler. Same shape
 * baked into `ConfirmDialog`; extracted so the new
 * `VollstaendigerExportDialog` (and any future modal) doesn't have to
 * re-implement five separate `useEffect` invariants.
 *
 * Behaviour when `isOpen` flips true:
 *   - Saves the currently-focused element so it can be restored on close.
 *   - Locks `document.body.style.overflow = 'hidden'` (preserving the
 *     prior value so we restore instead of forcing 'auto').
 *   - Calls `onOpenedFocus` once after the lock — typically used to
 *     focus an initial action button (matches browser `confirm()`
 *     behaviour).
 *   - Installs a `keydown` listener that:
 *       * cycles Tab / Shift-Tab inside the dialog (focus trap), and
 *       * calls `onEscape` on Escape if provided.
 *
 * Cleanup on `isOpen` flip back to false: removes the listener,
 * restores body overflow, and restores focus to the previously-focused
 * element.
 *
 * Caller passes a ref to the dialog root so the focus-trap query can
 * scope to that subtree. The hook does NOT render anything — it is
 * purely a side-effect manager.
 */

import { useEffect, useRef, type RefObject } from 'react';
import { isTopEscape, registerEscape, unregisterEscape } from '@/hooks/escapeStack';

export interface UseDialogA11yInput {
  /** Whether the dialog is currently open / mounted. */
  isOpen: boolean;
  /** Ref to the dialog root element — used to scope the focus trap. */
  dialogRef: RefObject<HTMLElement | null>;
  /**
   * Called once after the dialog opens; typically focuses the primary
   * action button. If omitted, no initial focus management is applied
   * (the focus trap will still cycle correctly from wherever focus
   * lands).
   */
  onOpenedFocus?: () => void;
  /**
   * Called when the user presses Escape. If omitted, Escape is not
   * handled (e.g. progress phase of an export wants the user-visible
   * "Abbrechen" press, not a key-bound bail-out).
   */
  onEscape?: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogA11y(input: UseDialogA11yInput): void {
  const { isOpen, dialogRef, onOpenedFocus, onEscape } = input;
  // Keep the latest callbacks in a ref so the effect doesn't tear down
  // (and re-acquire focus / re-lock scroll) on every render of the
  // host. The effect only depends on `isOpen`. Ref updates happen in
  // a no-deps useEffect rather than inline-during-render — the latter
  // is flagged by react-hooks/refs and risks read-during-render bugs
  // under concurrent rendering.
  const onOpenedFocusRef = useRef(onOpenedFocus);
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onOpenedFocusRef.current = onOpenedFocus;
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    onOpenedFocusRef.current?.();

    // Claim a slot on the escape stack so Esc fires for this dialog only
    // when it is the topmost dismissable surface. Without this, a
    // ConfirmDialog stacked on top of a host modal would close both at
    // once. Tab focus-trap stays governed by this listener regardless of
    // stack position — focus belongs to the visible dialog.
    const escapeToken = registerEscape();

    function getFocusable(): HTMLElement[] {
      const root = dialogRef.current;
      if (!root) return [];
      return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const handler = onEscapeRef.current;
        if (handler && isTopEscape(escapeToken)) {
          e.preventDefault();
          handler();
        }
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !dialogRef.current?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !dialogRef.current?.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      unregisterEscape(escapeToken);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [isOpen, dialogRef]);
}
