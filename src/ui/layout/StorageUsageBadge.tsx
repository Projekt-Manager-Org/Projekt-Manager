/**
 * Footer storage badge (spec ui/index.md §8.1.2, AC-448, AC-449).
 *
 * Surfaces the total visible plaintext footprint of project data to
 * `data:export` holders (owner / office). The hover tooltip carries the
 * two-bucket breakdown — `Sichtbar` (ready.plaintext) and
 * `Im Papierkorb` (hidden.plaintext). Ciphertext bytes are operator /
 * billing concerns and never reach this surface.
 *
 * Permission gate runs BEFORE the store subscription so a worker /
 * bookkeeper render does not fetch the gated read endpoint at all
 * (defence in depth on top of the server's 403; the early return keeps
 * the network quiet).
 *
 * Tooltip posture mirrors `BackupBadge` — the `title` attribute on the
 * badge element is the desktop hover surface. The DatenView row instead
 * exposes both buckets inline because there is no hover on touch.
 */
import { useEffect } from 'react';
import { STRINGS } from '@/config/strings';
import { usePermission } from '@/hooks/usePermission';
import { useStorageUsageStore } from '@/state/storageUsageStore';
import { formatBytes } from '@/ui/utils/formatBytes';
import styles from './Footer.module.css';

export function StorageUsageBadge() {
  const canExport = usePermission('data:export');
  const data = useStorageUsageStore((s) => s.data);

  useEffect(() => {
    if (!canExport) return;
    const unsub = useStorageUsageStore.getState().subscribe();
    return unsub;
  }, [canExport]);

  if (!canExport) return null;
  if (!data) return null;

  const readyText = formatBytes(data.ready.plaintext);
  const hiddenText = formatBytes(data.hidden.plaintext);
  const tooltip = `${STRINGS.layout.storageBucketReady}: ${readyText} · ${STRINGS.layout.storageBucketHidden}: ${hiddenText}`;

  return (
    <span className={styles.storageBadge} data-testid="storage-usage-badge" title={tooltip}>
      {STRINGS.layout.storageBadgeLabel}{' '}
      <span data-testid="storage-usage-badge-value">{readyText}</span>
      {/* DOM tooltip in addition to the native `title` — Playwright
          asserts a visible-on-hover element with this test-id, while
          the unit test pins the native `title` attribute. CSS shows
          this element on `.storageBadge:hover`. Two surfaces with the
          same content; native tooltip has a delay, this one is
          instant. */}
      <span className={styles.storageBadgeTooltip} data-testid="storage-usage-badge-tooltip">
        <span>
          {STRINGS.layout.storageBucketReady}: {readyText}
        </span>
        <span>
          {STRINGS.layout.storageBucketHidden}: {hiddenText}
        </span>
      </span>
    </span>
  );
}
