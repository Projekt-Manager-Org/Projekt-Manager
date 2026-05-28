/**
 * `useGlobalShortcut` — Vitest + React Testing Library coverage for the
 * primitive that powers the dock's Alt+A toggle (AC-340) and any future
 * shell-level shortcut. The hook's contract:
 *
 *   - Fires the callback only when modifier flags match exactly.
 *   - Calls `event.preventDefault()` BEFORE invoking the callback so the
 *     keystroke does not trigger a browser-default binding.
 *   - Suppresses while focus is in an editable affordance (text-like
 *     `<input>`, `<textarea>`, `<select>`, `[contenteditable]`,
 *     `role="textbox"` / `role="searchbox"`).
 *   - `disabled` flag cleanly tears down the listener.
 *
 * The dock-shaped scenarios (toggle + suppress in inputs + per-route
 * disable) live in `ActivityDock.test.tsx`; this file pins the
 * primitive itself so a refactor / new consumer cannot drift.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { useGlobalShortcut } from '@/hooks/useGlobalShortcut';

function Probe({
  onFire,
  disabled = false,
  shortcut = { key: 'a', alt: true },
}: {
  onFire: () => void;
  disabled?: boolean;
  shortcut?: { key: string; alt?: boolean; shift?: boolean; ctrl?: boolean; meta?: boolean };
}) {
  useGlobalShortcut(shortcut, onFire, { disabled });
  return (
    <>
      <input data-testid="text-input" type="text" />
      <input data-testid="checkbox-input" type="checkbox" />
      <textarea data-testid="textarea" />
      <select data-testid="select">
        <option>a</option>
      </select>
      <div data-testid="editable" contentEditable />
      <div data-testid="role-textbox" role="textbox" tabIndex={0} />
      <div data-testid="role-searchbox" role="searchbox" tabIndex={0} />
      <button data-testid="button">button</button>
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe('useGlobalShortcut — basic match', () => {
  it('fires the callback on an exact modifier+key match', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    fireEvent.keyDown(window, { key: 'a', altKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('does not fire when only the key matches but a modifier differs', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    fireEvent.keyDown(window, { key: 'a' }); // no Alt
    expect(onFire).not.toHaveBeenCalled();
  });

  it('does not fire when an extra modifier is pressed', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    fireEvent.keyDown(window, { key: 'a', altKey: true, shiftKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('case-insensitive key match', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    fireEvent.keyDown(window, { key: 'A', altKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('fires on macOS Option+A (event.key remapped to "å", event.code stays KeyA)', () => {
    // macOS: holding Option remaps the typed character to a dead-key
    // glyph but `event.code` keeps the physical position. The matcher
    // must fall back to `event.code === 'KeyA'` for letter shortcuts so
    // Alt+A still fires AND `preventDefault()` runs (which is what stops
    // the dead-key `å` from leaking through into focused inputs).
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const event = new KeyboardEvent('keydown', {
      key: 'å',
      code: 'KeyA',
      altKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('useGlobalShortcut — preventDefault', () => {
  it('calls preventDefault on a matching keystroke', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      altKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(onFire).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('does NOT call preventDefault on a non-matching keystroke', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const event = new KeyboardEvent('keydown', {
      key: 'b',
      altKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(onFire).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('useGlobalShortcut — editable-affordance suppression', () => {
  it('suppresses while a text input has focus', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const input = screen.getByTestId('text-input') as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: 'a', altKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('suppresses while a textarea has focus', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const textarea = screen.getByTestId('textarea') as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'a', altKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('suppresses while a select has focus', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const select = screen.getByTestId('select') as HTMLSelectElement;
    select.focus();
    fireEvent.keyDown(select, { key: 'a', altKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('suppresses while a contenteditable element has focus', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const editable = screen.getByTestId('editable');
    editable.focus();
    fireEvent.keyDown(editable, { key: 'a', altKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('suppresses while a role="textbox" element has focus', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const widget = screen.getByTestId('role-textbox');
    widget.focus();
    fireEvent.keyDown(widget, { key: 'a', altKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('suppresses while a role="searchbox" element has focus', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const widget = screen.getByTestId('role-searchbox');
    widget.focus();
    fireEvent.keyDown(widget, { key: 'a', altKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('does NOT suppress on a non-text input type (checkbox)', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const checkbox = screen.getByTestId('checkbox-input') as HTMLInputElement;
    checkbox.focus();
    fireEvent.keyDown(checkbox, { key: 'a', altKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('does NOT suppress on a button', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} />);
    const button = screen.getByTestId('button');
    button.focus();
    fireEvent.keyDown(button, { key: 'a', altKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});

describe('useGlobalShortcut — disabled flag', () => {
  it('does not install the listener when disabled=true', () => {
    const onFire = vi.fn();
    render(<Probe onFire={onFire} disabled />);
    fireEvent.keyDown(window, { key: 'a', altKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe('useGlobalShortcut — cleanup', () => {
  it('removes its listener on unmount so a remount does not leak handlers', () => {
    // Regression guard: a useEffect cleanup that forgets to call
    // `removeEventListener` would still pass every match/suppress case
    // above but leak a handler per (un)mount cycle. After unmount, a
    // matching keystroke must NOT reach the now-stale callback.
    const onFire = vi.fn();
    const { unmount } = render(<Probe onFire={onFire} />);
    fireEvent.keyDown(window, { key: 'a', altKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);

    unmount();
    fireEvent.keyDown(window, { key: 'a', altKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
