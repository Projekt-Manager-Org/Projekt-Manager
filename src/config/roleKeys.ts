/**
 * Role key catalog — single source for the server-accepted role set.
 *
 * Kept alongside `permissions.ts` so the role names referenced from
 * schema validators, notification-rule spec checks, and the UI role
 * selector share one list. Derived from `IS_TEST_ONLY_ROLE` (AC-343)
 * rather than hand-listed, so a role's production-vs-test-only status
 * has exactly one source: extending the matrix means extending
 * `IS_TEST_ONLY_ROLE` in `permissions.ts` — this array updates itself.
 */

import { IS_TEST_ONLY_ROLE, type Role } from './permissions.js';

export const ROLE_KEYS: readonly Role[] = (Object.keys(IS_TEST_ONLY_ROLE) as Role[]).filter(
  (role) => !IS_TEST_ONLY_ROLE[role],
);
