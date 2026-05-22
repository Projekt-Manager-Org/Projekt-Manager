# ADR-0018: Data persistence and recovery — layered strategy

- **Status:** Accepted
- **Date:** 2026-04-15 (Layer 3 status update 2026-04-29; Layer 1 content set expanded 2026-05-22)
- **Confidence:** High

> **2026-05-22 update — Layer 1 content set expanded.** The envelope now carries all user-meaningful business state (issue [#230](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/230)): `users`, `company_profile`, `invoices`, and `invoice_sequence` join the existing `customers` / `projects` / `project_workers` / `attachments`. `customers.ustId` (pre-existing schema drift) now round-trips. `SCHEMA_VERSION` bumped from `2` to `3`; pre-#230 envelopes are rejected outright via `SCHEMA_VERSION_MISMATCH`. The **layer-separation invariant is unchanged** — Layer 1 is still not DR; Layer 2 ([ADR-0020](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)) remains the cadence-driven durability layer. The "Users excluded" bullet in **Decision** below is superseded by the expanded content set described in [data-model.md §5.8](../spec/data-model.md#58-export-envelope) and [api.md §14.2.4](../spec/api.md#1424-unified-data-exchange).

> **2026-04-29 update — Layer 3 is operational.** Binary attachments ship on Backblaze B2 per [ADR-0022](0022-binary-storage-b2-compliance-object-lock.md) (versioning + Compliance Object Lock + capability split). The "aspirational … gated on that work" framing in **Context** and **Consequences §Negative** below is preserved as-of-decision for context but no longer reflects reality. End-to-end encryption of B2 binaries remains open future work — see [DATA.md § Layer 3](../../DATA.md#layer-3--binary-attachments-provider-enforced-durability).

## Context

The kickoff commits to automated database backup (line 72) but declares "a backup concept and system beyond that" out of scope (line 80). Iteration 7 forces the open question: what "backup" actually means here, and how it relates to the test-seeding path that currently bypasses the API.

Three classes of data with different properties:

1. **Business data** — customers, projects, assignments, archive state. Structured, small, strict-schema, portable as text.
2. **Full DB state** — everything SQL persists, including users and sessions. Byte-exact. The DR anchor.
3. **Binary attachments** — photos, Aufmaß, uploads. Large, opaque. Durability is a storage-layer property.

Further constraints:

- **"Data loss is inevitable"** — an unrestored backup is not a backup. Restore must be continuously verified.
- **No backwards-compatibility work** — shims, format migrations, deprecated wrappers are tech debt.
- **VPN-first threat model** (ADR-0008) — accidents and misconfiguration dominate; targeted attack is out of scope.
- **B2 as binary store** ([ADR-0022](0022-binary-storage-b2-compliance-object-lock.md), #45) — not yet integrated; this decision must not assume it.
- **Existing per-entity bulk endpoints** — partial, ad-hoc, overlapping with the goals here.

## Decision

Treat persistence and recovery as **three independent layers**, each with its own scope, tooling, and restore verification:

| Layer                         | Captures                                                                                                                                     | Trigger                                 | Restore                                                          | Verification                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Business data (app-level)** | Users, company profile, customers, projects, assignments, invoices, invoice-sequence counters, attachment metadata (archive state preserved) | Human via UI (`data:export` permission) | Unified import endpoint (`data:restore`), restore-only semantics | CI roundtrip: seed → export → wipe → import → export → byte-compare   |
| **Full DB state**             | Everything in PostgreSQL                                                                                                                     | Scheduled `pg_dump` on the VPS          | `pg_restore`                                                     | Scheduled job restores into ephemeral DB, asserts schema + row counts |
| **Binary attachments**        | Uploaded files                                                                                                                               | Continuous, storage-provider-owned      | Provider restore mechanics                                       | Provider durability SLA + documented deployment requirements          |

Business-data layer specifics:

- **Single unified endpoint** (`GET /api/export`, `POST /api/import`) — per-entity endpoints removed.
- **Restore-only** import: empty target → proceed; non-empty → refuse unless an explicit override flag is set (dev ergonomics). IDs preserved. All-or-nothing single transaction.
- **Strict schema versioning**: export writes a monotonic `schema_version`; import rejects any mismatch. **No data-format migration code.** Cross-version imports, if ever needed, get a one-off script at that moment.
- **Dry-run mode** on import: full validation and preview, no writes.
- **Content set — all user-meaningful business state.** The envelope carries `users` (including `passwordHash`), `company_profile` (singleton), `customers`, `projects`, `project_workers`, `invoices`, `invoice_sequence`, and `attachments` (metadata-only descriptors — bytes ride the takeout zip per the bullet below). Ephemeral / derived / device-tied / instance-bound tables stay out: `sessions`, `push_subscriptions`, `project_storage_usage`, `meta_backup_status`, `notification_rule`, `audit_log`. Admin bootstrap ([ADR-0010](0010-first-run-admin-bootstrap.md)) remains the fresh-install path when no envelope is loaded; test seeding still uses a direct-DB helper confined to the test layer.
- **Attachments — metadata-only descriptor on the envelope; bytes round-trip via the takeout zip.** The attachments slot on the export envelope carries identity + reachability fields only (`id`, `projectId`, `kind`, `label`, `fileName`, `mimeType`, `sizeBytes`, `createdAt`, `createdBy`); the wrapped-DEK envelopes, the version discriminator, opaque storage keys, and ciphertext sizes do NOT ride the envelope. Plaintext bytes ride alongside as zip entries in the [Export](../spec/ui/daten.md#8111-export) takeout artifact and are restored by the browser orchestrator running the standard `init` (with `restore` block) + presigned PUT + `complete` pipeline against the importing instance — keeping the VPS out of the bulk-plaintext data path per [ADR-0024](0024-binary-attachment-e2e-encryption.md). The text-leg `/api/import` never inserts attachment rows.

The three layers are **complementary, not substitutes.** App-level export is not DR (omits sessions, schema state, indices, derived/instance-bound rows; round-trip is via the application's validators, not a byte-exact snapshot). `pg_dump` is not portability (encodes postgres internals). Binary durability belongs to storage.

## Alternatives Considered

### A single unified backup system

One tool, one artifact, everything. Ruled out: conflates three incompatible data shapes and matches exactly what the kickoff declares out of scope. Also reinvents solutions for problems already handled by existing tools (`pg_dump`, object-storage versioning).

### `pg_dump` as the only strategy

One byte-exact path. Ruled out: no portability between installations, no human-readable test fixtures, leaves the "test data must exercise the API" concern (#90) unaddressed.

### App-level export as the only strategy

Portable and human-readable. Ruled out: cannot capture schema, indices, sequence state, or anything outside domain entities. Portability, not DR.

### Per-entity endpoints kept alongside unified

Keep `/api/export/projects`, `/api/export/customers`, etc. and layer the unified endpoint on top. Ruled out: foreign-system adapters are out of scope, and two shapes (enriched DTO vs. row-fidelity unified) multiply surface area without a concrete beneficiary. Consistent with the no-bw-compat rule.

### App-level data-format migrations

Versioned export with translation code bridging old formats. Ruled out: speculative complexity for a pre-production project with no historical exports that matter. Strict-version rejection preserves the option of a one-off script if production ever demands it.

## Consequences

### Positive

- Each layer uses the right tool for its data shape — no invented machinery.
- Restore is continuously verified at the app level via a CI roundtrip; the test-seed path and the backup path become the same path, exercised every build.
- Strict schema versioning plus no migration code keeps maintenance surface near zero.
- Restore-only semantics make atomicity trivial and eliminate the merge/conflict design space.
- Business-data portability becomes a first-class documented capability (new installations, local dev reset, fixture-driven tests) without claiming to be DR.
- `seed.ts` aligns with the application layer, closing the gap where tests bypassed validation.

### Negative

- Three layers mean three operational stories. A fresh-install operator must learn which layer handles what.
- DB dump kept on the same VPS is a single-site risk — offsite replication is the deployment operator's responsibility.
- Restore-only cannot update a live dataset in place. Partial-data updates remain the CRUD API's job; deliberate.
- Removing per-entity endpoints is a breaking change on paper. No consumers, zero impact, but a large diff.
- Binary-layer durability depends on a storage provider (B2 per [ADR-0022](0022-binary-storage-b2-compliance-object-lock.md), #45) not yet integrated. Binary layer is aspirational until then; the decision stands but implementation is gated on that work.

## References

- [Kickoff](../project/kickoff.md) — line 72 (automated DB backup as goal), line 80 (backup-system expansion as non-goal)
- [ADR-0008](0008-vpn-first-network-access.md) — VPN-first threat model
- [ADR-0010](0010-first-run-admin-bootstrap.md) — how the first user is created on fresh installs absent a loaded envelope
- Issue [#230](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/230) — Layer 1 content set expanded to all user-meaningful business state (see top-of-doc 2026-05-22 update)
- [ADR-0017](0017-soft-delete-as-board-archive.md) — archived rows are business data and must round-trip
- Issue [#90](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/90) — seed.ts replacement and the "export all" open question
- Issue [#46](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/46) — DB-level backup + monitoring (second-layer tracker)
- Issue [#45](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/45) — B2 binary storage integration (third-layer tracker); see [ADR-0022](0022-binary-storage-b2-compliance-object-lock.md)
- Issue [#105](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/105) — role-scoped views; this ADR commits to `data:export` and introduces `data:restore`
