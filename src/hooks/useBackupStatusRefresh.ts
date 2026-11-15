import { useEffect } from 'react';
import { useAuthStore } from '@/state/authStore';

const POLL_INTERVAL_MS = 60_000;

/**
 * Keep the owner badge fresh without a full reload.
 *
 * The backup-status row is only written by the scheduled backup and
 * drill runs, so the natural staleness window is hours — a 60s polling cadence while the
 * tab is visible is plenty to turn "green" into "red" after an
 * incident, and the visibility-change refresh catches a laptop waking
 * from sleep.
 *
 * No-op for non-owners: their profile omits `backupStatus` (AC-614),
 * so a round-trip would just return a payload the client discards.
 * The hook piggybacks on the existing `checkSession` rather than
 * adding a narrower action — the /me response already carries
 * everything the store needs, and an extra store action is strictly
 * more surface to keep consistent.
 */
export function useBackupStatusRefresh(): void {
  const isOwner = useAuthStore((s) => s.authUser?.roles.includes('owner') ?? false);
  const checkSession = useAuthStore((s) => s.checkSession);

  useEffect(() => {
    if (!isOwner) return;
    const refresh = () => {
      if (document.hidden) return;
      void checkSession();
    };
    const intervalId = window.setInterval(refresh, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [isOwner, checkSession]);
}
