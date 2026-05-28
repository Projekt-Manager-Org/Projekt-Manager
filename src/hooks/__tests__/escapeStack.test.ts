/**
 * `escapeStack` — coordination registry for stacked Esc handlers. The
 * contract these tests pin: LIFO ordering, `isTopEscape` returns true
 * only for the topmost token, idempotent unregister.
 *
 * Integration-shaped behavior (modal + popover, both close on Esc) lives
 * in higher-level hook tests (`useEscapeKey`, `useDialogA11y`); this
 * file fences the primitive itself.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetEscapeStackForTests,
  isTopEscape,
  registerEscape,
  unregisterEscape,
} from '@/hooks/escapeStack';

beforeEach(() => {
  __resetEscapeStackForTests();
});

describe('escapeStack', () => {
  it('isTopEscape is false for any token when the stack is empty', () => {
    const fake = Symbol('fake');
    expect(isTopEscape(fake)).toBe(false);
  });

  it('a single registered token is on top', () => {
    const a = registerEscape();
    expect(isTopEscape(a)).toBe(true);
  });

  it('LIFO — the most recently registered token is on top, older tokens are not', () => {
    const a = registerEscape();
    const b = registerEscape();
    expect(isTopEscape(b)).toBe(true);
    expect(isTopEscape(a)).toBe(false);
  });

  it('unregistering the top exposes the prior token', () => {
    const a = registerEscape();
    const b = registerEscape();
    unregisterEscape(b);
    expect(isTopEscape(a)).toBe(true);
    expect(isTopEscape(b)).toBe(false);
  });

  it('unregistering a non-top token leaves the top intact', () => {
    const a = registerEscape();
    const b = registerEscape();
    unregisterEscape(a);
    expect(isTopEscape(b)).toBe(true);
  });

  it('unregister is idempotent — calling twice is a no-op', () => {
    const a = registerEscape();
    unregisterEscape(a);
    expect(() => unregisterEscape(a)).not.toThrow();
    expect(isTopEscape(a)).toBe(false);
  });

  it('tokens are unique — two registrations produce distinct identities', () => {
    const a = registerEscape();
    const b = registerEscape();
    expect(a).not.toBe(b);
  });
});
