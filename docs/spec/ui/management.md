# UI: Management Views

Sections 8.8–8.10 and 8.13 of the [product spec](../index.md) — the tabular CRUD surfaces for Projects, Customers, and Users, plus the global Audit View. Email Data Intake (§8.12) — a modal customer+project creation flow entered from a header button — is a sibling page at [email-intake.md](email-intake.md). Shell and navigation live in [index.md](index.md); cross-cutting behavioral rules (in-flight lock, error handling, mutation semantics) in [behavior.md](behavior.md).

---

## 8.8 Project Management View

A tabular list of all projects with search, filtering, and CRUD operations.

### 8.8.1 List

- Columns: project number, title, customer name, status (colored badge), planned dates, estimated value, assigned workers.
- Sortable by any column. Default sort: project number descending.
- Search: free-text filter across project number, title, and customer name.
- Filters: by status (multi-select), by customer, by date range (planned start), by "has no dates" flag, by archive inclusion (`Archivierte einblenden` toggle, off by default). Filters use AND logic. A "Filter aufheben" control clears all filters.
- Pagination when the list exceeds a configurable page size **[C]**.
- Soft-deleted (archived) projects are excluded by default; the `Archivierte einblenden` toggle includes them. Archived rows are visually distinguished (muted text, `Archiviert` badge).

### 8.8.2 Create Project

Accessible via a primary action button. Requires `project:create` permission (button hidden otherwise).

Fields:

- **Project number** — auto-suggested from the configured format **[C]**, editable by the user, immutable after creation. On blur, the field shows a green "available" indicator if the number is free and a red "taken" indicator if an existing project already uses it. The indicator is UX feedback only — the server's uniqueness constraint is authoritative (see [api.md §14.2.2](../api.md#1422-projects)) and is what ultimately produces or rejects the create. Editing the field after a verdict clears the indicator until the next blur.
- **Title** — required.
- **Customer** — required. Selection from existing customers, with an option to create a new customer inline (see [§8.9.4](#894-inline-customer-creation)).
- **Status** — defaults to the first workflow state. Optionally selectable if configuration allows **[C]**.
- **Baustelle (site address)** — optional nested group: street, zip, city. Headed by an `"Identisch mit Kundenadresse"` toggle. Toggle ON sends `siteAddress: null` on submit (the project inherits the customer's Rechnungsadresse for display per [data-model.md §5.1](../data-model.md#51-project-entity)) and disables the street/zip/city inputs. Toggle OFF reveals the inputs and submits the entered values. Default state for create is **ON** — the homeowner-renovating-their-house case is the common path; the operator opts into divergence explicitly. See [§8.8.6](#886-site-address-form-rule) for the rule that applies to both create and edit.
- **Planned start / Planned end** — optional. Same validation as the detail panel (end requires start).
- **Assigned workers** — optional multi-select from active users with the `worker` role.
- **Estimated value** — optional numeric input.
- **Notes** — optional free text.

On success, the new project appears in the list and in Kanban/Calendar views.

**In-flight mutation lock** and **idempotency-conflict recovery** apply as defined in [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior).

### 8.8.3 Edit Project

Clicking a project row opens the project for editing. The editing surface reuses the Project Detail Panel ([workflow-views.md §8.4](workflow-views.md#84-project-detail-panel)) with expanded editability:

- **Planned start / Planned end** — editable via date inputs. Same validation as the detail panel (end requires start, end disabled when start is empty).
- **Notes** are editable.
- **Assigned workers** are editable via multi-select.
- **Estimated value** is editable.
- **Customer** can be changed.
- **Baustelle (site address)** — editable. Same group + `"Identisch mit Kundenadresse"` toggle as create (see [§8.8.6](#886-site-address-form-rule)). The toggle's initial state reflects the stored value: **ON** when `project.siteAddress` is null (the row inherits the customer's Rechnungsadresse), **OFF** with the stored street/zip/city populated when `project.siteAddress` is non-null.

All editable fields use PATCH semantics via the Update project API operation. Status changes use their dedicated transition operations. Date changes use the dedicated update-dates operation (see [api.md §14.2.2](../api.md#1422-projects)).

Requires `project:update` permission for mutations. Users without this permission see all fields as read-only.

### 8.8.4 Archive Project

Available per project row or in the edit view. The action is labelled "Archivieren". Confirmation dialog: `"Projekt {number} wirklich archivieren?"` with OK / Abbrechen. The API call soft-deletes the project (see [api.md §14.2.2](../api.md#1422-projects) and [ADR-0017](../../adr/0017-soft-delete-as-board-archive.md)).

Requires `project:delete` permission.

### 8.8.5 Permanently delete project

A secondary action labelled `Endgültig löschen` on archived project rows. Hard-deletes the project via `DELETE /api/projects/:id/purge` (see [api.md §14.2.2](../api.md#1422-projects)).

Visibility: the action appears only when the row has `deleted = true` AND the `Archivierte einblenden` toggle is on AND the caller holds `project:purge`. Hidden in every other case (consistent with [AC-121](../verification.md#1516-management-views)).

Confirmation dialog: simple Yes / No with a German warning that states the project will be permanently deleted and recovery is not possible. The archive-first gate on the API (a non-archived project is rejected with 409) is the primary friction; the confirmation is the secondary check.

Permission: requires `project:purge` (owner-only per the permission matrix in [api.md §14.3](../api.md#143-authorization-rules)). The button is not rendered for users without it. Server-side authorization is authoritative.

See [ADR-0017](../../adr/0017-soft-delete-as-board-archive.md) for the trash-bin rationale (archive-first, purge as the second step).

### 8.8.6 Site-Address Form Rule

Both Create Project ([§8.8.2](#882-create-project)) and Edit Project ([§8.8.3](#883-edit-project)) carry a **Baustelle** group with the same shape:

- A toggle labelled `"Identisch mit Kundenadresse"`.
- Three inputs for `street`, `zip`, `city`, grouped under the toggle.

Form behavior:

- **Toggle ON.** Street/zip/city inputs are disabled and visually muted. The inputs visibly mirror the selected customer's billing address (`customer.address`) as a read-only preview of what the project will inherit; if the customer has no stored address — or no customer has been picked yet on create — the inputs stay empty. The visual fill is presentation only: on submit, the request body always carries `siteAddress: null` regardless of what is shown (PATCH-null on edit clears any stored value — the project's site falls back to the customer's Rechnungsadresse per [data-model.md §5.1](../data-model.md#51-project-entity)).
- **Toggle OFF.** Inputs are enabled. On submit, the request body carries `siteAddress: { street, zip, city }`. Required-field validation follows the same all-or-none rule pinned on the customer Address group at [§8.9.2](#892-create-customer): all three of `street`, `zip`, `city` are required if any field has a non-empty value; a partial group is rejected at submit with a German validation message. The toggle's "all blank" axis is taken instead by the ON state, so under OFF the operator commits to filling all three.
- **Initial state.** ON by default for create. For edit, the toggle reflects the stored value: ON when `project.siteAddress` is null, OFF when non-null.
- **Switch ON → OFF (edit).** Reveals the inputs pre-filled empty so the operator can type the divergent address. Switching back to ON before submit discards the typed values without reverting any persisted state — the persisted state is whatever the previous successful PATCH stored.

This is the only form-level rule for the Baustelle group; rendering rules for read-only surfaces live in [project-detail.md §8.15.2](project-detail.md#8152-core-fields).

---

## 8.9 Customer Management View

A tabular list of all customers with search and CRUD operations.

### 8.9.1 List

- Columns: name, phone, email, city, project count, last updated.
- Search: name substring filter (case-insensitive), matching the API's `search` parameter.
- Pagination when the list exceeds a configurable page size **[C]**.
- Clicking a customer's project count navigates to the Project Management View filtered to that customer.

### 8.9.2 Create Customer

Accessible via a primary action button. Requires `customer:write` permission.

Fields:

- **Name** — required.
- **Phone** — optional.
- **Email** — optional.
- **USt-IdNr.** — optional. The customer's value-added-tax identifier ([data-model.md §5.6](../data-model.md#56-customer-entity)); pre-fills the invoice draft's `recipient.ustId`. Required at invoice issuance only when the draft's `taxMode` is `reverse_charge` ([data-model.md §5.15](../data-model.md#515-invoice-entity)); the customer form does not gate on tax mode.
- **Address** — optional nested group: street, zip, city. **All-or-none requiredness:** all three of `street`, `zip`, `city` are required if the group is opened (any field has a non-empty value); the group is treated as omitted (and the resulting persisted value is null) only when all three are blank. A partial group (one or two fields filled) is rejected at submit with a German validation message. The rule applies to Edit Customer ([§8.9.3](#893-edit-customer)) identically — Edit reuses the same form fields.
- **Notes** — optional free text.

**Duplicate-name suggestions (as-you-type).** While the user types in the name field, the form runs a debounced search against the customer list and presents matching customers in a dropdown below the input. Clicking a suggested customer closes the create form and opens that customer's edit form. The dropdown is an advisory hint — the user may ignore it and continue creating a new customer.

**Soft confirm on exact-name match.** On submit, if any existing customer's name matches the entered name (case-insensitive, whitespace-normalized), a confirmation dialog appears before the create is dispatched. The user must explicitly opt in via "Trotzdem erstellen" to proceed; cancelling returns to the form without sending a request. Creating legitimate duplicates is allowed — the confirm is a guard against accidental ones.

On success, the new customer appears in the list and is immediately available in project creation/editing dropdowns.

**In-flight mutation lock.** See [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior). The lock covers the soft-confirm dialog — submitting once while the confirm is open does not permit a second submit to fire through.

**Idempotency-conflict recovery.** A rare server-side conflict (see [api.md §14.4](../api.md#144-error-handling)) closes the create form, refreshes the customer list, and surfaces the German error message via the mutation error banner ([index.md §8.1.2](index.md#812-authenticated-state)). The user is not invited to retry the same submission.

### 8.9.3 Edit Customer

Clicking a customer row opens the customer for editing. PATCH semantics: omitted fields unchanged, explicit `null` clears optional fields.

Requires `customer:write` permission for mutations. Users without this permission see all fields as read-only.

### 8.9.4 Inline Customer Creation

When creating or editing a project ([§8.8.2](#882-create-project), [§8.8.3](#883-edit-project)), the customer selector includes an option to create a new customer inline. On successful creation, the new customer is automatically selected for the project.

### 8.9.5 Delete Customer

Available per customer row or in the edit view. Requires `customer:delete` permission (button hidden otherwise).

The confirmation dialog text depends on `archivedProjectCount` and `invoiceCount` (issued + cancelled rows only) returned by `GET /api/customers/:id` (see [api.md §14.2.5](../api.md#1425-customer-management)):

- When `archivedProjectCount` is 0 AND `invoiceCount` is 0, the standard confirmation phrasing applies. Draft invoices on archived projects do not block — they cascade with the project on hard-delete.
- When `archivedProjectCount > 0` AND `invoiceCount` is 0, the confirmation surfaces a German warning that names the archived-project count and informs the user that those archived projects (and any draft invoices on them) will be permanently deleted together with the customer.
- When `invoiceCount > 0`, the delete affordance is disabled and an inline German retention notice replaces it: `"Dieser Kunde hat ausgestellte oder stornierte Rechnungen. Aufbewahrungspflicht — Löschen während der gesetzlichen Frist nicht möglich."` (or the configured equivalent — German UI strings `[C]`, [architecture.md §12.2](../architecture.md#122-company-configurable-settings)). The notice does not suggest a remediation: issued invoices are immutable ([data-model.md §6.14](../data-model.md#614-immutability-of-issued-invoices)) and cancellation creates a Storno sibling rather than removing the original, so there is no in-app path that brings the count to zero before the §147 AO 10-year retention window elapses. The API enforces the same gate — `CUSTOMER_HAS_INVOICES` ([api.md §14.4](../api.md#144-error-handling)).

Deletion of a customer that still has active (non-archived) projects is rejected as a conflict by the API — the UI surfaces the German error message via the mutation error banner. Deletion of a customer whose project graph (active or archived) carries any issued or cancelled invoice is rejected with `CUSTOMER_HAS_INVOICES`; the UI surfaces the same retention notice via the mutation error banner if the request reaches the server (defense-in-depth on the disabled-affordance gate). See [ADR-0017](../../adr/0017-soft-delete-as-board-archive.md) for the archive-vs-purge boundary; see [ADR-0026](../../adr/0026-invoices-immutability-and-zugferd.md) for the invoice retention posture.

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

Access is gated on `notifications:manage`. Users without it do not see the nav tab; manual URL entry presents the not-permitted surface per [AC-149](../verification.md#1521-role-scoping). All UI controls are hidden without the permission per [AC-121](../verification.md#1516-management-views).
