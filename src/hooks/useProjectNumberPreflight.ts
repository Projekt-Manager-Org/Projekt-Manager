import { useCallback, useRef, useState } from 'react';
import { useProjectManagementStore } from '@/state/projectManagementStore';

export type NumberPreflightStatus = 'idle' | 'checking' | 'available' | 'taken';

/**
 * Free / taken verdict for a project number (AC-478, AC-479). `check`
 * asks the server; `reset` drops the verdict when the number changes.
 */
export function useProjectNumberPreflight() {
  const searchProjects = useProjectManagementStore((s) => s.searchProjects);
  const [status, setStatus] = useState<NumberPreflightStatus>('idle');
  // Monotonic request id so two overlapping checks cannot commit out of
  // order — the response that completes second may carry the older value.
  const requestRef = useRef(0);

  const reset = useCallback(() => {
    requestRef.current++;
    setStatus('idle');
  }, []);

  const check = useCallback(
    async (number: string) => {
      const trimmed = number.trim();
      const myRequest = ++requestRef.current;
      if (!trimmed) {
        setStatus('idle');
        return;
      }
      setStatus('checking');
      const results = await searchProjects(trimmed);
      // A later check or reset wins.
      if (myRequest !== requestRef.current) return;
      // A failed lookup proves nothing: no verdict (AC-478).
      if (results === null) setStatus('idle');
      else setStatus(results.some((p) => p.number === trimmed) ? 'taken' : 'available');
    },
    [searchProjects],
  );

  return { status, check, reset };
}
