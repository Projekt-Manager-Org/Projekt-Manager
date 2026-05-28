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
 */

import { useEffect } from 'react';
import { isTopEscape, registerEscape, unregisterEscape } from './escapeStack';

export function useEscapeKey(handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const token = registerEscape();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (!isTopEscape(token)) return;
      e.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      unregisterEscape(token);
    };
  }, [handler, enabled]);
}
