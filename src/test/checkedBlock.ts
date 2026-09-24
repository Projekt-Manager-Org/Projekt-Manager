/**
 * Reads a `CHECKED:<name>` block out of a tracked document: the published
 * half of a doc table that a unit test pins to the code owning it
 * (ARCHITECTURE.md § Documentation drift guards).
 *
 * Missing markers throw, so the failure names them. The equality checks
 * built on this would fail on an empty block too, but as a diff against
 * the whole table.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The text between the block's START comment and its END marker. */
export function readCheckedBlock(docPath: string, name: string): string {
  const doc = readFileSync(resolve(REPO_ROOT, docPath), 'utf8');
  const start = doc.indexOf(`<!-- CHECKED:${name}:START`);
  const end = doc.indexOf(`<!-- CHECKED:${name}:END -->`);
  if (start === -1 || end < start) {
    throw new Error(`CHECKED:${name} markers not found in ${docPath}`);
  }
  return doc.slice(doc.indexOf('-->', start) + '-->'.length, end);
}

/** Body rows of the block's Markdown table, one trimmed string per cell. */
export function tableRows(block: string): string[][] {
  return block
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2) // header and delimiter rows
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}
