/**
 * Baseline schema-state recurrence guard — dev-side mirror of the
 * `scripts/deploy.sh` pre-flight check. Catches the Drizzle no-op trap
 * before `migrate()` pretends success and the app starts taking traffic
 * against a stale schema.
 *
 * The trap: `migrate()` decides by the journal `when`, not the hash it
 * records in `drizzle.__drizzle_migrations`. An edited
 * `0000_baseline.sql` keeps its `when`, so `migrate()` skips it — the
 * live DB stays on the previous schema while `schema.ts` and the SQL
 * describe the new one. Symptom:
 * first request that touches a new column 500s with `column "<X>" does
 * not exist`. See `docs/ops/recover-from-schema-change.md`.
 *
 * Industry analog: Flyway records each migration's checksum at apply
 * time and re-validates on every subsequent run; a mismatch is a hard
 * error. drizzle-orm does not provide this; we recreate the contract
 * here so the dev `npm run dev` and prod `deploy.sh` paths share the
 * same fail-fast semantic.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Database } from './connection.js';

/**
 * sha256 hex digest of `0000_baseline.sql` in the given folder. Mirrors
 * `drizzle-orm/migrator.js` `readMigrationFiles`, which hashes the
 * file's UTF-8 string form. For valid UTF-8 (the only encoding we ship)
 * this is byte-equivalent to hashing the raw Buffer; using `.toString()`
 * pins the contract to drizzle's exact computation rather than relying
 * on the equivalence holding across future drizzle-orm versions.
 */
export function computeBaselineFileHash(migrationsFolder: string): string {
  const baselinePath = path.join(migrationsFolder, '0000_baseline.sql');
  const content = readFileSync(baselinePath).toString();
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Walks the `cause` chain looking for a pg-style `SQLSTATE` code. drizzle-orm
 * wraps the underlying pg error in `DrizzleQueryError`, which preserves the
 * driver error on `.cause` but does not propagate `.code` to the wrapper —
 * so a naive `(err as { code }).code` always reads `undefined` and the
 * fresh-DB cases below would rethrow instead of returning null.
 */
function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  while (cur && typeof cur === 'object') {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Reads the first row of `drizzle.__drizzle_migrations` (the baseline
 * entry) and returns its hash. Returns `null` for the legitimate
 * fresh-DB shapes — the table absent (`42P01`), the schema absent
 * (`3F000`), or the table present but empty. Any other error is
 * unexpected and rethrown.
 */
export async function readRecordedBaselineHash(db: Database): Promise<string | null> {
  try {
    const result = await db.execute<{ hash: string }>(
      sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id ASC LIMIT 1`,
    );
    return result.rows[0]?.hash ?? null;
  } catch (err) {
    const code = pgErrorCode(err);
    if (code === '42P01' || code === '3F000') return null;
    throw err;
  }
}

export function buildMismatchMessage(expected: string, recorded: string): string {
  return [
    'Baseline schema mismatch — DB ledger does not match 0000_baseline.sql.',
    `  expected (file): ${expected}`,
    `  recorded (db):   ${recorded}`,
    '',
    'migrate() silently skips an edited 0000_baseline.sql (its journal',
    '`when` is unchanged). Continuing this boot would 500 on the first',
    'request that touches a new column.',
    '',
    'See docs/ops/recover-from-schema-change.md.',
  ].join('\n');
}

/**
 * Throws when the on-disk baseline file's sha256 does not match the
 * recorded ledger entry. Returns silently in the fresh-DB cases (no
 * table, no rows). Call BEFORE `migrate()` so the mismatch surfaces
 * before drizzle's no-op masks it.
 */
export async function assertBaselineLedgerMatchesFile(
  db: Database,
  migrationsFolder: string,
): Promise<void> {
  const recorded = await readRecordedBaselineHash(db);
  if (recorded === null) return;
  const expected = computeBaselineFileHash(migrationsFolder);
  if (recorded === expected) return;
  throw new Error(buildMismatchMessage(expected, recorded));
}
