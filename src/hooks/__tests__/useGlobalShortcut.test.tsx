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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
      <button data-testid="button">button</button>
    </>
  );
}

beforeEach(() => {
  // Ensure no stale listener from a prior test bleeds into the next.
});

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
