# ADR-0017: Project soft-delete as board archive, not audit trail

- **Status:** Accepted
- **Date:** 2026-04-13
- **Confidence:** High

## Context

The data model carries a soft-delete flag (`projects.deleted = true`) that hides rows from active views while keeping them queryable. Whether that flag means "indelible audit record" or "reversible archive" governs how related destructive operations (customer deletion, per-project hard-delete) must behave.

Three forces:

1. **No regulatory driver** mandates immutable project records. Small-business tool, not a regulated system of record.
2. **Archiving's real use case is board hygiene.** A contractor completing many jobs per year accumulates a long scroll in the `erledigt` Kanban column. Completed projects must leave the board while remaining queryable (e.g., a customer calls back about a job from last year).
3. **Hard-delete's real use case is data correction.** Typos, duplicates, test rows, per-project privacy erasure — possible without destroying an entire customer relationship.

Lifecycle: active → terminal (`erledigt`) → archived (off-board, queryable) → optionally purged.

## Decision

Soft-delete means **"archive from board"** — reversible in principle, no immutability guarantee, not an audit trail. Three destructive paths plus one recovery path, each with an explicit scope.

### 1. Archive (soft-delete) and Restore

Default "delete project" action. Sets `projects.deleted = true`, removing the project from active views (Kanban, default lists, exports). The management view exposes `Archivierte einblenden` to re-include archived rows. Archived projects stay tied to their customer.

The inverse — **Restore** — is exposed via `POST /api/projects/:id/restore` and a `Wiederherstellen` button on the read-only archived-project preview. Restore flips `deleted` back to `false` and returns the now-active project. It reuses `project:delete` so the same role that archived can recover from a fat-finger; the original draft of this ADR forbade the affordance ("no real-world driver"), but introducing the read-only preview surface gave the driver a concrete shape: a user landing on an archived project naturally wants the inverse of the action that put it there.

### 2. Customer deletion cascade

Owner-only. `DELETE /api/customers/:id`:

- Customer has any **active** (non-archived) projects → 409 Conflict.
- Customer has only **archived** projects (or none) → succeeds and atomically purges all archived projects of that customer in one transaction.

`GET /api/customers/:id` returns `archivedProjectCount` so the UI can surface a destruction warning before confirmation.

### 3. Per-project purge (hard delete)

Owner-only, gated by `project:purge`, served by `DELETE /api/projects/:id/purge`. **Two-step trash-bin pattern:** a project must already be archived (`deleted = true`) before it can be purged. Purging a non-archived project returns 409 Conflict directing the user to archive first.

Surfaced as `Endgültig löschen` on archived rows behind the `Archivierte einblenden` filter. Owner-only matches the gravity of customer deletion — irreversible, no recourse. `project_workers` rows cascade via `ON DELETE CASCADE`; nothing else references `projects.id`.

The archive-first gate makes accidents expensive: a fat-finger must pass through two consciously different UI actions. It also makes `deleted = true` the canonical "trash bin" state.

## Alternatives Considered

### Audit-trail model (indelible soft-delete)

Treat soft-deleted projects as immutable; customer deletion blocks on any referencing project, archived or not. Rejected: no regulatory driver justifies the friction, and an FK-level block has no application-level recourse for a small-business tool.

### Remove soft-delete — `erledigt` IS the archive

Drop the flag; completed projects stay in the terminal column forever. Rejected: the column grows unbounded and the board becomes unusable after years.

### Cancelled/storniert workflow state

A state for abandoned-in-progress projects, distinct from completed work. Orthogonal to this decision; can be added independently if needed.

### Single-step hard-delete (no archive-first gate)

Expose purge without requiring prior archive. Rejected: archive is cheap and reversible; hard-delete is final. A two-step gate is proportionate and matches the trash-bin mental model users know from OSes and mail clients.

### Reuse `customer:delete` for per-project purge

Rejected: purging one project has strictly narrower blast radius than deleting a customer and all their projects. A separate permission is right-sized and avoids over-granting.

## Consequences

### Positive

- Customer deletion works intuitively once projects are archived — no invisible FK block.
- The Kanban board stays clean over years of use.
- Mis-created or privacy-sensitive single projects can be removed without destroying the customer relationship.
- No pretense of audit compliance the system does not deliver.
- Archive remains queryable (management filter, exports) until purged.

### Negative

- Purging a project destroys its history (notes, assignments). Mitigated by archive-first gate + owner-only confirmation.
- Deleting a customer destroys all archived project history. Mitigated by UI warning showing `archivedProjectCount`.

## References

- [data-model.md §6.9](../spec/data-model.md) — soft-delete and purge specification.
- [verification.md](../spec/verification.md) — AC-497 (archive), AC-498 (restore), AC-499 (archived projects refuse changes), AC-91 (customer delete purges archived projects), and AC-501, AC-502, AC-503, AC-504 and AC-505 (permanent delete).
