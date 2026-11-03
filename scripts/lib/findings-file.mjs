// Writes a gate's keys per the FINDINGS_FILE contract
// (.github/actions/upload-findings). A gate that exits 2 must not call this.
import { writeFileSync } from 'node:fs';

/** @param {string[][]} keys */
export function writeFindingsFile(keys) {
  const file = process.env.FINDINGS_FILE;
  if (!file) return;
  const lines = [...new Set(keys.map((k) => k.join('\t')))].sort();
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
}
