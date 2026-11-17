# ADR-0021: Audit log and notifications — single write path, publisher-over-audit

- **Status:** Accepted
- **Date:** 2026-04-19
- **Confidence:** High

## Context

Iteration 8 introduces new mutation surfaces (file uploads, notifications). The Kickoff commits to a configurable notification system ([§Done when](../project/kickoff.md#done-when-final-product)). The current codebase has no unified audit trail — entities carry ad-hoc `createdBy`/`updatedBy` fields and every service method writes its own state change with no append-only record.

Forces:

- **New mutation sites arrive this iteration.** Retrofitting audit later is more expensive than routing new paths through a helper from day one.
- **Notifications need an event source.** Double-writing events at every service-layer site is a drift risk.
- **No regulatory driver.** Value is debugging, dispute resolution, and the "who did what when" view — not compliance.
- **Rebuild-over-forensics posture.** Runtime guards earn their complexity only if catch-rate outweighs the ongoing cost.

## Decision

Route every domain-entity mutation through a single transactional `mutate()` service-layer helper that writes an audit row atomically with the state change. Notifications are a projection over the audit stream via an in-process publisher. Bypass is prevented in two layers — a compile-time type gate (the primary guarantee) backed by a CI-enforced static architecture test (belt-and-braces for dynamically constructed SQL the type system cannot see). No runtime DB trigger on audited tables (see [Amendments](#amendments)).

Shape:

- **`audit_log` table**, append-only: `id`, `created_at`, `actor_id`, `actor_kind` (`user` | `system`), `actor_reason`, `entity_type`, `entity_id`, `action`, `payload` (jsonb before/after diff of changed fields), `correlation_id`. Audited entity types are defined authoritatively by `AUDIT_ENTITY_TO_TABLE` in `src/server/db/schema.ts` and [data-model.md §5.10](../spec/data-model.md#510-audit-log-entity); the set grows with new mutation surfaces (`project`, `customer`, `user`, `project_worker`, `attachment`, `invoice`, `company_profile` at present, plus the synthetic `data_import` that tags the deployment-level import-restore commit — no physical table). Authentication and session events are security events, not domain audit.
- **`mutate()` helper**: opens a transaction, runs the mutation, writes the audit row, commits. The helper returns the committed row so subscribers dispatch after commit (a throwing subscriber cannot roll back domain state). Correlation id is a typed argument through the service chain — services never import Fastify.
- **Self-preference carve-out.** `UserAccount` self-writes of UI preferences (`themePreference`, `pushMuted`) bypass `mutate()` and write directly. Rationale: per-user UI state with no cross-user consequence; routing them through audit dilutes the feed with configuration noise.
- **Type gate (primary):** repository write functions on audited tables accept only a `MutatingDatabase` — a transaction handle only `mutateInTx()` mints (`src/server/db/connection.ts`; named exceptions: [Amendments](#amendments)). A caller holding any other handle fails `tsc`, so a mutation can only be authored from inside `mutate()` / `mutateInTx()` or at a named exception. This is the integrity guarantee; the static scan below is belt-and-braces for what the type system cannot see.
- **Static architecture test (belt-and-braces),** CI-enforced: scan fails on raw `INSERT/UPDATE/DELETE` or Drizzle `db.insert/update/delete` targeting audited tables outside the helper — catching dynamically constructed SQL the type gate can't reach. Migrations, `ImportService` restore and business seed loaders are allowlisted; audit-free writes in repositories are the named exceptions ([Amendments](#amendments)).
- **Notification publisher**: in-process dispatch on commit. Subscribes to `{entity_type, action}` pairs. Non-mutation events (backup status, cron completion) publish to the same bus, bypassing audit.
- **User-facing audit view**: read-only endpoint and UI. RBAC-sliced via the same repository predicates as [ADR-0019](0019-worker-data-scoping-repository-layer-predicate.md).
- **Retention**: aligned with the DB-backup window (90 days per [ADR-0020 Amendment 2026-04-19](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#amendments)).

## Alternatives Considered

### Runtime DB trigger belt

`BEFORE INSERT/UPDATE/DELETE` rejecting any mutation without a paired audit row in the same transaction. Strongest at-rest guard. Ruled out: ongoing operational cost (migration bypass, fixture-loading complexity, schema-change mental tax) outweighs the catch-rate given a small team, code review, and the static architecture test.

### Two independent systems — audit and notifications each written directly

Ruled out: this is the double-write the helper was introduced to prevent.

### Unified `events` table serving both

Ruled out: shape mismatch (audit wants field-level diffs; notifications want rendered message data) and retention mismatch overload a single schema.

### LISTEN/NOTIFY for cross-process dispatch

Ruled out for now: single-process Fastify makes in-process sufficient. Revisit on multi-worker deployment.

### Full-row audit payloads

Ruled out: storage growth is unbounded; the diff is what both viewers and notification rules actually consume.

## Consequences

### Positive

- Single write path — no drift between audit state and entity state.
- Notifications consume a ready-made stream; new rules don't require touching every mutation site.
- User-facing activity view falls out of the same table with RBAC layered at the repository level.
- Architecture test catches bypass at PR time with zero runtime cost.
- Domain-entity scope keeps the activity feed high-signal — login traffic does not drown project transitions.

### Negative

- Architecture test is static — won't catch dynamically constructed SQL. The trigger belt would have; the cost analysis accepts this gap.
- In-process publisher is not durable across restarts. Acceptable at current scale; outbox pattern is the future migration.
- `mutate()` needs the "before" state for update payloads — adds a read on update paths that didn't have one.
- Architecture-test allowlist is a trust surface — each allowlisted path warrants PR-time scrutiny.
- **Security audit required** under [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — new persistent log of user actions, new cross-cutting helper.

## References

- [Kickoff §Done when](../project/kickoff.md#done-when-final-product) — configurable notifications
- [ADR-0019](0019-worker-data-scoping-repository-layer-predicate.md) — RBAC predicate reused for the audit view
- [ADR-0020](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) — retention window the audit table aligns to
- [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — trigger satisfied

## Amendments

### 2026-11-15 — `audit_log` append-only at the database

`audit_log` rejects UPDATE, DELETE and TRUNCATE below the services, except a user delete clearing `actor_id` and removal via `withAuditLogRemoval` (AC-642; `src/server/db/baseline/tail/60-audit-log-append-only.sql`). It guards the log, not the audited tables: the paired-audit-row belt stays ruled out. Cost: test fixtures that clear `audit_log` go through `withAuditLogRemoval`.

### 2026-11-17 — The type gate is a brand; its exceptions are named

`MutatingDatabase` was a plain transaction handle, so a write inside any transaction compiled and committed without an audit row (#938). It is now branded, and only two functions in `src/server/services/mutate.ts` mint it (tests aside): `mutateInTx()`, for its `run` callback, and `exemptFromAudit(tx, <name>)` for the named exceptions, drawn from AC-623's carve-outs:

- `pending-upload` — the pending attachment row (AC-407);
- `orphan-reap` — the reaper removing those rows (AC-407, AC-408);
- `last-login` — sign-ins;
- `self-preference` — a user's own theme or push mute (AC-659).

What `tsc` cannot see, two checks hold: `local/audit-write-gate` (`eslint-rules/audit-write-gate.mjs`; no inline comment may disable it) refuses assertions to `MutatingDatabase`, in repositories audited-table writes through any other handle, and raw-SQL writes to audited tables anywhere else; `scripts/check-audit-mutations.sh` pins each exception to its file. A new exception adds a name to `AuditExemption`, a site to `EXEMPTION_SITES` and an entry to this list.
