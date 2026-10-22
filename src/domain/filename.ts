/**
 * Filename builders for downloads that leave the server boundary.
 *
 * Centralised so the sanitisation rules (allowed bytes, length cap,
 * separator) stay identical across consumers — invoice PDFs, per-project
 * attachment bundles, future exports.
 *
 * Sanitisation is intentionally conservative — the filename lands on
 * arbitrary user filesystems (NTFS, ext4, APFS) and pastes into shell
 * history, ZIP central directories, and email subject lines.
 */

/**
 * Strip control bytes + path/wildcard chars, collapse whitespace to `-`,
 * dedupe runs of `-`, trim leading/trailing dots and dashes, and clip to
 * 40 chars. Empty input yields empty output — callers branch on `.length`
 * to fall back to a number-only filename.
 */
export function sanitiseFilenameSegment(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[/\\:*?"<>|]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 40)
  );
}

/**
 * Bulk-download bundle filename for a project's attachments.
 * Shape: `{number}_{titleSlug}.zip` — e.g. `P-2026-001_Malerarbeiten-Praxis-Dr-Braun.zip`.
 * Mirrors `buildInvoiceDownloadFilename` so all downloads originating
 * from a project share one naming convention.
 */
export function buildProjectBundleFilename(project: { number: string; title: string }): string {
  const titleSlug = sanitiseFilenameSegment(project.title);
  return titleSlug.length > 0 ? `${project.number}_${titleSlug}.zip` : `${project.number}.zip`;
}

/**
 * Hands out names distinct within one archive (AC-434): the first
 * `a.txt` stays, later ones become `a (2).txt`, `a (3).txt`, … — skipping
 * any suffix an earlier entry already holds verbatim.
 */
export function createDistinctNamer(): (name: string) => string {
  const taken = new Set<string>();
  return (name) => {
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let candidate = name;
    for (let n = 2; taken.has(candidate); n++) candidate = `${stem} (${n})${ext}`;
    taken.add(candidate);
    return candidate;
  };
}
