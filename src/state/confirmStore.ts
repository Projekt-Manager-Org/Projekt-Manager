/**
 * Confirmation dialog store.
 *
 * Replaces `window.confirm()` with a styled, accessible modal.
 *
 * Pattern: imperative request → Promise<boolean>. The caller awaits a
 * boolean instead of receiving JSX. The actual <ConfirmDialog /> is mounted
 * once at the App root and reads its state from this store.
 *
 * Usage:
 *   const confirmed = await useConfirmStore.getState().request('Sicher?');
 *   if (confirmed) { ... }
 *
 * Title is optional and defaults to "Bestätigen". A title (rather than reusing
 * the message) is required for accessible `aria-labelledby` — the message is
 * the description, the title is the label. If a caller does not supply one,
 * the default fits the German UX register and is appropriate for any
 * confirm/cancel prompt.
 *
 * Preemption semantic: if a request is already open when a new one arrives,
 * the previous request resolves to `false`. The preempted caller cannot
 * distinguish "user cancelled" from "replaced by a later request". This is
 * intentional — it prevents dangling promises and double-modal state — but
 * means callers must not branch on `false` to mean specifically "cancelled".
 * Treat `false` as "did not confirm" only.
 */

import type { ReactNode } from 'react';
import { create } from 'zustand';
import { STRINGS } from '@/config/strings';

interface ConfirmState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Optional content below the message — e.g. what the action acts on. */
  details: ReactNode;
  resolver: ((answer: boolean) => void) | null;

  request: (
    message: string,
    options?: {
      title?: string;
      confirmLabel?: string;
      cancelLabel?: string;
      details?: ReactNode;
    },
  ) => Promise<boolean>;
  resolve: (answer: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  isOpen: false,
  title: STRINGS.ui.confirm,
  message: '',
  confirmLabel: STRINGS.ui.ok,
  cancelLabel: STRINGS.ui.cancel,
  details: null,
  resolver: null,

  request: (message, options = {}) => {
    // If a previous request is still open, resolve it as cancelled to avoid
    // dangling promises and double-modal state. See preemption semantic in
    // the file header.
    const previous = get().resolver;
    if (previous) previous(false);

    return new Promise<boolean>((resolve) => {
      set({
        isOpen: true,
        title: options.title ?? STRINGS.ui.confirm,
        message,
        confirmLabel: options.confirmLabel ?? STRINGS.ui.ok,
        cancelLabel: options.cancelLabel ?? STRINGS.ui.cancel,
        details: options.details ?? null,
        resolver: resolve,
      });
    });
  },

  resolve: (answer) => {
    const { resolver } = get();
    if (resolver) resolver(answer);
    set({
      isOpen: false,
      message: '',
      details: null,
      resolver: null,
    });
  },
}));
