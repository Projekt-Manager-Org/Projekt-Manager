/**
 * Subscribe to a CSS media-query and re-render on transitions.
 *
 * Returns the current match boolean. `useSyncExternalStore` is what makes
 * this correct rather than merely convenient: it re-reads the snapshot
 * immediately AFTER subscribing and re-renders if it moved. A hook that
 * seeds `useState` at render and subscribes in an effect drops any `change`
 * landing in that gap — a dialog mounting mid-rotation then renders the
 * wrong branch until the next transition (issue #327).
 *
 * SSR-safe via `getServerSnapshot`: the server render resolves to `false`
 * (the desktop branch) and the client takes over from the real query. The
 * project is a SPA so SSR is not a concern today, but the guard keeps the
 * hook reusable in a potential future SSR shell without a refactor.
 */
import { useCallback, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  // Memoized on `query`: an unstable `subscribe` identity makes React tear
  // the subscription down and rebuild it on every commit.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onStoreChange);
      return () => mql.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
