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

function matches(event: KeyboardEvent, shortcut: GlobalShortcut): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
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
