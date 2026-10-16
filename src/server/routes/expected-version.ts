/**
 * `expectedVersion` — the row version a versioned operation's edit
 * started from (data-model.md §6.4). Required on every such route;
 * a missing value is a 422 before any lookup (AC-377).
 */
export const EXPECTED_VERSION_SCHEMA = { type: 'integer', minimum: 1 } as const;
