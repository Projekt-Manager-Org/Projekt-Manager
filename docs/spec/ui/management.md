# UI: Management Views

Sections 8.8–8.10 and 8.13 of the [product spec](../index.md) — the tabular CRUD surfaces for Projects, Customers, and Users, plus the global Audit View. Email Data Intake (§8.12) — a modal customer+project creation flow entered from a header button — is a sibling page at [email-intake.md](email-intake.md). Shell and navigation live in [index.md](index.md); cross-cutting behavioral rules (in-flight lock, error handling, mutation semantics) in [behavior.md](behavior.md).

---

## 8.8 Project Management View

A table of projects. Behavior: [verification.md §15.12](../verification.md#1512-projects).

### 8.8.1 List

- **Columns** — number, title, customer, assigned workers, status (badge in the state color), planned dates, estimated value; actions for a caller who may archive or permanently delete.
- **Order** — newest first. Every column but assigned workers sorts ([AC-494](../verification.md#1512-projects)): status in workflow order, empty values last.
- **Toolbar** — `Erstellen` (§8.8.2), `Archivierte einblenden`, off at start ([AC-492](../verification.md#1512-projects), [AC-153](../verification.md#1512-projects)), the Mitarbeiter filter ([AC-495](../verification.md#1512-projects)), search ([AC-493](../verification.md#1512-projects)).
- **Row** — opens the Project Detail Page ([AC-496](../verification.md#1512-projects)). `Archivieren` on an active row; `Endgültig löschen` on an archived one ([AC-501](../verification.md#1512-projects)).

### 8.8.2 Create Project

A form with:

- **Number** — free text, with its free / taken verdict ([AC-478](../verification.md#1512-projects), [AC-479](../verification.md#1512-projects)).
- **Title**.
- **Customer** — one of the existing customers.
- **Baustelle** — the toggle `Identisch mit Kundenadresse` over street, zip and city ([AC-483](../verification.md#1512-projects), [AC-484](../verification.md#1512-projects), [AC-485](../verification.md#1512-projects), [AC-486](../verification.md#1512-projects), [AC-487](../verification.md#1512-projects), [AC-488](../verification.md#1512-projects)).

Behavior: [AC-475](../verification.md#1512-projects), [AC-476](../verification.md#1512-projects).

---

## 8.9 Customer Management View

A table of customers. Behavior: [verification.md §15.11](../verification.md#1511-customer-management).

### 8.9.1 List

- **Columns** — name, phone, email, city; an action for a caller who may delete.
- **Order** — by name. Every column sorts ([AC-525](../verification.md#1511-customer-management)), empty values last.
- **Toolbar** — `Erstellen` (§8.9.2), search ([AC-524](../verification.md#1511-customer-management)).
- **Row** — opens the edit form (§8.9.3, [AC-526](../verification.md#1511-customer-management)). `Löschen` per §8.9.5.

### 8.9.2 Create Customer

A form with:

- **Name** — with the list of existing customers matching it ([AC-527](../verification.md#1511-customer-management), [AC-528](../verification.md#1511-customer-management), [AC-529](../verification.md#1511-customer-management)).
- **Street, zip, city**.
- **Phone, email**.
- **USt-IdNr., notes** ([AC-522](../verification.md#1511-customer-management)).

Fields: [data-model.md §5.6](../data-model.md#56-customer-entity). Behavior: [AC-518](../verification.md#1511-customer-management), [AC-539](../verification.md#1511-customer-management), [AC-520](../verification.md#1511-customer-management), [AC-537](../verification.md#1511-customer-management), [AC-538](../verification.md#1511-customer-management), [AC-521](../verification.md#1511-customer-management), [AC-536](../verification.md#1511-customer-management).

### 8.9.3 Edit Customer

The same fields with the customer's values, reached from a row or the Project Detail Page. Without `customer:write` every field is read-only and no save is offered ([AC-121](../verification.md#1521-role-scoping)). Behavior: [AC-519](../verification.md#1511-customer-management), [AC-520](../verification.md#1511-customer-management), [AC-537](../verification.md#1511-customer-management), [AC-538](../verification.md#1511-customer-management), [AC-521](../verification.md#1511-customer-management).

### 8.9.5 Delete Customer

`Löschen` on a row, for a caller who may delete. A confirmation names the customer, or warns about its archived projects ([AC-534](../verification.md#1511-customer-management), [AC-535](../verification.md#1511-customer-management), [AC-533](../verification.md#1511-customer-management)). Behavior: [AC-530](../verification.md#1511-customer-management), [AC-531](../verification.md#1511-customer-management), [AC-540](../verification.md#1511-customer-management), [AC-541](../verification.md#1511-customer-management), [AC-92](../verification.md#1511-customer-management), [AC-532](../verification.md#1511-customer-management).

---

## 8.10 User Management View

An administrative view for managing user accounts. Only accessible to users with `user:manage` permission (owner only under the default role set — matches the nav matrix in [index.md §8.7.1](index.md#871-views)). Hidden from navigation for users without this permission. Office and other roles that hold only `user:read` (for dropdown lookups, not administration) are not admitted — server-side listing via `GET /api/users` remains gated on `user:read` independently.

### 8.10.1 List

- Columns: display name, username, roles (as badges), email, active status indicator, last login.
- Shows all users including deactivated ones. Deactivated users are visually distinct.

### 8.10.2 Create User

Accessible via a primary action button. Requires `user:manage` permission (button hidden otherwise).

Fields:

- **Username** — required, unique, immutable after creation.
- **Display name** — required.
- **Password** — required. Must meet the configured password policy **[C]**. Includes a confirmation field; submission is blocked until both entries match.
- **Roles** — required. Multi-select from the configured role set **[C]**.
- **Email** — optional.

### 8.10.3 Edit User

Clicking a user row opens the user for editing. Editable fields: display name, roles, email. Username is read-only.

Password is not part of the edit form — password reset uses a dedicated operation ([§8.10.5](#8105-reset-password)).

Requires `user:manage` permission for mutations.

### 8.10.4 Deactivate / Reactivate

Available as a row action or within the edit view. Requires `user:manage` permission.

- **Deactivate**: confirmation dialog. Self-deactivation is rejected by the API; the UI should prevent it.
- **Reactivate**: confirmation dialog.

### 8.10.5 Reset Password

Available as a row action or within the edit view. Opens a form with new password plus confirmation. Must meet the configured password policy.

Administrative action — does not require the target user's current password. Invalidates all of the target user's sessions.

Requires `user:manage` permission.

### 8.10.6 Delete User

Available within the user detail view. Confirmation dialog. Self-deletion is prevented (button hidden for the authenticated user's own record; API rejects if attempted). Hard-deletes the user and cascades related data (sessions, worker assignments).

Deletion of a user referenced by an issued or cancelled invoice is rejected with `USER_HAS_INVOICES` ([api.md §14.4](../api.md#144-error-handling)); the user list surfaces the German message, which points to deactivation, via the mutation error banner ([§8.10.4](#8104-deactivate--reactivate)).

Requires `user:delete` permission (owner only).

---

## 8.13 Audit View

A global, read-only tabular view of the `audit_log` ([data-model.md §5.10](../data-model.md#510-audit-log-entity)). Backed by [api.md §14.2.8](../api.md#1428-audit-log). Available to every caller holding `audit:read`; the per-role visible row set is narrowed server-side via the scope predicates — clients do not filter audit rows.

Navigation: exposed via the shell navigation matrix ([index.md §8.7.1](index.md#871-views)) as the `Aktivität` tab. Access is gated on `audit:read`, held by owner and office under the default matrix. Worker and bookkeeper do not hold `audit:read` and do not see the tab. The tab is hidden for users without the permission.

### 8.13.1 List

- Default view shows only events the caller is a recipient of per the resolved notification-rule set ([data-model.md §5.11](../data-model.md#511-notification-rule)). A `"Alles anzeigen"` toggle switches to the full RBAC-scoped feed (governed by `audit:read` and the destructive-action predicate per §8.13.3). Toggle state is local-only; navigation or reload restores the default. RBAC scoping ([ADR-0019](../../adr/0019-worker-data-scoping-repository-layer-predicate.md)) remains authoritative under either state.
- Columns: timestamp (`createdAt`, German locale `DD.MM.YYYY HH:mm`), actor, **project**, entity (type + human-readable label resolved server-side), action (German label derived from the action vocabulary), payload indicator.
- Project cell: the parent project's label snapshot for child entities (`project_worker`, `attachment`, `invoice`) — sourced from `ancestorEntityLabel` ([data-model.md §5.10](../data-model.md#510-audit-log-entity)). For `entityType = 'project'` rows it duplicates the row's own `entityLabel` so the column reads uniformly across the project's own lifecycle and its nested entities. For entity types with no project ancestor (`customer`, `user`, `company_profile`, `data_import`) the cell renders an em dash. Pinned by [verification.md AC-342](../verification.md#1532-activity-dock).
- Actor cell: `displayName` for user-actor entries. When the authoring user has been hard-deleted the API returns null `actorId` (per AC-98's SET NULL cascade); the UI renders the neutral German label `"Benutzer"` on those rows. System-actor entries render `"System"` with the `actorReason` as supporting text.
- Payload indicator: a `Details` affordance opening a drawer that shows actor display-name, timestamp, and the payload diff (before/after for update; after for create; before for delete). Rendered only when the API response for the row includes a non-null `payload` ([api.md §14.2.8](../api.md#1428-audit-log)).
- Default sort: `createdAt` descending, with `id` as a stable tiebreaker.
- Pagination follows the configurable page size **[C]**.
- Empty result: `"Keine Aktivität"`.

### 8.13.2 Filters

A filter bar AND-composing the following criteria, applied via the API:

- Entity type — multi-select over the configured `AuditEntityType` set ([data-model.md §5.10](../data-model.md#510-audit-log-entity)).
- Entity name — optional case-insensitive substring match against the frozen `entityLabel` snapshot ([data-model.md §5.10](../data-model.md#510-audit-log-entity)). Minimum three characters so the server's pg_trgm index can serve the query; below-minimum or empty input is ignored. Rows with a null `entityLabel` (import / retention paths) are not matchable by name.
- Actor — optional single-select over users the caller may already list via `user:read` (owner and office under the default matrix).
- Date range (`from` / `to`) — `to < from` is a client-side validation error; the form blocks submit.
- Action — optional multi-select over the action vocabulary.
- A `"Filter aufheben"` control clears every filter.

### 8.13.3 Destructive-Action Visibility

Rows whose `action` is `purge` (any entity type), `delete` on `user`, or `update` on `user` touching `roles` are admitted only to callers for whom the `auditDestructiveScopeForCaller` predicate ([api.md §14.2.8](../api.md#1428-audit-log)) returns null (owner under the default matrix). For every other role with `audit:read` the predicate contributes a `WHERE` fragment at the repository layer that excludes these entries — they are never returned by the API. The UI's role-aware rendering is a secondary surface; the server is authoritative.

### 8.13.4 Cross-Links

- Clicking an `entity` cell navigates to the referenced entity's detail view (project or customer) when it still exists, subject to the caller's own read permission on that entity. For purged targets, the cell renders the persisted identifier label without a link.
- Clicking the `Details` affordance expands a drawer inline — no route change.

---

## 8.14 Notification Rules View

Admin view over [`notification_rule`](../data-model.md#511-notification-rule). Backed by [api.md §14.2.9](../api.md#1429-notification-rules), gated on `notifications:manage`; edits are a direct repository write — rule configuration is not surfaced on the activity feed.

Navigation: the `Benachrichtigungen` tab in the administration group ([index.md §8.7.1](index.md#871-views)). Hidden without `notifications:manage`.

### 8.14.1 List

- Columns: `Ereignis` (German label from event-class mapping **[C]**), `Filter` (`stateFilter` label or blank when null), `Empfänger` (compact `recipientSpec` summary — e.g. `"Rollen: Inhaber, Büro · Zugewiesene Mitarbeiter · 2 Benutzer"`), `Aktiv` (toggle indicator), `Aktionen` (edit + delete).
- Pagination: configurable page size **[C]**.
- Empty result: `"Keine Regeln"`.

### 8.14.2 Create / Edit Rule

Single form for both create and edit.

Fields:

- **Ereignis (event)** — required. Single-select over the catalog ([data-model.md §5.11](../data-model.md#511-notification-rule)), German labels via the event-class mapping **[C]**.
- **Ziel-Status (state filter)** — single-select. Rendered only for `project.transition_forward` / `project.transition_backward`; otherwise hidden and sent as null. Values are workflow-state labels; empty = null.
- **Empfänger (recipient spec)** — three additive sub-sections:
  - **Rollen** — multi-select over the configured role set ([index.md §4.2](../index.md#42-users)).
  - **Zugewiesene Mitarbeiter** — toggle `"Zugewiesene Mitarbeiter benachrichtigen"`. Disabled and forced `false` for `backup.failed` / `disk.threshold_reached`.
  - **Einzelne Benutzer** — autocomplete over active users; selection adds a chip with a remove affordance.
- **Aktiv** — boolean toggle.

Validation errors follow [api.md §14.2.9](../api.md#1429-notification-rules); an empty recipient spec or a non-null state filter on a non-transition event is rejected via the mutation error banner ([index.md §8.1.2](index.md#812-authenticated-state)), and the form is restored.

### 8.14.3 Delete Rule

Row action or edit-form action. Yes / No confirmation. On success the rule disappears.

### 8.14.4 Permission and Hiding

Access is gated on `notifications:manage`. Users without it do not see the nav tab; manual URL entry presents the not-permitted surface per [AC-149](../verification.md#1521-role-scoping). All UI controls are hidden without the permission per [AC-121](../verification.md#1521-role-scoping).
