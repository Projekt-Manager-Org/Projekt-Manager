/**
 * Install a window-level `keydown` shortcut, suppressed while focus is
 * inside an editable affordance.
 *
 * Pinned by [verification.md AC-340](../../docs/spec/verification.md#1532-activity-dock):
 *   - Handler fires only when ALL the modifier flags match exactly
 *     (`alt`, `shift`, `ctrl`, `meta`).
 *   - Handler calls `event.preventDefault()` BEFORE invoking the
 *     callback so the keystroke does not also trigger a browser-default
 *     binding (e.g. Firefox/Chrome menu-bar mnemonic on `Alt+letter`)
 *     or insert a macOS dead-key character (`Option+A → å`).
 *   - For single-letter shortcuts the matcher falls back to
 *     `event.code === 'Key<L>'` so macOS Option+letter (which remaps
 *     `event.key` to a dead-key glyph) still fires the binding — see
 *     `matchesKey()`.
 *   - Handler is suppressed while any element with an "editable
 *     affordance" has focus — `<input>` text-likes, `<textarea>`,
 *     `<select>`, `contenteditable`, or ARIA `role="textbox"` /
 *     `role="searchbox"` — so the shortcut does not steal keystrokes
 *     typed into filter fields, dropdowns, or AI-prompt-style
 *     composers.
 *   - Returns a no-op unsubscribe when `disabled = true`, so callers
 *     can wire the hook unconditionally and pass a per-render gate
 *     (e.g. permission check) without churn on the listener identity.
 */

import { useEffect } from 'react';

export interface GlobalShortcut {
  /** Lowercased `KeyboardEvent.key` (e.g. `'a'`, `'/'`, `'escape'`). */
  key: string;
  alt?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/**
 * Editable-affordance focus detector (AC-340). A return of `true`
 * suppresses the shortcut.
 *
 * Notes:
 *   - `<input>` types like `checkbox`, `radio`, `button`, `submit`,
 *     `reset`, `file`, `range` are NOT editable in the typing sense;
 *     the shortcut should fire even when those have focus. Only
 *     text-like input types (default `text`, plus `search`, `email`,
 *     `url`, `tel`, `password`, `number`, `date`, `time`, `datetime-local`,
 *     `month`, `week`) suppress.
 *   - `<select>` is included because `<select>` consumes letter
 *     keystrokes for type-ahead selection — stealing that is hostile.
 *   - `[contenteditable]` covers rich-text editors and the AI-prompt
 *     composers that opt into the contenteditable surface.
 *   - ARIA `role="textbox"` / `role="searchbox"` covers custom widgets
 *     that present as a text input without using a real `<input>`.
 */
const TEXT_LIKE_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);

function isEditableFocus(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;

  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return TEXT_LIKE_INPUT_TYPES.has(target.type.toLowerCase());
  }

  // `isContentEditable` is the canonical check but is not always
  // implemented across DOM environments (notably JSDOM); fall back to
  // the attribute for parity. The attribute is set by frameworks (React
  // / Vue / etc.) the same way the property is, so the two are
  // equivalent in practice.
  if (target.isContentEditable) return true;
  const contentEditableAttr = target.getAttribute('contenteditable');
  if (
    contentEditableAttr !== null &&
    contentEditableAttr !== 'false' &&
    contentEditableAttr !== 'inherit'
  ) {
    return true;
  }

  const role = target.getAttribute('role');
  if (role === 'textbox' || role === 'searchbox') return true;

  return false;
}

/**
 * Match a key spec to a `KeyboardEvent`. Tries `event.key` first; for
 * single ASCII letters, falls back to `event.code === 'Key<L>'`.
 *
 * macOS rationale: holding Option remaps the typed character — Option+A
 * produces `event.key === 'å'`, Option+C → `'ç'`, Option+E → dead-key
 * pending. `event.code` keeps the physical position (`KeyA`, `KeyC`),
 * which is what `Alt+A` actually means as a mnemonic. Without this
 * fallback the matcher silently fails on macOS AND `preventDefault()`
 * never runs, so the keystroke leaks through as a dead-key insert.
 *
 * Non-letter shortcuts (`'escape'`, `'/'`, `'?'`) match `event.key`
 * only — those don't dead-key on macOS and their event.code values are
 * layout-specific in ways event.key isn't.
 */
function matchesKey(event: KeyboardEvent, key: string): boolean {
  if (event.key.toLowerCase() === key.toLowerCase()) return true;
  if (/^[a-z]$/i.test(key)) {
    return event.code === `Key${key.toUpperCase()}`;
  }
  return false;
}

function matches(event: KeyboardEvent, shortcut: GlobalShortcut): boolean {
  if (!matchesKey(event, shortcut.key)) return false;
  if (!!event.altKey !== !!shortcut.alt) return false;
  if (!!event.shiftKey !== !!shortcut.shift) return false;
  if (!!event.ctrlKey !== !!shortcut.ctrl) return false;
  if (!!event.metaKey !== !!shortcut.meta) return false;
  return true;
}

export function useGlobalShortcut(
  shortcut: GlobalShortcut,
  callback: () => void,
  options: { disabled?: boolean } = {},
): void {
  const { disabled = false } = options;

  useEffect(() => {
    if (disabled) return;

    const handler = (event: KeyboardEvent) => {
      if (!matches(event, shortcut)) return;
      if (isEditableFocus(event.target)) return;
      event.preventDefault();
      callback();
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
    // Shortcut spec is treated as an immutable identity for the hook —
    // callers pass a stable literal. Re-evaluating on every render
    // would churn the listener; the deps line below pins the only
    // meaningful inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    disabled,
    callback,
    shortcut.key,
    shortcut.alt,
    shortcut.shift,
    shortcut.ctrl,
    shortcut.meta,
  ]);
}
