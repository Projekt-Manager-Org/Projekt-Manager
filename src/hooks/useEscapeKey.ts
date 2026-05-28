/**
 * Calls the supplied handler when the user presses Escape, while the
 * `enabled` flag is true. Used by modals to close on Esc.
 *
 * Stack-coordinated: each instance pushes a token onto `escapeStack` on
 * mount and pops on unmount. The keydown listener fires only if the
 * token is currently on top, so a popover stacked inside a modal
 * dismisses the popover only — the modal stays open. Replaces the
 * previous `[data-testid="confirm-dialog"]` selector check, which only
 * coordinated against one specific surface.
 *
 * The handler is kept in a ref so the registration effect depends only
 * on `enabled`. Were `handler` a dependency, a caller passing an inline
 * closure (e.g. `useEscapeKey(() => setOpen(false))`) would tear down
 * and re-register its stack slot on every host render — pushing a fresh
 * token to the TOP and stealing dismissal from whatever surface is
 * actually on top. Same shape and rationale as `useDialogA11y`.
 */

import { useEffect, useRef } from 'react';
import { isTopEscape, registerEscape, unregisterEscape } from './escapeStack';

export function useEscapeKey(handler: () => void, enabled = true) {
  // Keep the latest handler in a ref so the registration effect below
  // depends only on `enabled`. Updated in a no-deps effect (not inline
  // during render) to stay concurrent-safe — matching useDialogA11y.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!enabled) return;
    const token = registerEscape();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (!isTopEscape(token)) return;
      e.preventDefault();
      handlerRef.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      unregisterEscape(token);
    };
  }, [enabled]);
}
