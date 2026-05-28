/**
 * Audit service — read-only surface (api.md §14.2.8).
 *
 * Responsibilities:
 *  - Delegate scoped reads to the audit repository.
 *  - Apply response shaping:
 *      - `actorDisplayName` exposed on user-actor rows only.
 *      - `actorReason` exposed on system-actor rows (required for AC-178
 *        bootstrap visibility).
 *      - `payload` exposed as-is.
 *
 * Only owner and office reach this surface under the current permission
 * matrix. An earlier revision shaped responses per role (worker
 * non-self-authored rows stripped payload + actorId); that carve-out
 * was removed when workers lost `audit:read`.
 *
 * Wire shape: camelCase keys, matching `data-model.md §5.10` and every
 * other API on this server.
 */

import type { Database } from '../db/connection.js';
import type { AuthUser } from '../middleware/auth.js';
import {
  listAuditEntries as listAuditEntriesRepo,
  getAuditEntry as getAuditEntryRepo,
  type AuditRow,
  type ListAuditOpts,
} from '../repositories/audit.js';
import { isOutOfScope } from '../repositories/scope.js';
import { AUDIT_ENTITY_TYPES, type AuditEntityType } from '../db/schema.js';
import { AUDIT_ACTION_KEYS, type AuditAction } from '../../config/auditActionLabels.js';

// Re-exported from the service module so route-layer schema validation
// can pin the enum without bypassing the services→repositories/db
// boundary lint rule. The canonical definition lives in `db/schema.ts`
// (data-model.md §5.10); this is a type-safe forwarding.
export { AUDIT_ENTITY_TYPES };
export type { AuditEntityType } from '../db/schema.js';

/**
 * The action vocabulary pinned by data-model.md §5.10. The canonical
 * definition lives in `src/config/auditActionLabels.ts` — the config
 * layer is the only module both the server and the UI may import from
 * (architecture.md §11.2), and collocating the vocabulary with its
 * German labels prevents the two sides from drifting. We re-export
 * under the legacy `AUDIT_ACTIONS` name so downstream callers (route
 * schemas, tests) keep compiling while the single-source move lands.
 */
export const AUDIT_ACTIONS = AUDIT_ACTION_KEYS;
export type { AuditAction };

/**
 * The API-facing audit entry shape per `data-model.md §5.10`.
 *
 * `actorDisplayName` and `payload` are conditionally present per role
 * (see class doc). Absent fields are represented as `null`, not omitted,
 * so a typed client sees a stable key set across roles.
 */
export interface AuditEntry {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorKind: 'user' | 'system';
  actorReason: string | null;
  actorDisplayName: string | null;
  entityType: AuditEntityType;
  entityId: string;
  /** Snapshot of the entity's human-readable label at write time. */
  entityLabel: string | null;
  /**
   * Snapshot of the parent project's human-readable label at write time
   * (architecture.md §11.12). Null for top-level entities (`customer`,
   * `user`, `company_profile`, `data_import`). Powers the activity dock's
   * single-line row (AC-339) and the global Aktivität view's `Projekt`
   * column (AC-342) without a runtime JOIN against `projects`.
   */
  ancestorEntityLabel: string | null;
  action: string;
  payload: unknown | null;
  correlationId: string | null;
}

type AuditGetResult =
  | { status: 'found'; entry: AuditEntry }
  | { status: 'forbidden' }
  | { status: 'not-found' };

export class AuditService {
  constructor(private db: Database) {}

  async list(
    caller: AuthUser,
    opts: ListAuditOpts,
  ): Promise<{ data: AuditEntry[]; total: number }> {
    const { rows, total } = await listAuditEntriesRepo(this.db, caller, opts);
    return { data: rows.map(shapeEntry), total };
  }

  async get(caller: AuthUser, id: string): Promise<AuditGetResult> {
    const result = await getAuditEntryRepo(this.db, caller, id);
    if (result === null) return { status: 'not-found' };
    if (isOutOfScope(result)) return { status: 'forbidden' };
    return { status: 'found', entry: shapeEntry(result) };
  }
}

function shapeEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actorId: row.actorId,
    actorKind: row.actorKind,
    actorReason: row.actorReason,
    // Display name applies only to user-actor rows. System rows rely on
    // actorReason for reader context (AC-178).
    actorDisplayName: row.actorKind === 'user' ? row.actorDisplayName : null,
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    ancestorEntityLabel: row.ancestorEntityLabel,
    action: row.action,
    payload: row.payload,
    correlationId: row.correlationId,
  };
}
