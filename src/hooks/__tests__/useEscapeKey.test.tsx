/**
 * `useEscapeKey` — pins the stack-coordinated behavior so a regression
 * back to "every Esc handler fires in parallel" is caught.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

function Probe({ onClose, enabled = true }: { onClose: () => void; enabled?: boolean }) {
  useEscapeKey(onClose, enabled);
  return null;
}

afterEach(() => {
  cleanup();
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

  it('removes its listener on unmount', () => {
    const close = vi.fn();
    const { unmount } = render(<Probe onClose={close} />);
    unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });
});
