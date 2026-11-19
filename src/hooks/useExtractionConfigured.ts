import { useEffect, useState } from 'react';
import { fetchExtractionConfigured } from '@/state/extractionActions';

/**
 * Whether email extraction is configured on the server (AC-734). Asks
 * once while `enabled`; `false` until the answer arrives, so the entry
 * point never flashes up on a server that cannot extract.
 */
export function useExtractionConfigured(enabled: boolean): boolean {
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchExtractionConfigured().then((value) => {
      if (!cancelled) setConfigured(value);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return enabled && configured;
}
