/**
 * Storage usage read service — global roll-up.
 *
 * Surfaces the `project_storage_usage` side table maintained by the
 * two PL/pgSQL triggers (totals: data-model.md §5.14; design at
 * `projectStorageUsage` in schema.ts). Pure read path; no writes,
 * no audit boundary, no caching layer.
 *
 * Two responsibilities:
 *   - global roll-up summed across every project, including archived
 *     ones (AC-447);
 *   - shape coercion from the bigint columns (returned as strings on
 *     the default pg driver) into the API's `number` byte counts.
 */

import type { Database } from '../db/connection.js';
import { sumStorageUsage } from '../repositories/attachment.js';

/**
 * API-facing shape (totals: data-model.md §5.14). Each
 * leaf is a non-negative integer count of bytes; matching bucket name
 * matches the row `status` it summarises.
 */
export interface StorageUsageDto {
  ready: { plaintext: number; ciphertext: number };
  hidden: { plaintext: number; ciphertext: number };
}

export class StorageUsageService {
  constructor(private readonly db: Database) {}

  /**
   * Global usage summed across every project — including archived
   * (ADR-0017) projects whose attachments
   * still ride object storage. api.md §14.3 puts the gate at `data:export`
   * (route layer); this method is gate-agnostic.
   *
   * `COALESCE(SUM(...), 0)` handles the empty-table case in the SQL
   * layer — the query always returns exactly one row, so there's no
   * row-missing branch to handle here: no attachments read as zeros.
   */
  async getGlobalUsage(): Promise<StorageUsageDto> {
    const row = await sumStorageUsage(this.db);
    return {
      ready: {
        plaintext: Number(row.ready_plain),
        ciphertext: Number(row.ready_cipher),
      },
      hidden: {
        plaintext: Number(row.hidden_plain),
        ciphertext: Number(row.hidden_cipher),
      },
    };
  }
}
