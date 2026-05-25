/**
 * Suggested filename for a full-account takeout export download —
 * `projekt-manager-export-<YYYY-MM-DD>T<HH-mm-ss>.zip` (ui/daten.md §8.11.1).
 *
 * Shared by the export dialog's ready view and the DatenView inline download
 * affordance so both surface the same name. The server does not set a
 * Content-Disposition, so this drives the `<a download>` attribute.
 */
export function exportDownloadFilename(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `projekt-manager-export-${date}T${time}.zip`;
}
