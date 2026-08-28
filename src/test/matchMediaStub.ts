/**
 * Controllable `window.matchMedia` stub for component tests.
 *
 * jsdom implements no `matchMedia` at all. The stub in `component-setup.ts`
 * fills that hole with a permanent "no match" whose `addEventListener` is a
 * no-op — enough to keep components that probe a breakpoint from crashing,
 * but it can never dispatch a `change`. Tests that pin TRANSITION behavior
 * need listeners that actually fire.
 *
 * Two properties are load-bearing, both mirroring the browser:
 *
 *   - Every `matchMedia()` call returns a SEPARATE object with its OWN
 *     listener registry. Real `MediaQueryList`s are independent
 *     `EventTarget`s, so removing a listener from a second object does not
 *     unregister one added to the first. A stub with one shared registry
 *     would let that leak — subscribe on one object, clean up on another —
 *     pass as correct.
 *   - `matches` is a getter over per-query state, not a value frozen at
 *     creation. An object obtained BEFORE a viewport change still reports
 *     the new value, exactly as a live `MediaQueryList` re-evaluates.
 *
 * State is per query string, so a consumer holding several queries at once
 * (`useCollapseTier`) can be driven into any combination.
 */

type ChangeListener = (event: MediaQueryListEvent) => void;

/** One handed-out `MediaQueryList` and the listeners registered on it. */
interface Registration {
  query: string;
  listeners: Set<ChangeListener>;
}

export interface MatchMediaStub {
  /**
   * Flip EVERY known query and dispatch `change`. The convenient form for a
   * single-query consumer; use `changeQuery` when queries must diverge.
   */
  change(matches: boolean): void;
  /** Flip ONE query and dispatch `change` to its listeners. */
  changeQuery(query: string, matches: boolean): void;
  /**
   * Live listener count across every handed-out object, or for one query.
   * Counts registrations, not distinct functions: one handler on three
   * `MediaQueryList`s is three subscriptions, and three leaks if cleanup
   * misses them.
   */
  listenerCount(query?: string): number;
  /** Restore whatever `matchMedia` was installed before. */
  restore(): void;
}

/**
 * @param initial `true`/`false` applies to every query; a record pins each
 * query separately. In record form an unlisted query THROWS rather than
 * defaulting — a query string the test did not anticipate is a bug in the
 * test, and a silent `false` turns it into a confusing assertion failure
 * somewhere else.
 */
export function installMatchMedia(initial: boolean | Record<string, boolean>): MatchMediaStub {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  const registrations: Registration[] = [];
  const state = new Map<string, boolean>(
    typeof initial === 'boolean' ? [] : Object.entries(initial),
  );
  const fallback = typeof initial === 'boolean' ? initial : null;

  const matchesFor = (query: string): boolean => {
    const known = state.get(query);
    if (known !== undefined) return known;
    if (fallback === null) {
      throw new Error(`installMatchMedia: no initial state for query ${JSON.stringify(query)}`);
    }
    state.set(query, fallback);
    return fallback;
  };

  const create = (query: string): MediaQueryList => {
    // Seed on creation, not on first `.matches` read, so `change()` reaches a
    // query that was only ever subscribed to. In record form this is also
    // where an unanticipated query throws, at the call site that introduced
    // it rather than at some later assertion.
    matchesFor(query);
    const registration: Registration = { query, listeners: new Set() };
    registrations.push(registration);
    const mql = {
      get matches(): boolean {
        return matchesFor(query);
      },
      media: query,
      onchange: null,
      addEventListener: (type: string, listener: ChangeListener): void => {
        if (type === 'change') registration.listeners.add(listener);
      },
      removeEventListener: (type: string, listener: ChangeListener): void => {
        if (type === 'change') registration.listeners.delete(listener);
      },
      // Deprecated pair, kept because `component-setup.ts`'s stub carries it
      // and a consumer may still call it.
      addListener: (listener: ChangeListener): void => {
        registration.listeners.add(listener);
      },
      removeListener: (listener: ChangeListener): void => {
        registration.listeners.delete(listener);
      },
      dispatchEvent: (): boolean => false,
    };
    return mql as unknown as MediaQueryList;
  };

  (globalThis as { matchMedia: unknown }).matchMedia = create;

  const dispatch = (query: string, matches: boolean): void => {
    // Copy both levels: a listener may subscribe or unsubscribe during dispatch.
    for (const registration of [...registrations]) {
      if (registration.query !== query) continue;
      for (const listener of [...registration.listeners]) {
        listener({ matches, media: query } as MediaQueryListEvent);
      }
    }
  };

  return {
    change(matches: boolean): void {
      for (const query of [...state.keys()]) {
        state.set(query, matches);
        dispatch(query, matches);
      }
    },
    changeQuery(query: string, matches: boolean): void {
      state.set(query, matches);
      dispatch(query, matches);
    },
    listenerCount(query?: string): number {
      return registrations
        .filter((r) => query === undefined || r.query === query)
        .reduce((total, r) => total + r.listeners.size, 0);
    },
    restore(): void {
      if (previous) {
        Object.defineProperty(globalThis, 'matchMedia', previous);
      } else {
        delete (globalThis as { matchMedia?: unknown }).matchMedia;
      }
    },
  };
}
