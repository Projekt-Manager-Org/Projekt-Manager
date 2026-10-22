/**
 * Single source of truth for byte rendering across the Footer storage
 * badge ([ui/index.md §8.1.2]), the DatenView storage row
 * ([ui/daten.md §8.11.3]), and the Export / Import progress readouts.
 *
 * Contract pinned by AC-451:
 *   - Power-of-1024 thresholds at every tier break.
 *   - Integer precision at the B and KB tiers.
 *   - Two decimals at the MB and GB tiers (`.toFixed(2)` — preserves the
 *     trailing zero so `1.5 MB` renders as `1.50 MB`).
 *   - Pure / locale-insensitive: no `Intl.NumberFormat`, no `Date.now()`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
