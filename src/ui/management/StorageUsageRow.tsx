/**
 * DatenView storage row (spec ui/daten.md §8.11.3).
 *
 * Mobile-first posture — both plaintext buckets render inline at all
 * times. No `title` tooltip: there is no hover on touch, so a
 * hover-only surface would be invisible on the device most users
 * reach this view from.
 *
 * Permission gate runs BEFORE the store subscription so a role without
 * `data:export` does not fetch the gated read endpoint at all
 * (defence in depth on top of the server's 403).
 *
 * Ciphertext buckets stay off this surface — those are operator /
 * billing concerns, not user-facing.
 */
import { useEffect } from 'react';
import { STRINGS } from '@/config/strings';
import { usePermission } from '@/hooks/usePermission';
import { useStorageUsageStore } from '@/state/storageUsageStore';
import { formatBytes } from '@/ui/utils/formatBytes';
import styles from './Management.module.css';

export function StorageUsageRow() {
  const canExport = usePermission('data:export');
  const data = useStorageUsageStore((s) => s.data);

  useEffect(() => {
    if (!canExport) return;
    const unsub = useStorageUsageStore.getState().subscribe();
    return unsub;
  }, [canExport]);

  if (!canExport) return null;
  if (!data) return null;

  return (
    <div className={styles.storageRow} data-testid="daten-storage-row">
      <span className={styles.storageBucket} data-testid="daten-storage-row-sichtbar">
        {STRINGS.layout.storageBucketReady}: {formatBytes(data.ready.plaintext)}
      </span>
      <span className={styles.storageBucket} data-testid="daten-storage-row-papierkorb">
        {STRINGS.layout.storageBucketHidden}: {formatBytes(data.hidden.plaintext)}
      </span>
    </div>
  );
}
