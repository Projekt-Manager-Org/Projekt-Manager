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

export type Role =
  | 'owner'
  | 'office'
  | 'worker'
  | 'bookkeeper'
  // Test-only fixture role. Real users never hold this — the seed
  // never mints it, the auth UI never offers it. It exists so the
  // integration suite can isolate gate semantics no production role
  // exercises: AC-255 needs a `data:restore`-only caller, but no
  // production role holds `data:restore` without `attachment:write`.
  // Listed here (not in a separate registry) so the role-permission
  // map stays the single source of truth.
  | '__test_data_restore_only';

/**
 * Single-source classification of every `Role` (AC-343). A new `Role`
 * variant forces an update to this map — otherwise `tsc` errors with a
 * missing key — mirroring `ROLE_CLASSIFICATION` in
 * `src/server/repositories/scope.ts`. `ROLE_KEYS` (src/config/roleKeys.ts)
 * and the generated permission matrix (docs/spec/api.md §14.3) both derive
 * their production-role set from this map rather than hand-listing roles.
 */
export const IS_TEST_ONLY_ROLE: Record<Role, boolean> = {
  owner: false,
  office: false,
  worker: false,
  bookkeeper: false,
  __test_data_restore_only: true,
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
  // Test-only — see the `Role` union comment above. Empty in
  // production builds (so a stray DB-direct-write of the role string
  // grants nothing); the one production-relevant permission is added
  // by the `TEST_ROLE_PERMISSIONS` overlay below when running under
  // `NODE_ENV=test`. Splitting prod and test maps this way keeps the
  // single-`Role`-union, single-source-of-truth shape while ensuring
  // the role can never accidentally grant `data:restore` outside the
  // test harness.
  __test_data_restore_only: [],
};

/**
 * Test-only overlay applied when the process is running under Vitest
 * (`NODE_ENV=test`). The pattern mirrors the existing build-mode
 * branches at `src/server/start.ts:79` and `src/server/seed.ts:14`,
 * which key off `process.env.NODE_ENV === 'production'` for safety
 * checks. Read once at module-load — the integration test harness
 * sets `NODE_ENV=test` before any module that imports this file is
 * evaluated.
 */
const TEST_ROLE_PERMISSIONS: Partial<Record<Role, readonly Permission[]>> = {
  __test_data_restore_only: ['data:restore'],
};

const IS_TEST_BUILD = process.env.NODE_ENV === 'test';

export function hasPermission(roles: string[], permission: Permission): boolean {
  return roles.some((role) => {
    const role_ = role as Role;
    const baseline = ROLE_PERMISSIONS[role_];
    if (baseline?.includes(permission)) return true;
    if (IS_TEST_BUILD) {
      const overlay = TEST_ROLE_PERMISSIONS[role_];
      if (overlay?.includes(permission)) return true;
    }
    return false;
  });
}

/**
 * Effective permission check for service-layer gates. Resolves through the
 * caller's role set, identical to a direct `hasPermission(caller.roles, p)`
 * call.
 *
 * Structural input type avoids importing `AuthUser` (which lives in the
 * server-side `middleware/auth.ts`) into this client-shared config module.
 */
export function callerHasPermission(caller: { roles: string[] }, permission: Permission): boolean {
  return hasPermission(caller.roles, permission);
}
