export type Permission =
  | 'project:read'
  | 'project:create'
  | 'project:update'
  | 'project:delete'
  | 'project:purge'
  | 'project:transition'
  | 'project:dates'
  | 'customer:read'
  | 'customer:write'
  | 'customer:delete'
  | 'user:read'
  | 'user:manage'
  | 'user:delete'
  | 'data:export'
  | 'data:restore'
  | 'audit:read'
  | 'notifications:manage'
  | 'attachment:read'
  | 'attachment:write'
  | 'attachment:hide'
  | 'attachment:trash'
  | 'invoice:read'
  | 'invoice:write'
  | 'auth:change-password';

export type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

/**
 * Single-source classification of every `Role` (AC-343). A new `Role`
 * variant forces an update to this map — otherwise `tsc` errors with a
 * missing key — mirroring `ROLE_CLASSIFICATION` in
 * `src/server/repositories/scope.ts`. `ROLE_KEYS` (src/config/roleKeys.ts)
 * derives its production-role set from this map rather than hand-listing
 * roles, and the published permission matrix (docs/spec/api.md §14.3) is
 * checked against that set.
 */
export const IS_TEST_ONLY_ROLE: Record<Role, boolean> = {
  owner: false,
  office: false,
  worker: false,
  bookkeeper: false,
};

// data:export gates the unified business-data export (api.md §14.2.4).
// data:restore gates the unified import — owner-only because a restore
// replaces all business data in a single transaction (api.md §14.3).
//
// audit:read gates the audit surface (api.md §14.2.8). Owner and office
// hold it; worker and bookkeeper do not. The destructive-action predicate
// in scope.ts narrows office-visible rows further (purges, user deletes,
// roles mutations are owner-only). The reachability predicate for workers
// was dropped when workers lost audit:read — the audit surface is
// administrative, not worker-facing, and a scoped-worker view never got
// meaningful daily use.
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    'project:read',
    'project:create',
    'project:update',
    'project:delete',
    'project:purge',
    'project:transition',
    'project:dates',
    'customer:read',
    'customer:write',
    'customer:delete',
    'user:read',
    'user:manage',
    'user:delete',
    'data:export',
    'data:restore',
    'audit:read',
    // notifications:manage aligns with user:manage as an admin-only gate
    // (api.md §14.3, ADR-0023). Rule edits change who-sees-what platform-
    // wide, so the least-privilege baseline is owner only.
    'notifications:manage',
    'attachment:read',
    'attachment:write',
    'attachment:hide',
    // attachment:trash gates the Papierkorb (list hidden + restore).
    // Owner + office only — workers can hide their own uploads inside
    // the AC-215 grace window but do not browse or restore the trash.
    // Bookkeepers are read-only on attachments.
    'attachment:trash',
    // invoice:read / invoice:write — ADR-0026. Owner + office hold
    // write; owner / office / bookkeeper hold read. Worker holds
    // neither — the repository-predicate scope (ADR-0019) returns
    // the empty set for invoices on the worker role (no
    // project_worker scope path), so worker exclusion is structural.
    'invoice:read',
    'invoice:write',
    'auth:change-password',
  ],
  office: [
    'project:read',
    'project:create',
    'project:update',
    'project:delete',
    'project:transition',
    'project:dates',
    'customer:read',
    'customer:write',
    'user:read',
    'data:export',
    'audit:read',
    'attachment:read',
    'attachment:write',
    'attachment:hide',
    'attachment:trash',
    'invoice:read',
    'invoice:write',
    'auth:change-password',
  ],
  worker: [
    'project:read',
    'customer:read',
    'attachment:read',
    'attachment:write',
    'attachment:hide',
    'auth:change-password',
  ],
  bookkeeper: [
    'project:read',
    'customer:read',
    'attachment:read',
    'invoice:read',
    'auth:change-password',
  ],
};

export function hasPermission(roles: string[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role as Role]?.includes(permission) ?? false);
}
