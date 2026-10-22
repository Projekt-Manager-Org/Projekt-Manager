/**
 * Single source of truth for byte rendering across the Footer storage
 * badge ([ui/index.md §8.1.2]), the DatenView storage row
 * ([ui/daten.md §8.11.3]), and the Export / Import progress readouts.
 *
 * Contract pinned by AC-451:
 *   - Power-of-1024 thresholds at every tier break.
 *   - Integer precision at the B and KB tiers.
 *   - Two decimals after a German decimal comma at the MB and GB tiers
 *     (`.toFixed(2)` — preserves the trailing zero so 1.5 MB renders as
 *     `1,50 MB`).
 *   - Pure / locale-insensitive: no `Intl.NumberFormat`, no `Date.now()`.
 *     The comma is hard-coded, so output does not depend on the runner.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${twoDecimals(bytes / (1024 * 1024))} MB`;
  return `${twoDecimals(bytes / (1024 * 1024 * 1024))} GB`;
}

function twoDecimals(value: number): string {
  return value.toFixed(2).replace('.', ',');
}
