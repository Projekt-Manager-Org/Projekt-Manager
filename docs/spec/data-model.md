# Data Model

---

## 5. Data Model

### 5.1 Project Entity

A job for one customer, moving through the workflow states. Behavior: [verification.md §15.12](verification.md#1512-projects).

| Field                        | Constraint                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                         | UUID                                                                                                                |
| `number`                     | Non-empty, at most 20 characters; unique across all projects, archived ones included; immutable after creation      |
| `title`                      | Non-empty, at most 500 characters                                                                                   |
| `status`                     | A workflow state ([index.md §3](index.md#3-workflow-states)); changes only by transition                            |
| `statusChangedAt`            | When the project entered its state                                                                                  |
| `customerId`                 | An existing customer ([§5.6](#56-customer-entity)); immutable after creation                                        |
| `siteAddress`                | The work site (Baustelle): `street`, `zip`, `city`, all non-empty — or none, and the site is the customer's address |
| `plannedStart`, `plannedEnd` | Calendar dates (ISO 8601, no time); one range per project; an end needs a start and is not before it                |
| `assignedWorkers`            | Distinct users with the worker role, active when assigned                                                           |
| `estimatedValue`             | EUR net, two decimals, at most 10 integer digits                                                                    |
| `notes`                      | Free text                                                                                                           |
| `deleted`                    | Archived ([ADR-0017](../adr/0017-soft-delete-as-board-archive.md))                                                  |
| `createdAt`, `updatedAt`     | Server time                                                                                                         |
| `createdBy`, `updatedBy`     | The acting user; empty for seeded or imported rows without a known actor                                            |

### 5.3 User Entity

A person who can sign in. A user changes their own `themePreference` and `pushMuted` by self-update ([AC-568](verification.md#154-authentication)) and their own password ([AC-547](verification.md#154-authentication)); the other editable fields are administrative. Behavior: [verification.md §15.13](verification.md#1513-user-management).

| Field                    | Constraint                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `id`                     | UUID                                                                                                                 |
| `username`               | Not blank, at most 255 characters, unique; used to log in; immutable after creation                                  |
| `displayName`            | Not blank, at most 255 characters                                                                                    |
| `passwordHash`           | Salted hash of the password; reaches a client only inside an export ([AC-394](verification.md#1513-user-management)) |
| `roles`                  | One or more of the role set **[C]** ([api.md §14.3](api.md#143-authorization-rules))                                 |
| `email`                  | Optional free text, at most 255 characters                                                                           |
| `active`                 | Default `true`; `false` means deactivated ([§6.9](#69-soft-deletes))                                                 |
| `themePreference`        | [§5.7](#57-user-theme-preference)                                                                                    |
| `pushMuted`              | Default `false`; mutes push delivery only ([§5.12](#512-push-subscription))                                          |
| `createdAt`, `updatedAt` | Server time                                                                                                          |
| `lastLoginAt`            | Time of the last successful login; empty before the first                                                            |
| `createdBy`, `updatedBy` | The acting user; empty for seeded or bootstrapped rows                                                               |

**Password policy [C]** ([ADR-0006](../adr/0006-password-policy-nist-blocklist.md)): at least 8 characters, at most 72 UTF-8 bytes, not on the common-password blocklist.

### 5.4 Session

A login creates a session. It lasts the session duration **[C]** (default 24 hours); a user may hold any number of sessions at once. Token delivery: [ADR-0005](../adr/0005-session-management-httponly-cookies.md). When sessions end: [verification.md §15.4](verification.md#154-authentication), [§15.13](verification.md#1513-user-management).

### 5.5 Audit Metadata

All persisted entities follow a common audit metadata pattern:

```typescript
interface AuditMetadata {
  createdAt: string; // ISO 8601 — set on creation, never modified
  updatedAt: string; // ISO 8601 — set on every mutation
  createdBy?: string; // UserAccount.id — optional for seeded/imported records
  updatedBy?: string; // UserAccount.id — optional for seeded/imported records
}
```

Rules:

- `createdAt` and `updatedAt` are managed by the server. Clients never send these fields in mutations.
- User-triggered mutations must set `updatedBy` to the authenticated user's ID and update `updatedAt`.
- `createdBy` and `updatedBy` are optional because seeded, imported, or system-generated records may not have a known actor.
- This pattern applies to `Project`, `Customer`, and `UserAccount`. `Session` uses `createdAt` and `expiresAt` only (sessions are not user-editable).

### 5.6 Customer Entity

A person or company the projects are for. Only `name` is required. Behavior: [verification.md §15.11](verification.md#1511-customer-management).

| Field                    | Constraint                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | UUID                                                                                                                           |
| `name`                   | Not blank, at most 255 characters; not unique ([AC-536](verification.md#1511-customer-management))                             |
| `phone`                  | Free text, at most 100 characters                                                                                              |
| `email`                  | Free text, at most 255 characters                                                                                              |
| `ustId`                  | USt-IdNr., at most 50 characters; a reverse-charge invoice needs it on its recipient ([AC-289](verification.md#1530-invoices)) |
| `address`                | The billing address (Rechnungsadresse): `street`, `zip`, `city`, all non-empty — or none                                       |
| `notes`                  | Free text                                                                                                                      |
| `version`                | Concurrency token ([§6.4](#64-concurrency))                                                                                    |
| `createdAt`, `updatedAt` | Server time                                                                                                                    |
| `createdBy`, `updatedBy` | The acting user; empty for seeded or imported rows without a known actor                                                       |

### 5.7 User Theme Preference

`UserAccount.themePreference` is the server-authoritative source for the user's chosen color scheme.

| Value      | Effect                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `'light'`  | The UI renders the light theme regardless of operating-system scheme.                                   |
| `'dark'`   | The UI renders the dark theme regardless of operating-system scheme.                                    |
| `'system'` | The UI follows the operating system's color-scheme preference and updates when that preference changes. |

- New users default to `'system'`.
- The value is updated by the authenticated user via self-update ([§5.3](#53-user-entity)).
- The server value is authoritative. Clients may cache the value locally to prevent a flash of the wrong theme on page load, but must replace any cached value with the server value on session hydration.

### 5.8 Export Archive

The zip file an export produces and an import accepts: the deployment's business data and attachments, in plaintext ([ADR-0018](../adr/0018-data-persistence-and-recovery-layered-strategy.md)). Behavior: [verification.md §15.14](verification.md#1514-data-exchange).

| Entry                                                                     | Content                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data.json`                                                               | The business data, below                                                                                                                                                                                                                 |
| `manifest.json`                                                           | `{ manifestVersion: 1, exportedAt, totalFiles, totalBytes, files: [{ zipPath, sizeBytes, sha256, attachmentId? }] }` — one entry per other file, `data.json` first and without `attachmentId`; `totalFiles` and `totalBytes` sum `files` |
| `attachments/<projektnummer>-<projekt-titel>/<attachment-id>-<dateiname>` | One file per attachment in `data.json`: its content as uploaded. Each path component follows the file-name rules of [§5.13](#513-attachment)                                                                                             |

```typescript
interface ExportData {
  schema_version: 4;
  exported_at: string; // ISO 8601
  users: EnvelopeUser[]; // every user, inactive ones included
  company_profile: EnvelopeCompanyProfile[]; // exactly one
  customers: EnvelopeCustomer[]; // every field of §5.6 except `version`
  projects: EnvelopeProject[]; // every field of §5.1; archived projects included
  project_workers: { projectId: string; userId: string }[];
  invoices: EnvelopeInvoice[]; // every status
  invoice_sequence: EnvelopeInvoiceSequence[];
  attachments: EnvelopeAttachment[]; // status `ready` only — not pending, not in the Papierkorb
}

interface EnvelopeUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string; // §5.3
  roles: string[];
  email: string | null;
  active: boolean;
  themePreference: 'light' | 'dark' | 'system';
  pushMuted: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

interface EnvelopeCompanyProfile {
  id: string;
  companyName: string;
  address: { street: string; zip: string; city: string };
  taxId: string;
  ustId: string | null;
  iban: string | null;
  accentColor: string | null;
  footerText: string | null;
  defaultTaxMode: 'standard' | 'reverse_charge';
  updatedAt: string;
  updatedBy: string | null;
}

interface EnvelopeInvoice {
  id: string;
  projectId: string;
  status: 'draft' | 'issued' | 'cancelled';
  number: string | null;
  issueDate: string | null;
  performanceDate: string | null;
  taxMode: 'standard' | 'reverse_charge';
  profile: 'zugferd-en16931';
  issuer: InvoiceIssuerSnapshot; // §5.15
  recipient: InvoiceRecipientSnapshot; // §5.15
  lines: InvoiceLine[]; // §5.15
  totals: InvoiceTotals; // §5.15
  cancellationOf: string | null; // the cancelled original, on a Storno only
  cancellationReason: string | null;
  renderedPdfBinaryDescriptorId: string | null; // an `attachments` entry: the invoice's PDF
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

interface EnvelopeInvoiceSequence {
  year: number;
  kind: 'invoice' | 'storno'; // §5.16
  nextValue: number;
  updatedAt: string;
}

interface EnvelopeAttachment {
  id: string;
  projectId: string;
  kind: 'photo' | 'binary';
  label: AttachmentLabel; // §5.13
  fileName: string;
  mimeType: string;
  sizeBytes: number; // plaintext
  status: 'ready';
  createdAt: string;
  createdBy: string | null;
}
```

Fields keep their meaning from their entity in this chapter; timestamps are ISO 8601. Not in the archive: sessions, push subscriptions, storage totals, backup status, notification rules, the audit log and data exchange jobs.

**Valid archive.** An import accepts an archive only if:

- `schema_version` is the current one;
- every file the manifest lists is in the archive and matches its SHA-256, and each attachment of `data.json` has its own listed file;
- every reference in `data.json` resolves within it — users, customers, projects, invoices, attachments — except a user's own `createdBy` / `updatedBy` ([§6.6](#66-referential-integrity)), and a Storno's original is not itself a Storno;
- invoices meet the rules of [§5.15](#515-invoice-entity) whatever their status; attachments carry a valid kind, label, MIME type and file name.

### 5.9 Backup Status Entity

The Layer 2 backup-and-drill cycle ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)) publishes its last-run result into a single-row table so the application — and, via the status mirror object, an out-of-app reader — can render backup freshness without polling the scheduler.

```typescript
interface BackupStatus {
  lastBackupAt?: string; // ISO 8601 — timestamp of the last completed run (success or failure)
  lastBackupOk: boolean; // true when the last run produced an uploaded, Tier-1-verified artifact
  lastDrillAt?: string; // ISO 8601 — timestamp of the last Tier-2 drill attempt
  lastDrillOk: boolean | null; // true when the last Tier-2 drill succeeded; false when it failed; null before any Tier-2 drill has been attempted
  lastBackupError?: string; // short machine-readable cue of the last run's failure; null when the run and its mirror write succeeded
  lastDrillError?: string; // short machine-readable cue of the last Tier-2 drill's failure; null when the drill and its mirror write succeeded
  updatedAt: string; // ISO 8601 — set by the backup service on every write
}
```

Design notes:

- **Single row, denormalized by design.** Only the most recent result is observable; history lives in the off-site object store's object timestamps and in container logs. The row is created by migration and is never deleted.
- **Mutation semantics: upsert only.** The backup service writes via upsert on a fixed primary key; the application never mutates this row.
- **Dual-write mirror.** Every write of this row is followed by a write of an unencrypted status mirror object in the off-site object store with the same fields ([AC-169](verification.md#1522-backup-and-recovery)). The mirror exists so backup health is readable when the database is unreachable ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)).
- **Each cycle owns its fields.** A backup run writes only the `lastBackup*` fields and a drill only the `lastDrill*` fields (plus `updatedAt`), so neither outcome erases the other's failure cue ([AC-370](verification.md#1522-backup-and-recovery)).
- **`lastDrillOk` semantics.** `lastDrillOk` is `null` before any Tier 2 drill has succeeded OR failed. A null value is not equivalent to "skipped" — skipped runs leave both `lastDrillAt` and `lastDrillOk` unchanged from the previous run, so freshness is derived from `lastDrillAt` rather than coerced to a boolean.
- **Cross-references.** Freshness thresholds for the owner-only badge are defined under [architecture.md §12.2](architecture.md#122-company-configurable-settings); acceptance criteria in [verification.md §15.22](verification.md#1522-backup-and-recovery).

### 5.10 Audit Log Entity

An append-only record of every domain-entity state change. Drives the user-facing activity view ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed), [ui/management.md §8.13](ui/management.md#813-audit-view)) and the notification publisher. Rationale and the single-write-path contract live in [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md).

```typescript
type AuditActorKind = 'user' | 'system';

type AuditEntityType =
  | 'project'
  | 'customer'
  | 'user'
  | 'project_worker'
  | 'attachment'
  | 'invoice'
  | 'company_profile'
  | 'data_import'; // synthetic; tags the export and import job entries (no physical table)

interface AuditLogEntry {
  id: string; // UUID
  createdAt: string; // ISO 8601 — set by the server at commit time
  actorId?: string; // references UserAccount.id — null when actorKind = 'system'
  actorKind: AuditActorKind; // 'user' for authenticated callers, 'system' for bootstrap and other unattended domain-entity writes
  actorReason?: string; // required (non-empty) when actorKind = 'system'; null for 'user' entries
  entityType: AuditEntityType; // the domain entity that changed
  entityId: string; // identifier of the affected row
  entityLabel?: string; // human-readable label captured at write time (see design notes)
  ancestorEntityType?: AuditEntityType; // ancestor pair (see design notes); both-or-neither with ancestorEntityId
  ancestorEntityId?: string; // ancestor pair (see design notes); both-or-neither with ancestorEntityType
  ancestorEntityLabel?: string; // human-readable label of the ancestor, captured at write time (see design notes)
  action: string; // vocabulary defined below — free text for forward compatibility
  payload: object; // JSON — before/after of changed fields only, not the full row
  correlationId?: string; // request-scoped id threaded from the route layer, where available
}
```

Design notes:

- **Append-only from the application.** The application never updates an `audit_log` row and never deletes one through any API, service, or UI path. The retention cleanup job ([§6.10](#610-audit-log-retention)) is the only path that removes rows and operates as infrastructure, not as a domain mutation — it does not itself produce an `audit_log` row.
- **Scope is domain-entity state changes.** `project`, `customer`, `user`, `project_worker`, `attachment`, `invoice`, and `company_profile` are the audited domain types. `data_import` is a synthetic type tagging a deployment-level event (an export or import job ending; [AC-332](verification.md#1514-data-exchange)) — no physical table backs it. Authentication and session events (login, logout, session reap) are security events and surface through the structured logger, not `audit_log` — per [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md).
- **Actor kind semantics.**
  - `user` — an authenticated caller performed the mutation. `actorId` references the `UserAccount.id`; `actorReason` is null.
  - `system` — no authenticated caller is present. `actorId` is null; `actorReason` is required and carries a human-readable cue naming the code path (e.g., `"first-run-bootstrap"`). First-run admin bootstrap ([ADR-0010](../adr/0010-first-run-admin-bootstrap.md)) is the current domain-entity system-actor path. A system entry with an empty or missing `actorReason` is rejected by the database via a CHECK constraint (defense in depth) — else a system write would be invisible in the activity feed.
- **Action vocabulary.** `action` is free text so new mutation shapes can record without a schema migration. The current vocabulary is `create`, `update`, `delete`, `archive`, `transition:forward`, `transition:backward`, `purge`, `reactivate`, `deactivate`, `password-reset`, `password-change`, `attachment:add`, `attachment:hide`, `attachment:restore`, `attachment:purge`, `invoice:issue`, `invoice:cancel`, `export_built`, `export_failed`, `import_restored`, `import_failed`. `archive` is the `entityType = 'project'` soft-delete action (see [ADR-0017](../adr/0017-soft-delete-as-board-archive.md)); `delete` and `purge` remain distinct (generic delete for non-project entities, hard-delete on projects respectively). `attachment:add`, `attachment:hide`, and `attachment:restore` live on `entityType = 'attachment'` and correspond to upload completion (`pending → ready`), user-DELETE (soft-hide per [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)), and Papierkorb-restore respectively. `attachment:purge` records the system-initiated permanent destruction of a hidden attachment row by the hidden reaper ([AC-426](verification.md#1526-attachments)) — distinct from `attachment:hide`, which is the user-initiated soft-hide that moves the row to the Papierkorb. The four export and import actions live on `entityType = 'data_import'`, one row per ended job ([AC-332](verification.md#1514-data-exchange)). The orphan reaper ([AC-408](verification.md#1526-attachments)) removes rows / objects without producing audit rows — it operates on housekeeping artifacts that never entered the user-visible domain. A free-text field is chosen over an enum because the vocabulary is expected to grow with new features and an enum would churn the schema; uniqueness and casing are enforced by convention and reviewed at PR time. Each entry in the vocabulary maps to exactly one mutation shape.
- **Payload shape.** `payload` carries the changed fields only, as `{ before, after }` field-keyed objects — not the full row. For a create, `before` is empty and `after` carries the persisted values for every non-server-managed field. For a delete or purge, `after` is empty. For a state transition, `before` and `after` carry `status` and `statusChangedAt`. Cross-project rendering surfaces (the dock, the global Aktivität view, push payload composition) read the parent project's display name from the row-level `ancestorEntityLabel` snapshot — the payload is reserved for the `{ before, after }` field diff alone. Full-row snapshots are deliberately excluded (see [ADR-0021 — Alternatives Considered](../adr/0021-audit-log-and-notifications-single-write-path.md#alternatives-considered)).
- **Entity label snapshot.** `entityLabel` is a nullable text column captured at write time (e.g. a project's `"2026-002 Innenraumgestaltung Weber"`, a customer's `"Firma Weber GmbH"`, a user's `displayName`). Frozen with the audit row so the activity feed stays readable after the target is renamed or purged. Write paths that do not have a natural label (import, retention cleanup) leave it null; the UI falls back to `entityId`. This is display metadata — it is not part of the `{ before, after }` diff contract. For `project_worker` rows specifically, `entityId` is the project's id (not the join-row's composite key) and `entityLabel` is the **worker's** displayName — the feed reads "Jan Nowak wurde zugewiesen" under the owning project's header, so the worker name is the meaningful label, while the project id remains the row's target. Pinned by [AC-188](verification.md#1523-audit-log).
- **Ancestor label snapshot.** `ancestorEntityLabel` is a text column captured at write time alongside the existing `ancestorEntityType` / `ancestorEntityId` pair ([architecture.md §11.12](architecture.md#1112-audit-ancestor-link)). It carries the parent project's `entityLabel` for child-entity rows (`attachment`, `project_worker`, `invoice`) and for `entityType = 'project'` rows (self-ancestor) duplicates the row's own `entityLabel`. Frozen with the audit row so the activity feed surfaces "_who_ did _what_, _where_" without a runtime JOIN against `projects` (which would lose context once a project is purged). Co-populated with `ancestorEntityType` / `ancestorEntityId` — when the ancestor pair is null (top-level entities: `customer`, `user`, `company_profile`, `data_import`), `ancestorEntityLabel` is also null; when the pair is non-null, the service layer always populates the label (projects always carry a `displayName`-derived label, see [architecture.md §11.12](architecture.md#1112-audit-ancestor-link)). Display metadata only — not part of the `{ before, after }` diff contract, and not a substitute for the row's own `entityLabel`. Pinned by [AC-342](verification.md#1532-activity-dock).
- **Correlation id.** `correlationId` is a nullable, per-request id set at the route layer and threaded through the service call chain. It groups every audit row produced by one request, enabling a future bulk-undo or one-request trace. Null is valid for entries produced outside a request (bootstrap and other unattended domain-entity writes).
- **Referential integrity.** `actorId` is a nullable foreign key to `UserAccount.id`; when a user is hard-deleted, `actorId` is set to null rather than cascading the audit row (parity with [AC-567](verification.md#1513-user-management)). `entityId` is not foreign-keyed — a purge removes the target row while its audit trail remains.
- **Transactional write.** Every domain-entity mutation and its audit row commit in a single database transaction. The application does not write the state change without the audit row, and it does not write the audit row without the state change. See [architecture.md §11.3](architecture.md#113-state-layer-behavioral-contract) and [ADR-0021 — Decision](../adr/0021-audit-log-and-notifications-single-write-path.md#decision).
- **Non-audited self-preference writes on `UserAccount`.** A narrow carve-out from the single-write-path invariant: a self-update ([§5.3](#53-user-entity)) whose patch touches only `themePreference`, `pushMuted`, or both writes the new values without producing an `audit_log` row. These are per-user UI/notification preferences with no cross-user or security consequence; auditing them would add rows to the activity feed that are not "who-did-what-to-whom" events and would drown out the actor-on-entity traffic the feed is optimized for (ADR-0021 "high-signal activity feed"). Any write that touches `roles`, `active`, `username`, `displayName`, `email`, or `passwordHash` (administrator paths, not self-update) goes through `mutate()` and produces an audit row unconditionally. The CI architecture check ([verification.md AC-179](verification.md#1523-audit-log)) remains authoritative for every non-carve-out mutation on `user_accounts`; the carve-out is expressed as an allowlisted write site, not a general bypass of the single-write-path helper.
- **Post-commit notification dispatch.** Subscribers (notification publisher and any future projection) dispatch after the transaction commits, so a throwing subscriber cannot roll back domain state. The `audit_log` row is the event source; publishing is a read-over-audit projection.

### 5.11 Notification Rule

Admin-editable configuration mapping a closed event catalog to recipient specs. Rule writes are direct repository writes; rule configuration is not surfaced on the activity feed. Rationale and alternatives: [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md).

```typescript
type NotificationEventClass =
  | 'project.transition_forward'
  | 'project.transition_backward'
  | 'project.archived'
  | 'project.assignment_changed'
  | 'project.attachment_added'
  | 'backup.failed'
  | 'disk.threshold_reached';

interface NotificationRecipientSpec {
  roles: AccountRole[]; // additive — every user holding any of these roles
  includeAssignedWorkers: boolean; // additive — only meaningful for project-scoped events
  userIds: string[]; // additive — UserAccount.id values
}

interface NotificationRule {
  id: string; // UUID
  eventClass: NotificationEventClass;
  stateFilter?: WorkflowState | null; // only meaningful for transition events; null = no filter
  recipientSpec: NotificationRecipientSpec;
  enabled: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  createdBy?: string; // UserAccount.id
  updatedBy?: string; // UserAccount.id
}
```

Design notes:

- **Closed event catalog.** `NotificationEventClass` is the shipping set. Adding a class is a code change plus a migration ([ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md)); users never author event classes.
- **Event source mapping.** `project.transition_forward` / `project.transition_backward` → `entityType = 'project'` AND `action = 'transition:forward' | 'transition:backward'`. `project.archived` → `entityType = 'project'` AND `action = 'archive'` (soft-delete = archive — distinct from `purge` (hard-delete) and the generic `delete` used for other entity types, see [ADR-0017](../adr/0017-soft-delete-as-board-archive.md)). `project.assignment_changed` → `entityType = 'project_worker'` with `action` in `create` or `delete`. `backup.failed` and `disk.threshold_reached` are non-mutation system events — they publish to the in-process bus without an `audit_log` row, per [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md). `project.attachment_added` → `entityType = 'attachment'` AND `action = 'attachment:add'`; that audit row is written when the upload completes (`pending → ready`, [§5.13](#513-attachment)), so the event fires only on a byte-confirmed upload — an abandoned upload produces neither the row nor the event.
- **`stateFilter` semantics.** Non-null only on the two transition event classes. Matches when `after.status` equals the filter; null means match regardless of target state. A non-null filter on a non-transition class is rejected at validation time.
- **`recipientSpec` is additive.** `roles`, `includeAssignedWorkers`, and `userIds` are unioned. An empty spec is rejected at validation so an enabled rule always has a non-empty candidate set before dedup.
- **`includeAssignedWorkers` scope.** Only meaningful when the event carries a `projectId` (`project.transition_*`, `project.archived`, `project.assignment_changed`, `project.attachment_added`). Rejected at validation for `backup.failed` and `disk.threshold_reached`.
- **No templates in the model.** Per-event German message templates are code-owned in the config layer. See [ADR-0023 Alternatives](../adr/0023-notification-rules-db-stored-closed-event-catalog.md#freeform-predicate-dsl-over-payload).
- **No priority / no override.** Multiple matches produce a recipient **union**, deduplicated by `UserAccount.id`. No priority field, override flag, or AND/OR tree — see [ADR-0023 Alternatives](../adr/0023-notification-rules-db-stored-closed-event-catalog.md#rule-matching-with-priority--override).
- **Invalid-recipient resilience.** A resolved recipient whose `UserAccount` is missing or `active = false` is skipped at dispatch; remaining recipients proceed. Zero live recipients completes without error.
- **Rule take-effect.** A rule change affects the next event committed after the change; in-flight events use the rule set read at their own commit.
- **Configuration layering.** Each mutation-sourced `NotificationEventClass`'s German activity-feed description lives in the `[C]` catalogue ([architecture.md §12.2](architecture.md#122-company-configurable-settings)) under the audit activity-feed rendering entry — already keyed on `(action, payload)`, the per-event identity the publisher emits.

### 5.12 Push Subscription

Per-device push subscription. A user may register multiple devices (phone, desktop); unsubscribing one does not affect the others.

```typescript
interface PushSubscription {
  id: string; // UUID
  userId: string; // references UserAccount.id (ON DELETE CASCADE)
  endpoint: string; // opaque browser-provided endpoint — unique within a user
  p256dh: string; // opaque key material delivered by the browser push API
  auth: string; // opaque key material delivered by the browser push API
  userAgent?: string; // nullable — captured at subscribe time so the user can identify a device in their subscription list
  createdAt: string; // ISO 8601
}
```

Design notes:

- **Per-device identity.** `endpoint` is unique within a user (`(userId, endpoint)` uniqueness); re-subscribing an existing endpoint updates the row. Rows are deleted either by the server on a permanent-error dispatch or by the user via unsubscribe.
- **Ownership.** `userId` is set from the authenticated caller at subscribe time; a caller-supplied user id is refused ([api.md §14.4.2](api.md#1442-error-principles)).
- **Denormalized key material.** `p256dh` and `auth` are the two opaque tokens the browser push API returns at subscribe time. They are stored as two named text fields rather than a single JSONB blob so the dispatcher reads them directly without an additional unpacking step. The field names `p256dh` and `auth` are the browser push API's own externally-defined names — not implementation details — and round-trip verbatim between the client, the server, and the push service. Neither field is ever rendered in the UI.
- **Mute interaction.** When the owner's `pushMuted` is `true`, the dispatcher skips every subscription they own. Rows are retained — mute is a delivery-time filter, so unmuting restores delivery without a re-subscribe.
- **User deactivation / deletion.** Deactivation (`active = false`) suspends dispatch to the user's subscriptions. Hard-delete cascades `push_subscription` rows (parity with session cleanup; see [§6.9](#69-soft-deletes)).
- **No retention window.** Rows live until unsubscribed or cascaded by user deletion; stale endpoints are pruned at dispatch time via permanent-error handling. There is no elapsed-time garbage collection — rows are removed only by unsubscribe, user cascade, or a permanent dispatch error (e.g., a gone-endpoint response from the push service).

### 5.13 Attachment

A file attached to a project. Its content lives encrypted in object storage ([ADR-0018](../adr/0018-data-persistence-and-recovery-layered-strategy.md) Layer 3, [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)). Behavior: [verification.md §15.26](verification.md#1526-attachments).

| Field                                             | Constraint                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                              | UUID                                                                                                                                                                                                 |
| `projectId`                                       | The owning project                                                                                                                                                                                   |
| `status`                                          | `pending` (upload not complete) → `ready` ⇄ `hidden` (in the Papierkorb)                                                                                                                             |
| `label`                                           | One of `angebot`, `auftragsbestaetigung`, `rechnung`, `aufmass`, `foto`, `sonstiges`; German names **[C]**                                                                                           |
| `mimeType`                                        | One of `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. No HEIC: the kickoff's devices are Windows and Android |
| `kind`                                            | `photo` for the three image types, `binary` otherwise                                                                                                                                                |
| `fileName`                                        | Non-empty, at most 255 characters; no control character (`\x00`–`\x1F`, `\x7F`), no `/` or `\`, no `"`                                                                                               |
| `sizeBytes`                                       | Declared plaintext size of the original; at most the per-file cap **[C]**                                                                                                                            |
| `ciphertextSizeBytes`, `ciphertextThumbSizeBytes` | Stored (encrypted) size of the original and of a photo's thumbnail; the thumbnail at most the thumbnail cap **[C]**                                                                                  |
| `hiddenAt`                                        | When it entered the Papierkorb; set only while `hidden`                                                                                                                                              |
| `createdAt`                                       | Upload time                                                                                                                                                                                          |
| `createdBy`                                       | The uploading user, from the session, never from the request. A full-account import keeps the exported value                                                                                         |

**Deploy-probe namespace.** Storage keys under `__probe/` hold deploy-preflight sentinels, not attachments.

### 5.14 Storage Usage

Deployment-wide totals over the attachments of every project ([§5.13](#513-attachment)). Behavior: [verification.md §15.29](verification.md#1529-storage-usage).

| Total      | Sum of                                             | Over attachments with `status` |
| ---------- | -------------------------------------------------- | ------------------------------ |
| Visible    | `sizeBytes`                                        | `ready`                        |
| Papierkorb | `sizeBytes`                                        | `hidden`                       |
| Stored     | `ciphertextSizeBytes` + `ciphertextThumbSizeBytes` | `ready` or `hidden`            |

### 5.15 Invoice Entity

The artifact produced by the `Rechnung fällig → Abgerechnet` transition of the project workflow ([index.md §3](index.md#3-workflow-states)). Architectural rationale — immutability posture, gapless numbering, ZUGFeRD profile, Stornorechnung model, snapshot semantics — is pinned by [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md).

```typescript
type InvoiceStatus = 'draft' | 'issued' | 'cancelled';

type TaxMode = 'standard' | 'reverse_charge';

type InvoiceProfile = 'zugferd-en16931';

interface InvoiceLine {
  description: string; // free text, German display
  quantity: number; // positive decimal
  unit: string; // free text — "Stück", "h", "m²", "pauschal", …
  unitPrice: number; // EUR, net of VAT; at most 4 decimals
  lineTotal: number; // EUR, `quantity * unitPrice` rounded to 2 decimals; server-derived on create / update, never accepted from the client
  taxRate: number; // percent — 0, 7 or 19; `standard` excludes 0 (EN 16931 BR-S-05); ignored in totals when taxMode = 'reverse_charge'
}

interface InvoiceIssuerSnapshot {
  // Snapshot of company_profile at issuance time — never re-derived from the live row.
  companyName: string;
  address: { street: string; zip: string; city: string };
  taxId: string; // Steuernummer
  ustId?: string; // USt-IdNr. — required at issuance (§5.17)
  iban?: string;
  footerText?: string;
  // No logo field — it is deploy-time branding, drawn at render time and never snapshotted (§5.17).
}

interface InvoiceRecipientSnapshot {
  // Frozen at issuance; an issued row is never re-derived from the live customer.
  name: string;
  address?: { street: string; zip: string; city: string };
  ustId?: string; // customer's USt-IdNr. — required for reverse_charge
}

interface InvoiceTotals {
  // Aggregations across `lines`. Per-rate subtotals populated only for taxMode = 'standard'.
  perRate: { taxRate: number; netSubtotal: number; taxAmount: number }[];
  netGrandTotal: number; // sum of perRate.netSubtotal, or sum of lineTotal for reverse_charge
  taxGrandTotal: number; // sum of perRate.taxAmount; zero for reverse_charge
  grossGrandTotal: number; // netGrandTotal + taxGrandTotal
}

interface Invoice {
  id: string; // UUID
  number?: string; // "RE-YYYY-NNNN" (invoice) or "ST-YYYY-NNNN" (Storno); null while status = 'draft'
  status: InvoiceStatus;

  projectId: string; // references Project.id — the project whose work this invoice bills
  cancellationOf?: string; // references Invoice.id of the original issued row when this is a Stornorechnung; null otherwise

  issuer: InvoiceIssuerSnapshot; // frozen at issuance — owner-mutable in draft
  recipient: InvoiceRecipientSnapshot; // frozen at issuance — owner-mutable in draft
  lines: InvoiceLine[]; // JSONB array — frozen at issuance
  taxMode: TaxMode; // snapshotted at issuance; pre-filled from company_profile.defaultTaxMode in draft
  profile: InvoiceProfile; // snapshotted at issuance; v1 always 'zugferd-en16931'
  totals: InvoiceTotals; // server-computed at issuance; frozen thereafter

  issueDate?: string; // ISO 8601 date — server-set at issuance; null in draft
  performanceDate?: string; // ISO 8601 date — Leistungsdatum per §14 UStG; required at issuance; editable in draft

  cancellationReason?: string; // free text from the cancel call; null on non-Storno rows; frozen on the Storno row at issuance of the cancellation

  renderedPdfBinaryDescriptorId?: string; // FK to a binary descriptor row carrying the rendered PDF/A-3 + embedded factur-x.xml; null in draft, set at issuance

  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601 — frozen after issuance (only `status: 'issued' → 'cancelled'` may bump it)
  createdBy?: string; // UserAccount.id
  updatedBy?: string; // UserAccount.id
  version: number; // server-managed concurrency token — §6.4
}
```

Design notes:

- **Snapshot at issuance — issuer, recipient, lines, taxMode, profile.** At issuance the service freezes every contributing value onto the row before the transaction commits: `issuer` from the live `company_profile` row, the others as the draft holds them. A subsequent edit to the live company profile or customer does not retroactively change the issued artifact. Rendering an issued invoice is a pure projection over the row — no join is needed against `customers` or `company_profile` to reproduce the document.
- **A customer correction reaches open drafts.** When a customer edit changes `name`, `address` or `ustId`, every draft on that customer's projects, archived ones included, takes the new value of each such field where it still holds the customer's previous value. Any other value is a user override and stays. The address counts as one field; surrounding whitespace and blank versus absent are no difference ([AC-543](verification.md#1530-invoices), [AC-544](verification.md#1530-invoices)).
- **Issued rows are write-once.** Once `status = 'issued'`, no UPDATE path is permitted on the row except the `cancelled` transition. The constraint is structural — the API rejects (per [api.md §14.2.14](api.md#14214-invoice-operations)) and the persistence layer treats issued rows as immutable. A correction is a fresh `draft → issued` cycle, not an edit; the cancellation primitive is a sibling row (see `cancellationOf`).
- **Stornorechnung is a sibling row.** A cancel call against an issued invoice creates a new row with its own `id`, a `ST-YYYY-NNNN` number from the storno sub-sequence, `cancellationOf` pointing at the original, line totals negated (sign-flipped lineTotal and unitPrice values), and `totals` the exact negation of the original's `totals`. The original row's `status` flips to `'cancelled'`; both rows persist forever. Project status is **not** auto-reverted on cancellation — the UI surfaces the gap (see [ui/invoices.md §8.16](ui/invoices.md#816-invoices-view)). The rendered Storno names its original by `number` and issue date: in the PDF text and as the preceding-invoice reference in `factur-x.xml` (EN 16931 BT-25, BT-26).
- **Signed amounts in `factur-x.xml`.** The XML renders each amount signed: the stored value for an invoice (TypeCode `380`), its negation for a Storno (`381` — the type code carries the sign). This covers lines, per-rate bands and header totals. A line whose signed `unitPrice` is negative renders as negative `BilledQuantity` and `ChargeAmount = |unitPrice|` (EN 16931 BR-27: no negative item net price). The mapping is render-only; stored values keep their sign.
- **Number format pinned at the DB.** `number` carries a CHECK constraint matching `^(RE|ST)-\d{4}-\d{4,}$` so a misshapen number cannot land even via raw SQL. The four-digit minimum allows growth past 9999 within a year without a schema migration. `number` is null on `status = 'draft'` rows and non-null on `'issued' | 'cancelled'`; a partial unique index over `number WHERE number IS NOT NULL` enforces uniqueness on the non-draft set.
- **Why JSONB lines.** Lines are part of the snapshot — they freeze at issuance and are read as a unit when the invoice renders. There is no analytic query workload across `lines` (no "sum every invoice line containing 'Anstrich' across all years"). The JSONB shape matches the lifecycle exactly (`Stripe Invoices` analogue, [ADR-0026 Alternatives Considered](../adr/0026-invoices-immutability-and-zugferd.md#alternatives-considered)). Adding a typed columns table would impose FK / ordering / per-row audit churn on data that is read once at render time.
- **Project linkage.** `projectId` is required and FK-enforced. An invoice belongs to exactly one project. The project's status flips to `abgerechnet` as part of the issuance transaction (see [api.md §14.2.14](api.md#14214-invoice-operations)). Multiple invoices may reference one project (e.g., a Storno + a fresh re-issued invoice).
- **Performance date is editable in draft, frozen at issuance.** `performanceDate` is the Leistungsdatum required by §14 UStG. It is required to issue (the API rejects an issue call when `performanceDate` is null). In the absence of an explicit user entry, drafts default `performanceDate` to the project's `plannedEnd` if available — the UI is the SSOT for this default. The field is frozen once `status = 'issued'`.
- **Totals are server-computed.** On every PATCH on a draft and on the issue call, the server re-computes `totals` from `lines` + `taxMode`. Client-supplied totals are refused ([api.md §14.4.2](api.md#1442-error-principles)). Per-rate subtotals are produced only for `taxMode = 'standard'`; `reverse_charge` produces `perRate: []` and `taxGrandTotal: 0`.
- **Money arithmetic is decimal.** Amounts are computed on their decimal values, not on binary floating point. Every line value and derived amount is a finite number. Rounding to 2 decimals is half away from zero, so a negated input rounds to the negated result. A per-rate `taxAmount` is its `netSubtotal × taxRate / 100`, rounded. The rendered PDF and `factur-x.xml` show each line's `quantity` and `unitPrice` without rounding (XML sign per _Signed amounts_).
- **Rendered artifact reference.** `renderedPdfBinaryDescriptorId` references the `attachment` row ([§5.13](#513-attachment)) the ZUGFeRD renderer writes at issuance ([ADR-0026 §Storage](../adr/0026-invoices-immutability-and-zugferd.md#storage-and-retention)); the invoice row holds only that reference. The row lives in the invoice namespace, apart from uploaded attachments:
  - **Off the attachment surface.** No attachment operation lists or addresses it ([AC-364](verification.md#1530-invoices)), so it cannot be hidden, purged, or read without `invoice:read`. Its only read path is `GET /api/invoices/:id/pdf`.
  - **Locked per object.** Its bytes carry their own Compliance Object Lock of `INVOICE_OBJECT_LOCK_DAYS` from the write ([architecture.md §11.14](architecture.md#1114-invoice-domain)), independent of the bucket-default retention.
  - **Restore keeps both.** The full-account import job restores an attachment that an envelope invoice references into the invoice namespace, with the same lock ([AC-365](verification.md#1514-data-exchange)).
- **Audit metadata follows §5.5.** `createdBy` / `updatedBy` / `createdAt` / `updatedAt` set by the server. After issuance only the cancellation flip writes `updatedAt`; no other mutation path is reachable.
- **Audit ancestor.** Invoice rows write `audit_log` entries with `entityType = 'invoice'`, ancestor `('project', projectId)` ([architecture.md §11.12](architecture.md#1112-audit-ancestor-link)) so the project-detail activity feed surfaces invoice events alongside attachment events under the same indexed predicate.

### 5.16 Invoice Sequence Entity

The gapless year-scoped counter feeding `Invoice.number` allocation at issuance time. Rationale and rejected alternatives (`SERIAL` / `IDENTITY` leak gaps on rollback) are pinned by [ADR-0026 §Data model](../adr/0026-invoices-immutability-and-zugferd.md#data-model).

```typescript
type InvoiceSequenceKind = 'invoice' | 'storno';

interface InvoiceSequence {
  year: number; // calendar year — composite key with `kind`
  kind: InvoiceSequenceKind; // 'invoice' for RE-YYYY-NNNN; 'storno' for ST-YYYY-NNNN
  nextValue: bigint; // monotonically increasing within (year, kind); starts at 1
  updatedAt: string; // ISO 8601 — bumped on every allocation
}
```

Design notes:

- **Composite primary key `(year, kind)`.** One row per `(calendar year, sequence kind)` pair; allocations are scoped to that key. A new `(year, kind)` row is **upserted on first use** in the same transaction as the first issuance of the year — the sequence table has no pre-seeding obligation.
- **Allocation is an atomic `INSERT … ON CONFLICT (year, kind) DO UPDATE SET next_value = next_value + 1 RETURNING next_value` inside the issuance transaction.** A single statement that collapses the first-of-year case (INSERT) and the steady-state case (DO UPDATE) into one race-free path; Postgres takes a row-exclusive lock on the row (equivalent to `SELECT FOR UPDATE` for serialization purposes) and reads + increments `next_value` in one statement. The formatted `number` is derived from `RETURNING - 1` (the pre-increment value); the invoice row is written in the same transaction. The row lock is held until commit; a rollback returns the value to the sequence (the increment never persists), which is the gapless guarantee.
- **`bigint` for headroom.** `nextValue` is bigint so a deployment cannot mathematically exhaust a year's namespace; the four-digit-minimum format in §5.15 widens past 9999 without a schema migration.
- **Persistence principle.** The atomic-upsert pattern is generalized in [§6.13](#613-gapless-sequence-allocation) so future gapless counters can reuse the shape without re-arguing the choice against `SERIAL`.

### 5.17 Company Profile Entity

The single-row table carrying the issuing company's identity — the source from which every issued invoice's `issuer` snapshot is taken ([§5.15](#515-invoice-entity)). Single-tenant by [ADR-0001](../adr/0001-generalized-system-with-configurable-customer-specifics.md), so the singleton shape is correct without a tenant key.

```typescript
// `TaxMode` is defined in §5.15 and reused here.

interface CompanyProfile {
  // Singleton — enforced by a CHECK on a fixed primary key (parity with `meta_backup_status.singleton`).
  companyName: string; // required, non-empty
  address: { street: string; zip: string; city: string }; // all three components required
  taxId: string; // Steuernummer — required, non-empty
  ustId?: string; // USt-IdNr. — required, non-empty; empty only on an incomplete stored row (see Required fields)
  iban?: string; // always structurally optional; the renderer emits a payment block iff `iban` is present
  accentColor?: string; // hex; nullable — document styling for the rendered invoice only, never an app-theme override; the renderer falls back to the brand accent's light variant (AC-362)
  footerText?: string; // free German text printed at the foot of every rendered invoice
  defaultTaxMode: TaxMode; // pre-fills new invoice drafts; editable per-draft until issuance

  updatedAt: string; // ISO 8601
  updatedBy?: string; // UserAccount.id
  version: number; // server-managed concurrency token — §6.4
}
```

Design notes:

- **Singleton invariant.** Exactly one row exists. The row is pre-seeded by the baseline migration with empty mandatory fields so write paths are always upserts rather than first-writes. The DB enforces the singleton via a CHECK constraint on a constant primary key (parity with [§5.9](#59-backup-status-entity)).
- **Owner-only mutation surface.** Every authenticated role may read; writes are owner-only, enforced by the route-layer role check (no dedicated `company_profile:read` / `company_profile:write` keys are introduced). The CRUD shape is `GET` + `PUT` (upsert), no `POST` / `DELETE`. The mutation goes through the single-write-path helper ([architecture.md §11.3](architecture.md#113-state-layer-behavioral-contract)); the audit entity type is `'company_profile'` (added to `AuditEntityType` alongside `'invoice'` — [§5.10](#510-audit-log-entity)).
- **Required fields.** `companyName`, `address.{street,zip,city}`, `taxId` and `ustId`, all non-empty. Enforced at upsert ([AC-303](verification.md#1531-company-profile)) and at issuance ([AC-305](verification.md#1531-company-profile), [api.md §14.4](api.md#144-error-handling) `COMPANY_PROFILE_REQUIRED`). The stored row can still be incomplete: pre-seeded empty, or restored by import. Rationale for `ustId`: [ADR-0026 § Compliance boundary](../adr/0026-invoices-immutability-and-zugferd.md#compliance-boundary).
- **Snapshot at issuance, not at draft creation.** Drafts read the live row for pre-fill (default tax mode), but the actual `Invoice.issuer` block is snapshotted at the issue call — never earlier. A draft created today and issued next month carries next month's company profile, not today's. This matches the standard ERP "as of the issue date" expectation.
- **`defaultTaxMode` is a tenant default, not a per-user preference.** Stored on the singleton row, edited by the owner via the company-profile form ([ui/daten.md §8.11.4](ui/daten.md#8114-company-profile)); it does not live on the user record. New invoice drafts pre-fill `taxMode` from this value; the draft author edits per-invoice as needed (e.g. reverse charge for Bauleistungen performed as a subcontractor). Listed in [architecture.md §12.2](architecture.md#122-company-configurable-settings) as a `[C]` value — the default is set per deployment by the owner, not at deploy time.
- **Logo is not on this row.** The company logo is a deploy-time branding asset (`BRANDING.mark.logo`, [ADR-0001](../adr/0001-generalized-system-with-configurable-customer-specifics.md)), served from the static build and read by the invoice renderer at issuance. It is not per-installation business data, so it neither lives on this table nor rides the export envelope. See [architecture.md §12.2](architecture.md#122-company-configurable-settings).

### 5.18 Data Exchange Job

One export or import run. Behavior: [verification.md §15.14](verification.md#1514-data-exchange).

| Field         | Constraint                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`        | `export` or `import`                                                                                                                                                              |
| `status`      | `pending` (created; an import's upload not complete) → `running` → `ready`; any in-progress job can end `failed`. In progress: `pending` or `running`; ended: `ready` or `failed` |
| Progress      | Files and bytes done and in total; the current item                                                                                                                               |
| `errorDetail` | The failure reason; set only when `failed`                                                                                                                                        |

---

## 6. Persistence Principles

The product specification defines persistence behavior, not a concrete database technology or schema.

### 6.1 Durability

- Project data must survive page reloads, browser restarts, and deployment restarts.
- The application must read and write data only through a backend/API boundary.

### 6.2 Entity Extraction

The persistence design must support extraction of additional entities without rewriting existing domain logic.

### 6.3 Record Identity

- Every persisted entity must have a stable, opaque ID.
- IDs must not encode workflow state, dates, or company-specific semantics.

### 6.4 Concurrency

Low write concurrency is assumed. A write to a versioned entity based on a stale read is still rejected, never applied: an issued invoice is frozen ([§6.14](#614-immutability-of-issued-invoices)) together with the company profile snapshotted into it, and a whole-form customer save silently reverts fields the saver never touched — rarity does not make either acceptable.

- **State transitions** use optimistic concurrency on `status` — a transition is rejected as a conflict if the project's status has moved since the client's last read (see [AC-94](verification.md#1517-data-integrity)). The client should refetch and present the new state.
- **Edits** to Customer, Invoice and Company Profile use optimistic concurrency on `version`, a server-managed integer. Every committed API write to the row changes it ([AC-378](verification.md#1517-data-integrity)). Two exceptions: an issued or cancelled invoice is frozen, so its version no longer changes; database-level cascades ([§6.6](#66-referential-integrity)) do not change it.
- **Versioned operations** (saving the customer edit form; input `expectedVersion` in [api.md](api.md)) carry the version their edit started from. A mismatch is rejected with `VERSION_CONFLICT` and nothing is written ([AC-375](verification.md#1517-data-integrity), [AC-376](verification.md#1517-data-integrity)). The check and the write are atomic: of two writes carrying the same current version, exactly one commits ([AC-381](verification.md#1517-data-integrity)).
- **Check order.** Request-shape validation first — a missing `expectedVersion` is a validation error ([AC-377](verification.md#1517-data-integrity)). Then: not found and archived ([AC-499](verification.md#1512-projects), [AC-513](verification.md#1530-invoices)); the invoice state checks (`INVOICE_FROZEN`, issue on a non-draft); the version check; business-rule checks (e.g. the issuance preconditions in [api.md §14.2.14](api.md#14214-invoice-operations)).
- **Not versioned.** Project edits (Update project, Update dates) are last-write-wins: the detail page saves one field at a time, so a lost update needs two users on the same field at once — rare, and recoverable from the audit `before`. A project-wide `version` would instead reject an edit to one field whenever anything else on the project moved (a transition, an assignment, the issuance flip), discarding the user's input. Lifecycle operations — project archive / restore / purge, customer delete — act on the row's existence, not its content; their preconditions are state checks ([§6.9](#69-soft-deletes)). Delete draft is versioned: discarding a draft is a judgement on its content. Invoice cancel — its target is frozen. Attachments — own state checks ([verification.md §15.26](verification.md#1526-attachments)). Users and notification rules — low-stakes rows whose stale overwrite freezes nothing.
- **Customer corrections on drafts.** The draft write a customer edit causes ([§5.15](#515-invoice-entity)) carries no `expectedVersion`. It evaluates each field against the draft's latest committed state and serializes with Update, Delete and Issue on that draft: an override committed first stays, a draft deleted or issued first is untouched, and an operation carrying the pre-correction version is rejected with `VERSION_CONFLICT` ([AC-546](verification.md#1530-invoices)).
- **Not exported.** `version` is a concurrency token, not business data: the export archive omits it ([§5.8](#58-export-archive)) and import sets it fresh. No stale client survives an import — it ends every session ([AC-597](verification.md#1514-data-exchange)).

### 6.5 Schema Evolution

- The persistence layer must support schema evolution via versioned migrations. The database can be created from scratch by running all migrations in order.
- No manual database resets as the primary upgrade strategy.
- Migrations are versioned and reproducible.
- Seed data is separate from migrations — loaded by a distinct operation, not baked into migration files. This allows re-seeding or clearing seed data without re-running schema changes.

### 6.6 Referential Integrity

- The database enforces foreign keys where relationships exist (e.g., `Session.userId` references `UserAccount.id`, `Project.customerId` references `Customer.id`, `Project.createdBy`/`updatedBy` reference `UserAccount.id`).
- **`Invoice.projectId`** references `Project.id`. Hard-deleting (purging) a project that carries any **issued or cancelled** `Invoice` row is rejected — those rows are issued artifacts whose PDFs are Object-Locked ([§6.14](#614-immutability-of-issued-invoices)) and cannot cascade away with their parent. **Draft** invoices (`status = 'draft'`) were never issued and cascade-delete with the project via FK; the audit trail is unaffected because drafts produce no `invoice:issue` audit row.
- **`Invoice.cancellationOf`** is a nullable self-FK on `invoices.id`; non-null only on Storno rows. The original-invoice row referenced by `cancellationOf` cannot be hard-deleted while the Storno row exists (parity with the project FK above).
- **Exception**: `UserAccount.createdBy`/`updatedBy` are nullable UUIDs with no FK constraint. A self-referential FK on the users table would complicate bootstrapping and deletion without adding meaningful integrity.
- Orphaned records are not acceptable.

### 6.7 Timestamps

Timestamp ownership rules are defined in section 5.5. Additionally, `statusChangedAt` is set by the server on state transitions, never by client input.

**Storage vs. API representation**: the database stores timestamps with timezone awareness. The API serializes them as ISO 8601 strings (e.g., `"2026-04-10T14:30:00.000Z"`). The client receives and sends ISO 8601 strings; the persistence layer handles conversion transparently. The spec uses `string` (ISO 8601) in entity type definitions to describe the API contract, not the storage type.

### 6.9 Soft Deletes

- Users can be deactivated or hard-deleted: [verification.md §15.13](verification.md#1513-user-management). Deactivation preserves assignment history, and is the remedy when an issued or cancelled invoice names the user: the invoice is frozen ([§6.14](#614-immutability-of-issued-invoices)) and its author stays traceable.
- Projects are archived (`deleted`), not deleted ([ADR-0017](../adr/0017-soft-delete-as-board-archive.md)). Archiving, restoring and permanently deleting a project: [verification.md §15.12](verification.md#1512-projects).
  - Deleting a customer with its archived projects: [verification.md §15.11](verification.md#1511-customer-management).

### 6.10 Audit Log Retention

- `audit_log` entries are retained for a rolling window of 90 days **[C]** (see [architecture.md §12.2](architecture.md#122-company-configurable-settings)), aligned with the Layer 2 backup window ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)) and the cross-surface retention choice recorded in [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md).
- A scheduled cleanup job removes entries older than the window. Removing entries via this job is the only delete path on the table; every other application path is append-only.
- Each cleanup run is itself recorded — not in `audit_log` (the scope is domain entities only, per [§5.10](#510-audit-log-entity)), but in the structured operational logger, tagged as a system event. Rationale: keeping retention out of `audit_log` preserves the "append-only from the application" invariant for callers reading the activity feed; retention visibility lives in operational logs alongside other scheduled-job outputs.
- **Operational-log contract.** Each run emits exactly one structured log line at `info` level with the following fields: `event = 'audit-retention-cleanup'` (fixed discriminator), `window_days` (integer — the configured retention window applied, from the `[C]` catalogue above), `removed_count` (non-negative integer — rows deleted in the run; `0` on a no-op run), `ran_at` (ISO 8601 timestamp of the run). An operator verifies retention by querying the operational log for `event = 'audit-retention-cleanup'`; the Aktivität UI ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed), [ui/management.md §8.13](ui/management.md#813-audit-view)) is _not_ the verification surface — it deliberately omits retention events to keep the domain-entity scope intact. The retention of the operational log line itself follows whatever operational-log retention the deployed environment enforces — this spec does not pin a separate retention for system log lines.
- Retention applies uniformly to all entity types; there is no per-entity-type override.

### 6.13 Gapless Sequence Allocation

- A gapless sequence is an integer counter whose advancement is **coupled to the commit of a using transaction** — a rollback returns the value to the pool, never leaving a gap. Postgres `SERIAL` / `IDENTITY` is incompatible by design (they advance on every insert attempt, including rolled-back ones).
- The canonical pattern is a dedicated counter table whose row is allocated by a single `INSERT … ON CONFLICT (key) DO UPDATE SET next_value = next_value + 1 RETURNING next_value` inside the using transaction — Postgres takes a row-exclusive lock equivalent to `SELECT FOR UPDATE` for the duration of the transaction. The lock is held until commit; the row's `nextValue` is incremented and read atomically in the same statement; the first-of-key case (INSERT) and the steady-state case (DO UPDATE) collapse into one race-free path; if the transaction rolls back, the increment never persists.
- The pattern is reusable for any future counter with gapless semantics. The current consumer is `invoice_sequence` ([§5.16](#516-invoice-sequence-entity)) per [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md); allocations are scoped to `(year, kind)` composite keys.
- The using transaction commits the counter increment, the using row's insert, the audit row, and any byte-side write (e.g., a rendered artifact's binary descriptor) atomically. Splitting the counter advancement out of the using transaction breaks the gapless guarantee.
- **Restore to an earlier state.** A Layer 2 restore drops rows committed after the backup snapshot, but their invoice numbers already reached customers. Before issuance resumes, every `invoice_sequence` `(year, kind)` advances past every number that may have been issued since — mechanism in [AC-368](verification.md#1522-backup-and-recovery). A gap is acceptable; a reissued number is not (§14 Abs. 4 Nr. 4 UStG). An import never lowers the counter ([AC-369](verification.md#1514-data-exchange)).

### 6.14 Immutability of Issued Invoices

- An `invoices` row with `status = 'issued'` is **write-once** at the persistence layer. The only field that may transition is `status: 'issued' → 'cancelled'`, paired with the creation of a sibling Storno row ([§5.15](#515-invoice-entity)).
- The application enforces immutability at every write surface: the API rejects mutations on issued rows ([api.md §14.4](api.md#144-error-handling) `INVOICE_FROZEN`), the service layer refuses to dispatch an update that touches a frozen row, and the persistence layer is the last line of defense — direct DB writes to issued rows other than the cancellation flip are out of contract.
- Rationale: consistency of the system's own outputs — an issued row must agree with its Object-Locked PDF. Retention and legal obligations stay with the operating company ([ADR-0026 §Compliance boundary](../adr/0026-invoices-immutability-and-zugferd.md#compliance-boundary)). A correction is a fresh `draft → issued` cycle producing a new sibling row, not an edit. See [ADR-0026 §State machine](../adr/0026-invoices-immutability-and-zugferd.md#state-machine).
- An import never removes an issued or cancelled invoice ([AC-367](verification.md#1514-data-exchange)). Drafts carry no number and are not protected.
- Object-storage retention on the rendered PDF/A-3 ([architecture.md §11.14](architecture.md#1114-invoice-domain)) is the storage-layer backstop on the artifact bytes; this principle is the row-side counterpart.

---

## 7. Seed Data Specification

The seed dataset is loaded into the database on initial setup and provides a realistic snapshot.

The seed operation must be safe to run on an empty database. Re-seeding an existing database drops and recreates all seed records. This is a development/demo operation, not a production upgrade path.

The loader assembles users and business data into one in-memory import ([§5.8](#58-export-archive)) and applies it through the same import code path the import job uses, so every seed run exercises the import contract.

### 7.1 Project Dataset

**19 projects**, distributed to create a realistic snapshot with visible action-state accumulation:

| State           | Count | Notes                                                                      |
| --------------- | ----- | -------------------------------------------------------------------------- |
| Anfrage         | 2     | Recent, no dates planned. One received yesterday, one 10 days ago (stale). |
| Angebot         | 2     | One sent 3 days ago, one sent 18 days ago (exceeds aging threshold).       |
| Beauftragt      | 2     | Confirmed, no dates yet.                                                   |
| Geplant         | 2     | Dates assigned, workers assigned.                                          |
| In Arbeit       | 3     | Currently on-site. One slightly past `plannedEnd`.                         |
| Abnahme         | 1     | Waiting for customer walk-through.                                         |
| Rechnung fällig | 3     | **Critical accumulation** — demonstrates the core value.                   |
| Abgerechnet     | 2     | Invoice sent, waiting for payment.                                         |
| Erledigt        | 2     | Recently completed and paid.                                               |

### 7.2 User Dataset

| Username      | Display Name           | Roles      | Notes                                            |
| ------------- | ---------------------- | ---------- | ------------------------------------------------ |
| `inhaber`     | Thomas Berger          | owner      | Default admin account                            |
| `buero`       | Maria Schmidt          | office     | Office manager                                   |
| `arbeiter1`   | Jan Nowak              | worker     | Field worker                                     |
| `arbeiter2`   | Lukas Fischer          | worker     | Field worker                                     |
| `buchhalter`  | Petra Weiß             | bookkeeper | External bookkeeper                              |
| `deaktiviert` | Ehemaliger Mitarbeiter | worker     | Inactive — exercises the soft-delete path (§6.9) |

All seed users have a default password: `changeme` **[C]**. The seed loader must log a warning that default passwords are in use and must be changed.

In the default configuration, the `owner` role carries administrator privileges (user management access). This mapping is configurable **[C]**.

Names are assumed and fictional (per [ADR-0001](../adr/0001-generalized-system-with-configurable-customer-specifics.md)).

### 7.3 Customer Dataset

**21 customers**, covering a range of data completeness and project associations:

| Name                      | Phone           | Email                    | Address                                 | Notes                                 |
| ------------------------- | --------------- | ------------------------ | --------------------------------------- | ------------------------------------- |
| Familie Müller            | +49 221 1234567 | mueller@example.de       | Hauptstr. 12, 51465 Bergisch Gladbach   | Stammkunde seit 2019                  |
| Schmidt GmbH              | +49 221 9876543 | info@schmidt-gmbh.de     | Industriestr. 8, 50968 Köln             | Gewerblicher Kunde                    |
| Petra Wagner              | +49 2202 54321  | p.wagner@email.de        | Am Stadtpark 3, 51429 Bergisch Gladbach | —                                     |
| Hausverwaltung Rheinblick | +49 221 5551234 | verwaltung@rheinblick.de | Rheinuferstr. 44, 50996 Köln            | Mehrere Objekte                       |
| Andreas Hoffmann          | +49 221 7773456 | —                        | Lindenweg 7, 51109 Köln                 | —                                     |
| Familie Yılmaz            | +49 2202 88990  | yilmaz.familie@email.de  | Gartenstr. 21, 51465 Bergisch Gladbach  | —                                     |
| Karl-Heinz Becker         | —               | —                        | —                                       | Nur Telefonkontakt — Nummer verlegt   |
| Weber Immobilien KG       | +49 221 4449876 | kontakt@weber-immo.de    | Aachener Str. 155, 50931 Köln           | Rahmenvertrag für Instandhaltung      |
| Schulz & Partner PartG    | +49 2204 61234  | office@schulz-partner.de | Kölner Str. 90, 51429 Bergisch Gladbach | Import aus orgaMAX, noch kein Projekt |
| Monika Engel              | +49 221 3336789 | —                        | —                                       | Import aus orgaMAX, noch kein Projekt |

Design notes:

- Customers with full data (name, phone, email, address): Familie Müller, Schmidt GmbH, Petra Wagner, Hausverwaltung Rheinblick, Familie Yılmaz, Weber Immobilien KG.
- Customers with minimal data (name only or name + phone): Karl-Heinz Becker (name only), Andreas Hoffmann (no email).
- Customers linked to multiple seed projects: Familie Müller (2 projects), Schmidt GmbH (2 projects), Hausverwaltung Rheinblick (3 projects).
- Customers with no projects yet: Schulz & Partner PartG, Monika Engel — these represent records imported from an external system (e.g., orgaMAX) before project creation.
- **Site-address divergence demo.** At least one project of a Hausverwaltung-style customer carries a non-null `siteAddress` (§5.1) different from the customer's Rechnungsadresse — for example, the seeded `Schmidt Hausverwaltung` (Rechnungsadresse `Kölner Str. 45, 51429 Bergisch Gladbach`) carries a project at the divergent site `Goethestr. 18, 51103 Köln`. Every other seed project leaves `siteAddress` null so the fallback rendering ("(Kundenadresse)") is also exercised on the demo data.

### 7.4 Edge Cases

The seed dataset should include varied data (missing dates, minimal fields, aged entries) to exercise edge cases.

### 7.5 Date Range

Seed data dates must be **relative to the deployment date**, not hardcoded calendar dates. The seed loader calculates dates relative to "today" so the data is meaningful whenever it is first loaded.

The overall range covers roughly the past 4 weeks to the coming 4 weeks, providing meaningful content for both views.

### 7.6 Realism

Project titles, customer names, and addresses should be domain-representative for a German Handwerker company (see [index.md, section 4.1](index.md#41-company-profile)). Example: "Fassadenanstrich Müller", "Treppenhaussanierung Schmidt", "Malerarbeiten Bürokomplex Weber".
