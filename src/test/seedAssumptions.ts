/**
 * Seed and deployment-configuration assumptions — single source of truth
 * for values tests expect the running system to be configured with.
 *
 * This file is an "assumption contract": seed-produced values (usernames,
 * default password) and deployment-level configuration values (e.g. the
 * destructive-restore confirmation phrase) the test layer pins against.
 * Every assertion that depends on such a value should reference one of
 * these constants rather than hardcoding the literal. A change to the
 * producing source (`seed.ts`, config module, ...) then produces a typed
 * compiler error here — and through here in every consuming test —
 * instead of silently breaking runtime assertions across many files.
 *
 * When the producing source changes:
 *   1. Update this file to match.
 *   2. Run the full test suite.
 *   3. Fix any test that legitimately depended on the old value.
 *
 * Do NOT loosen an assertion to avoid updating a constant. The constant is
 * a typed reference to the same value the producing source uses —
 * loosening hides the coupling instead of surfacing it.
 */

/**
 * Default password for every seeded user.
 *
 * The seed hashes this string via `hashPassword('changeme')` and assigns
 * the result to every userRecord. Tests that mutate a user's password
 * (e.g. AC-52 rotates `buero`'s password) must NOT reference this
 * constant after the mutation — the constant describes the seeded state,
 * not the live state.
 */
export const SEED_DEFAULT_PASSWORD = 'changeme';

/**
 * Seeded users, keyed by role/purpose. Each entry mirrors the shape of
 * `userRecords` in `src/server/seed.ts` for the fields tests care about:
 * username, displayName, roles, active.
 *
 * Keyed by semantic label (owner/office/worker1/...) rather than by
 * username so a test reads as "log in as the owner" rather than "log in
 * as 'inhaber'" — the username becomes an implementation detail.
 *
 * `as const` is load-bearing: it makes every string a literal type, so
 * a typo on a consuming site surfaces as a TypeScript error at edit time.
 */
/**
 * Expected confirmation phrase for a destructive restore (`POST /api/import`
 * with `override=true` into a non-empty target — see `api.md §14.2.4` and
 * `verification.md AC-160`). The phrase is a `[C]` configurable value
 * (architecture.md §12.2); tests pin the default so a deployment that
 * retunes the value surfaces the divergence here instead of across many
 * scattered assertions.
 */
export const EXPECTED_RESTORE_PHRASE = 'LOESCHEN';

export const SEED_USERS = {
  owner: {
    username: 'inhaber',
    displayName: 'Thomas Berger',
    roles: ['owner'],
    active: true,
  },
  office: {
    username: 'buero',
    displayName: 'Maria Schmidt',
    roles: ['office'],
    active: true,
  },
  worker1: {
    username: 'arbeiter1',
    displayName: 'Jan Nowak',
    roles: ['worker'],
    active: true,
  },
  worker2: {
    username: 'arbeiter2',
    displayName: 'Lukas Fischer',
    roles: ['worker'],
    active: true,
  },
  bookkeeper: {
    username: 'buchhalter',
    displayName: 'Petra Weiß',
    roles: ['bookkeeper'],
    active: true,
  },
  inactive: {
    username: 'deaktiviert',
    displayName: 'Ehemaliger Mitarbeiter',
    roles: ['worker'],
    active: false,
  },
} as const;
