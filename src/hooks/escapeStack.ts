/**
 * LIFO registry of active Escape-key handlers. Each dismissable surface
 * (modal, dialog, popover) pushes a slot on mount and pops on unmount;
 * Esc-key handlers consult `isTopEscape()` before firing so only the
 * topmost surface dismisses.
 *
 * Problem this replaces: every Esc-aware surface attached its own
 * `window.addEventListener('keydown', ...)` and all of them fired in
 * parallel. A popover stacked inside a modal closed both at once. The
 * previous mitigation (`useEscapeKey`'s `document.querySelector(
 * '[data-testid="confirm-dialog"]')` deference check) only handled the
 * single ConfirmDialog case; this generalises it.
 *
 * Why LIFO and not z-index lookup: stacking order in this codebase is
 * driven by mount order — a surface that opens later is on top. The
 * stack mirrors that mount order, so the contract is "the most recently
 * pushed handler wins" without any DOM probing.
 *
 * Every Esc-dismissable surface registers here via `useEscapeKey` (or,
 * for full modals, `useDialogA11y`). No surface attaches its own
 * `keydown` listener — see ARCHITECTURE.md "Escape-to-dismiss".
 */

const stack: symbol[] = [];

/**
 * Push a new top-of-stack slot. Returns the token the caller passes
 * back to `isTopEscape()` / `unregisterEscape()`.
 */
export function registerEscape(): symbol {
  const token = Symbol('escape-handler');
  stack.push(token);
  return token;
}

/** Remove the slot. Idempotent — calling after unmount is a no-op. */
export function unregisterEscape(token: symbol): void {
  const i = stack.lastIndexOf(token);
  if (i !== -1) stack.splice(i, 1);
}

/** True if the given token is currently on top of the stack. */
export function isTopEscape(token: symbol): boolean {
  return stack[stack.length - 1] === token;
}

/**
 * Test-only reset. Production code never calls this; vitest uses it
 * between describe blocks to avoid leakage between renders.
 */
export function __resetEscapeStackForTests(): void {
  stack.length = 0;
}
