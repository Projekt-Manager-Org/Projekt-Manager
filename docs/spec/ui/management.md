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

- **Name** — no save is offered while it is blank; with the list of existing customers matching it ([AC-527](../verification.md#1511-customer-management), [AC-528](../verification.md#1511-customer-management), [AC-529](../verification.md#1511-customer-management)).
- **Street, zip, city**.
- **Phone, email**.
- **USt-IdNr., notes** ([AC-522](../verification.md#1511-customer-management)).

Fields: [data-model.md §5.6](../data-model.md#56-customer-entity). Behavior: [AC-518](../verification.md#1511-customer-management), [AC-539](../verification.md#1511-customer-management), [AC-520](../verification.md#1511-customer-management), [AC-537](../verification.md#1511-customer-management), [AC-538](../verification.md#1511-customer-management), [AC-521](../verification.md#1511-customer-management), [AC-536](../verification.md#1511-customer-management).

### 8.9.3 Edit Customer

The same fields with the customer's values, reached from a row or the Project Detail Page. Without `customer:write` every field is read-only and no save is offered ([AC-121](../verification.md#1521-role-scoping)). Behavior: [AC-519](../verification.md#1511-customer-management), [AC-520](../verification.md#1511-customer-management), [AC-537](../verification.md#1511-customer-management), [AC-538](../verification.md#1511-customer-management), [AC-521](../verification.md#1511-customer-management), [AC-543](../verification.md#1530-invoices), [AC-544](../verification.md#1530-invoices).

### 8.9.5 Delete Customer

`Löschen` on a row, for a caller who may delete. A confirmation names the customer, or warns about its archived projects ([AC-534](../verification.md#1511-customer-management), [AC-535](../verification.md#1511-customer-management), [AC-533](../verification.md#1511-customer-management)). Behavior: [AC-530](../verification.md#1511-customer-management), [AC-531](../verification.md#1511-customer-management), [AC-540](../verification.md#1511-customer-management), [AC-541](../verification.md#1511-customer-management), [AC-92](../verification.md#1511-customer-management), [AC-532](../verification.md#1511-customer-management).

---

## 8.10 User Management View

An administrative view of the user accounts. Who is admitted: [AC-562](../verification.md#1513-user-management). Behavior: [verification.md §15.13](../verification.md#1513-user-management).

### 8.10.1 List

Columns: username, display name, roles, email, status. A primary action opens the create form; a row opens the user panel.

### 8.10.2 Create User

Fields: username, display name, password with confirmation, roles (multi-select from the role set), email (optional). No submission until the required fields are filled and both password entries match. Constraints: [data-model.md §5.3](../data-model.md#53-user-entity).

### 8.10.3 User Panel

Shows the username (read-only), display name, roles, email and status. Editable fields: [AC-554](../verification.md#1513-user-management). Actions:

- **Passwort zurücksetzen** — new password with confirmation; no submission until both match.
- **Deaktivieren / Reaktivieren** — confirmation dialog.
- **Löschen** — confirmation dialog; not offered on the user's own account.

---

## 8.13 Audit View

A global, read-only tabular view of the `audit_log` ([data-model.md §5.10](../data-model.md#510-audit-log-entity)). Backed by [api.md §14.2.8](../api.md#1428-audit-log). Available to every caller holding `audit:read`; the per-role visible row set is narrowed server-side via the scope predicates — clients do not filter audit rows.

Navigation: exposed via the shell navigation matrix ([index.md §8.7.1](index.md#871-views)) as the `Aktivität` tab. Access is gated on `audit:read`, held by owner and office under the default matrix. Worker and bookkeeper do not hold `audit:read` and do not see the tab. The tab is hidden for users without the permission.

### 8.13.1 List

- Default view shows only events the caller is a recipient of per the resolved notification-rule set ([data-model.md §5.11](../data-model.md#511-notification-rule)). A `"Alles anzeigen"` toggle switches to the full RBAC-scoped feed (governed by `audit:read` and the destructive-action predicate per §8.13.3). Toggle state is local-only; navigation or reload restores the default. RBAC scoping ([ADR-0019](../../adr/0019-worker-data-scoping-repository-layer-predicate.md)) remains authoritative under either state.
- Columns: timestamp (`createdAt`, German locale `DD.MM.YYYY HH:mm`), actor, **project**, entity (type + human-readable label resolved server-side), action (German label derived from the action vocabulary), payload indicator.
- Project cell: the parent project's label snapshot for child entities (`project_worker`, `attachment`, `invoice`) — sourced from `ancestorEntityLabel` ([data-model.md §5.10](../data-model.md#510-audit-log-entity)). For `entityType = 'project'` rows it duplicates the row's own `entityLabel` so the column reads uniformly across the project's own lifecycle and its nested entities. For entity types with no project ancestor (`customer`, `user`, `company_profile`, `data_import`) the cell renders an em dash. Pinned by [verification.md AC-342](../verification.md#1532-activity-dock).
- Actor cell: `displayName` for user-actor entries. When the authoring user has been hard-deleted the API returns null `actorId` (per AC-567's SET NULL cascade); the UI renders the neutral German label `"Benutzer"` on those rows. System-actor entries render `"System"` with the `actorReason` as supporting text.
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
  - **Rollen** — multi-select over the configured role set ([index.md §4.2](../index.md#42-roles)).
  - **Zugewiesene Mitarbeiter** — toggle `"Zugewiesene Mitarbeiter benachrichtigen"`. Disabled and forced `false` for `backup.failed` / `disk.threshold_reached`.
  - **Einzelne Benutzer** — autocomplete over active users; selection adds a chip with a remove affordance.
- **Aktiv** — boolean toggle.

Validation errors follow [api.md §14.2.9](../api.md#1429-notification-rules); an empty recipient spec or a non-null state filter on a non-transition event is rejected via the mutation error banner ([index.md §8.1.2](index.md#812-authenticated-state)), and the form is restored.

### 8.14.3 Delete Rule

Row action or edit-form action. Yes / No confirmation. On success the rule disappears.

### 8.14.4 Permission and Hiding

Access is gated on `notifications:manage`. Users without it do not see the nav tab; manual URL entry presents the not-permitted surface per [AC-149](../verification.md#1521-role-scoping). All UI controls are hidden without the permission per [AC-121](../verification.md#1521-role-scoping).
