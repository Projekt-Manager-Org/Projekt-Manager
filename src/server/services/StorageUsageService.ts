/**
 * Storage usage read service — projects + global roll-up.
 *
 * Surfaces the `project_storage_usage` side table maintained by the
 * two PL/pgSQL triggers (data-model.md §5.14; design at
 * `projectStorageUsage` in schema.ts). Pure read path; no writes,
 * no audit boundary, no caching layer.
 *
 * Three responsibilities:
 *   - per-project read with three-way distinguishability
 *     (200 in-scope / 403 out-of-scope / 404 missing) per AC-264 +
 *     ADR-0019;
 *   - global roll-up summed across every project, including archived
 *     ones (AC-265);
 *   - shape coercion from the bigint columns (returned as strings on
 *     the default pg driver) into the API's `number` byte counts.
 */

import { eq, sql } from 'drizzle-orm';

import type { Database } from '../db/connection.js';
import { projects, projectStorageUsage } from '../db/schema.js';
import { isProjectInScope } from '../repositories/scope.js';
import { notFound, notPermitted } from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import type { AuthUser } from '../middleware/auth.js';

/**
 * API-facing shape pinned by api.md §14.2.12 and AC-264 / AC-265. Each
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
   * Per-project storage usage. Three-way distinguishability:
   *   - missing project id → throws `notFound` (404 NOT_FOUND);
   *   - existing-but-out-of-scope (worker on an unassigned project) →
   *     throws `notPermitted` (403 NOT_PERMITTED);
   *   - in-scope (or unscoped role) → returns the four-bucket totals.
   *
   * The existence check runs WITHOUT a `deleted = FALSE` filter, so an
   * archived project still resolves — mirrors `getProject` in
   * `project-read.ts` (read paths are intentionally permissive on
   * archived rows; mutations close them via `*ForMutation` fetches).
   */
  async getProjectUsage(caller: AuthUser, projectId: string): Promise<StorageUsageDto> {
    const projectRows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (projectRows.length === 0) {
      throw notFound(STRINGS.entities.project);
    }
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }
    const usageRows = await this.db
      .select({
        spaceReadyBytes: projectStorageUsage.spaceReadyBytes,
        spaceHiddenBytes: projectStorageUsage.spaceHiddenBytes,
        ciphertextReadyBytes: projectStorageUsage.ciphertextReadyBytes,
        ciphertextHiddenBytes: projectStorageUsage.ciphertextHiddenBytes,
      })
      .from(projectStorageUsage)
      .where(eq(projectStorageUsage.projectId, projectId))
      .limit(1);
    const row = usageRows[0];
    if (!row) {
      // Trigger invariant: the projects-INSERT trigger seeds a zero
      // row for every project (data-model.md §5.14). A missing
      // row past the existence-check above is an out-of-band drift
      // (direct SQL deletion, trigger disabled, baseline regenerated
      // without the tail). Refuse to serve rather than fabricate
      // zeros — silent zeros would mask drift that downstream UI
      // relies on the totals being authoritative for.
      throw new Error(
        `project_storage_usage row missing for project ${projectId}; trigger invariant violated`,
      );
    }
    return {
      ready: {
        plaintext: Number(row.spaceReadyBytes),
        ciphertext: Number(row.ciphertextReadyBytes),
      },
      hidden: {
        plaintext: Number(row.spaceHiddenBytes),
        ciphertext: Number(row.ciphertextHiddenBytes),
      },
    };
  }

  /**
   * Global usage summed across every project — including archived
   * (soft-deleted per data-model.md §6.9) projects whose attachments
   * still ride object storage. AC-265 pins the gate at `data:export`
   * (route layer); this method is gate-agnostic.
   *
   * `COALESCE(SUM(...), 0)` handles the empty-table case in the SQL
   * layer — the query always returns exactly one row, so there's no
   * row-missing branch to handle here (api.md §14.2.12 "Zeros when
   * there are no projects or no attachments").
   */
  async getGlobalUsage(): Promise<StorageUsageDto> {
    const r = await this.db.execute(sql`
      SELECT
        COALESCE(SUM(space_ready_bytes), 0)::bigint AS ready_plain,
        COALESCE(SUM(space_hidden_bytes), 0)::bigint AS hidden_plain,
        COALESCE(SUM(ciphertext_ready_bytes), 0)::bigint AS ready_cipher,
        COALESCE(SUM(ciphertext_hidden_bytes), 0)::bigint AS hidden_cipher
      FROM project_storage_usage
    `);
    const row = r.rows[0] as {
      ready_plain: string | number;
      hidden_plain: string | number;
      ready_cipher: string | number;
      hidden_cipher: string | number;
    };
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
