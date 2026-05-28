/**
 * `useEscapeKey` — pins the stack-coordinated behavior so a regression
 * back to "every Esc handler fires in parallel" is caught.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { __resetEscapeStackForTests } from '@/hooks/escapeStack';

function Probe({ onClose, enabled = true }: { onClose: () => void; enabled?: boolean }) {
  useEscapeKey(onClose, enabled);
  return null;
}

afterEach(() => {
  cleanup();
  __resetEscapeStackForTests();
});

describe('useEscapeKey', () => {
  it('calls the handler on Escape', () => {
    const close = vi.fn();
    render(<Probe onClose={close} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not call the handler when disabled', () => {
    const close = vi.fn();
    render(<Probe onClose={close} enabled={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });

  it('stacked handlers: Esc closes only the topmost surface', () => {
    // Modal opens (outer) → popover stacks on top (inner). Pressing Esc
    // must close the popover only; the modal stays open. Previously both
    // fired because each useEscapeKey instance attached its own
    // unconditional window listener.
    const closeModal = vi.fn();
    const closePopover = vi.fn();
    render(<Probe onClose={closeModal} />);
    const { unmount: unmountPopover } = render(<Probe onClose={closePopover} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closePopover).toHaveBeenCalledTimes(1);
    expect(closeModal).not.toHaveBeenCalled();

    // After the popover unmounts (its real-world equivalent of closing),
    // a second Esc reaches the modal.
    unmountPopover();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closeModal).toHaveBeenCalledTimes(1);
  });

  it('re-rendering a stacked-under surface with a new handler does not steal the top', () => {
    // Regression guard (PR #243 review): registration is per open/close
    // cycle, NOT per handler identity. A host passing an inline closure
    // (fresh ref each render) must not re-push its token to the top on
    // re-render and steal Esc from the surface that is actually on top —
    // the exact "wrong layer closes" bug the stack exists to prevent.
    const closeLower = vi.fn();
    const closeUpper = vi.fn();

    // Lower surface mounts first; its host passes a fresh arrow each render.
    const lower = render(<Probe onClose={() => closeLower()} />);
    // Upper surface stacks on top.
    render(<Probe onClose={closeUpper} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closeUpper).toHaveBeenCalledTimes(1);
    expect(closeLower).not.toHaveBeenCalled();

    // The lower surface's host re-renders with a new handler identity.
    lower.rerender(<Probe onClose={() => closeLower()} />);

    // Upper is still on top — it must absorb Esc again.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closeUpper).toHaveBeenCalledTimes(2);
    expect(closeLower).not.toHaveBeenCalled();
  });

  it('removes its listener on unmount', () => {
    const close = vi.fn();
    const { unmount } = render(<Probe onClose={close} />);
    unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });
});
