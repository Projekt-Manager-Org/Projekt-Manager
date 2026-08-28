/**
 * `installMatchMedia` — pins the three contracts the hook suites lean on but
 * cannot observe themselves, because each of their tests re-installs the stub
 * and so masks a stub that misbehaves between tests.
 *
 * All three were broken on arrival: `restore()` restored nothing, `change()`
 * dispatched from a half-updated state, and `changeQuery()` accepted any
 * string. A stub that lies is worse than no stub — it turns a red test green.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { installMatchMedia, type MatchMediaStub } from '@/test/matchMediaStub';

const Q1 = '(max-width: 480px)';
const Q2 = '(max-width: 940px)';

let stub: MatchMediaStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('installMatchMedia', () => {
  it('restore() puts back the previously installed matchMedia', () => {
    // Descriptor-based restore silently failed here: vitest's jsdom
    // environment exposes `matchMedia` as an accessor, so re-defining the
    // captured descriptor hands back a getter that reads the stub.
    const before = globalThis.matchMedia;

    stub = installMatchMedia({ [Q1]: true });
    expect(globalThis.matchMedia).not.toBe(before);

    stub.restore();
    stub = undefined;

    expect(globalThis.matchMedia).toBe(before);
  });

  it('stops throwing on unlisted queries once restored', () => {
    // The leak that would bite a later test in the same file: the record
    // form's throw outliving the test that installed it.
    stub = installMatchMedia({ [Q1]: false });
    expect(() => window.matchMedia(Q2)).toThrow(/no initial state/);

    stub.restore();
    stub = undefined;

    expect(window.matchMedia(Q2).matches).toBe(false);
  });

  it('change() applies every query before dispatching any of them', () => {
    stub = installMatchMedia({ [Q1]: false, [Q2]: false });
    const seenFromQ1Listener: boolean[] = [];
    window.matchMedia(Q1).addEventListener('change', () => {
      // A listener on Q1 reads Q2 — as `useCollapseTier` does, synchronously,
      // inside React's snapshot check.
      seenFromQ1Listener.push(window.matchMedia(Q2).matches);
    });

    stub.change(true);

    expect(seenFromQ1Listener).toEqual([true]);
  });

  it('changeQuery() throws on a query the stub does not know', () => {
    stub = installMatchMedia({ [Q1]: false });

    // A stray space — the typo class the record form exists to catch.
    expect(() => stub?.changeQuery('(max-width: 480px )', true)).toThrow(/unknown query/);
    // The message names the legal queries, so the typo is visible at a glance.
    expect(() => stub?.changeQuery(Q2, true)).toThrow(JSON.stringify(Q1));
  });

  it('changeQuery() accepts a query the boolean form created lazily', () => {
    // Boolean form has no list to validate against, so the rule is "handed
    // out at least once" — this is the legitimate path that must stay open.
    stub = installMatchMedia(false);
    expect(() => stub?.changeQuery(Q1, true)).toThrow(/unknown query/);

    window.matchMedia(Q1);

    stub.changeQuery(Q1, true);
    expect(window.matchMedia(Q1).matches).toBe(true);
  });
});
