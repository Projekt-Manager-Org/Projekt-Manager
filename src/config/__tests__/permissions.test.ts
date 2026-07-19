/**
 * Unit coverage for AC-343 (docs/spec/verification.md §15.7): `ROLE_KEYS`
 * must track `IS_TEST_ONLY_ROLE`'s classification rather than being
 * hand-listed, so production-vs-test-only status has exactly one source.
 * `IS_TEST_ONLY_ROLE` is exhaustive over `Role` by construction
 * (`Record<Role, boolean>` — tsc rejects a missing key); that guarantee is
 * not re-tested here.
 *
 * The first test below proves any future change to `IS_TEST_ONLY_ROLE`'s
 * classification is reflected in `ROLE_KEYS` — it recomputes the expected
 * set from `IS_TEST_ONLY_ROLE` at test time, so it fails the moment the two
 * fall out of sync. It does not by itself prove today's `roleKeys.ts` is
 * mechanically derived rather than a hand-list that happens to match —
 * that's confirmed by code review of the implementation.
 */
import { describe, it, expect } from 'vitest';
import { IS_TEST_ONLY_ROLE, type Role } from '@/config/permissions';
import { ROLE_KEYS } from '@/config/roleKeys';

describe('ROLE_KEYS derivation (AC-343)', () => {
  it('stays in sync with IS_TEST_ONLY_ROLE classification', () => {
    const derived = (Object.keys(IS_TEST_ONLY_ROLE) as Role[]).filter(
      (role) => !IS_TEST_ONLY_ROLE[role],
    );
    expect(ROLE_KEYS).toEqual(derived);
  });

  it('pins the exact production role set and order', () => {
    // Order matters for the UI role selector (NotificationRuleForm), which
    // renders ROLE_KEYS in array order. The notification-rule validator
    // only checks membership (`new Set(ROLE_KEYS)`), so it doesn't care
    // about order — but a role missing from this array is invisible to
    // both consumers.
    expect(ROLE_KEYS).toEqual(['owner', 'office', 'worker', 'bookkeeper']);
  });
});
