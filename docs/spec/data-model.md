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
| `ustId`                  | USt-IdNr., at most 50 characters; a reverse-charge invoice needs it on its recipient ([AC-697](verification.md#1530-invoices)) |
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

### 5.9 Backup Status

The outcome of the latest backup run, of the latest drill that was not skipped, and of the latest status-mirror write; earlier outcomes are not kept. Behavior: [verification.md §15.22](verification.md#1522-backup-and-recovery).

| Field             | Meaning                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| `lastBackupAt`    | Time of the last backup run, whatever its outcome; `null` before the first             |
| `lastBackupOk`    | `true` when the last backup run uploaded a verified backup; `false` before the first   |
| `lastBackupError` | Why the last backup run failed; `null` when it succeeded                               |
| `lastDrillAt`     | Time of the last drill; `null` before the first                                        |
| `lastDrillOk`     | `true` when the last drill's restore matched its manifest; `null` before the first     |
| `lastDrillError`  | Why the last drill failed; `null` when it succeeded                                    |
| `mirrorError`     | Why the last status-mirror write failed; `null` before the first and once one succeeds |
| `updatedAt`       | Time of the last write                                                                 |

**Status mirror.** An unencrypted object in the off-site store, readable without the application ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)). It is a JSON object holding every field above except `mirrorError`, `null` when unset, times in ISO 8601; an error field names only the failing step and, for a mismatch, the table.

### 5.10 Audit Log Entity

One entry per recorded change to an audited entity — the `entityType` values below. Behavior: [verification.md §15.23](verification.md#1523-audit-log).

| Field                 | Meaning                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createdAt`           | When the change took effect                                                                                                                                                                                                                            |
| `actorKind`           | `user` — a signed-in user made the change; `system` — no user did                                                                                                                                                                                      |
| `actorId`             | The user who made the change; `null` for `system`, and once that user is deleted                                                                                                                                                                       |
| `actorReason`         | For `system`: what made the change, e.g. `first-run-bootstrap`, `hidden-reaper`, `data_import`; `null` for `user`                                                                                                                                      |
| `entityType`          | `project`, `customer`, `user`, `project_worker` (a worker's assignment to a project), `attachment`, `invoice`, `company_profile`, or `data_import` (an export or import job, [AC-332](verification.md#1514-data-exchange))                             |
| `entityId`            | The changed entity; for `project_worker`, the project                                                                                                                                                                                                  |
| `entityLabel`         | The entity's name when the change was recorded — for `project_worker`, the worker's; `null` when it has none                                                                                                                                           |
| `ancestorEntityLabel` | The name, when the change was recorded, of the project the entity belongs to: the project itself, or the project of a `project_worker`, `attachment` or `invoice`; `null` for every other type                                                         |
| `action`              | What happened — one of the actions below                                                                                                                                                                                                               |
| `payload`             | The change's details: for an update, each updated field before and after; for a creation, the values set; otherwise what the action records — e.g. a purged project's number and title, a job's counts or error. Never a password or an encryption key |

| Action                                                              | On                                                          | Meaning                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `create`                                                            | `project`, `customer`, `user`, `project_worker`, `invoice`  | Created                                                                                         |
| `update`                                                            | `project`, `customer`, `user`, `invoice`, `company_profile` | Changed                                                                                         |
| `delete`                                                            | `customer`, `user`, `project_worker`                        | Deleted                                                                                         |
| `archive`, `restore`                                                | `project`                                                   | Archived, restored from the archive ([ADR-0017](../adr/0017-soft-delete-as-board-archive.md))   |
| `purge`                                                             | `project`                                                   | Permanently deleted                                                                             |
| `transition:forward`, `transition:backward`                         | `project`                                                   | Status moved forward, backward                                                                  |
| `deactivate`, `reactivate`, `password-reset`, `password-change`     | `user`                                                      | As named                                                                                        |
| `attachment:add`, `attachment:hide`, `attachment:restore`           | `attachment`                                                | Upload completed, moved to the Papierkorb, restored from it                                     |
| `attachment:purge`                                                  | `attachment`                                                | Removed for good from the Papierkorb by the system ([AC-426](verification.md#1526-attachments)) |
| `invoice:delete`, `invoice:issue`, `invoice:cancel`                 | `invoice`                                                   | Draft deleted, invoice issued, invoice cancelled                                                |
| `export_built`, `export_failed`, `import_restored`, `import_failed` | `data_import`                                               | The job's outcome                                                                               |

### 5.11 Notification Rule

A rule names an event class and who receives a push when an event of it fires. The event classes are closed: users choose among them and never define one ([ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md)). Behavior: [verification.md §15.24](verification.md#1524-notifications).

| Field                    | Meaning                                                                  | Constraint                                                                             |
| ------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `eventClass`             | What the rule fires on                                                   | One of the classes below                                                               |
| `stateFilter`            | `Ziel-Status`: the status a project moved to; empty = any                | Status-move classes only; a workflow state ([index.md §3](index.md#3-workflow-states)) |
| `roles`                  | Recipients: the users holding any of these roles                         | Roles of the role set ([index.md §4.2](index.md#42-roles))                             |
| `includeAssignedWorkers` | Recipients: the workers assigned to the event's project after the change | Project classes only                                                                   |
| `userIds`                | Recipients: these users                                                  | Active users                                                                           |
| `enabled`                | Only an enabled rule fires                                               | —                                                                                      |

A rule names at least one recipient: a role, the assigned workers, or a user. Rules may overlap; a user is still a recipient once ([AC-192](verification.md#1524-notifications)).

| Event class                   | Label **[C]**                    | Fires when                                                                                   | Project class |
| ----------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- | ------------- |
| `project.transition_forward`  | `Projekt-Statuswechsel vorwärts` | A project's status moves forward (status move)                                               | yes           |
| `project.transition_backward` | `Projekt-Statuswechsel zurück`   | A project's status moves backward (status move)                                              | yes           |
| `project.archived`            | `Projekt archiviert`             | A project is archived                                                                        | yes           |
| `project.assignment_changed`  | `Mitarbeiter-Zuweisung geändert` | A worker is assigned to or removed from a project                                            | yes           |
| `project.attachment_added`    | `Datei hinzugefügt`              | An upload to a project completes ([AC-407](verification.md#1526-attachments))                | yes           |
| `backup.failed`               | `Backup-Warnung`                 | The backup badge is amber or red([AC-663](verification.md#1533-threshold-monitor))           | no            |
| `disk.threshold_reached`      | `Speichergrenze erreicht`        | Stored data reaches the storage warn band ([AC-667](verification.md#1533-threshold-monitor)) | no            |

### 5.12 Push Subscription

A device a user registered for their pushes. A user may register several devices; a device belongs to one user at a time ([AC-656](verification.md#1524-notifications)). Behavior: [verification.md §15.24](verification.md#1524-notifications).

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

A bill for a project's work, issued as an e-invoice. A project may have several — an invoice, its Storno, a corrected invoice. Behavior: [verification.md §15.30](verification.md#1530-invoices). Design: [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md).

| Field                    | Constraint                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | UUID                                                                                                                                                                                                                                                                                                                                              |
| `projectId`              | The billed project                                                                                                                                                                                                                                                                                                                                |
| `status`                 | `draft` → `issued` → `cancelled`. A Storno is born `issued` and stays so                                                                                                                                                                                                                                                                          |
| `number`                 | Empty on a draft. `RE-YYYY-NNNN` for an invoice, `ST-YYYY-NNNN` for a Storno: the issue year, then the sequence value ([§5.16](#516-invoice-sequence-entity)) in at least four digits                                                                                                                                                             |
| `cancellationOf`         | On a Storno, its original; empty otherwise                                                                                                                                                                                                                                                                                                        |
| `recipient`              | `name`; `address` — `street`, `zip`, `city`, counting as one field; `ustId` (USt-IdNr.). Surrounding whitespace, and blank versus absent, make no difference to whether a field differs from the customer's. A field the user has not set follows the customer ([AC-523](verification.md#1530-invoices), [AC-543](verification.md#1530-invoices)) |
| `lines`                  | At most 500                                                                                                                                                                                                                                                                                                                                       |
| `lines[].description`    | 1 to 1000 characters                                                                                                                                                                                                                                                                                                                              |
| `lines[].quantity`       | Greater than 0                                                                                                                                                                                                                                                                                                                                    |
| `lines[].unit`           | Free text, at most 100 characters — `Stück`, `h`, `m²`, `pauschal`, …                                                                                                                                                                                                                                                                             |
| `lines[].unitPrice`      | EUR net of VAT; at least 0, at most 4 decimals. Negated on a Storno                                                                                                                                                                                                                                                                               |
| `lines[].taxRate`        | Percent: `7` or `19` under `standard`; `0`, `7` or `19` under `reverse_charge`                                                                                                                                                                                                                                                                    |
| `lines[].lineTotal`      | `quantity × unitPrice`, rounded                                                                                                                                                                                                                                                                                                                   |
| `taxMode`                | `standard` or `reverse_charge`                                                                                                                                                                                                                                                                                                                    |
| `performanceDate`        | The Leistungsdatum (§14 UStG); a calendar date                                                                                                                                                                                                                                                                                                    |
| `issueDate`              | Set at issuance ([AC-690](verification.md#1530-invoices))                                                                                                                                                                                                                                                                                         |
| `issuer`                 | Set at issuance from the company profile ([§5.17](#517-company-profile-entity)): `companyName`, `address`, `taxId`, `ustId`, `iban`, `footerText`                                                                                                                                                                                                 |
| `profile`                | `zugferd-en16931`                                                                                                                                                                                                                                                                                                                                 |
| `totals.perRate[]`       | Under `standard`, per tax rate: `taxRate`, `netSubtotal`, `taxAmount` (`netSubtotal × taxRate / 100`, rounded). Empty under `reverse_charge`                                                                                                                                                                                                      |
| `totals.netGrandTotal`   | Sum of the line totals                                                                                                                                                                                                                                                                                                                            |
| `totals.taxGrandTotal`   | Sum of the per-rate tax amounts; 0 under `reverse_charge`                                                                                                                                                                                                                                                                                         |
| `totals.grossGrandTotal` | Net plus tax                                                                                                                                                                                                                                                                                                                                      |
| `cancellationReason`     | On a Storno, the user's reason; at most 2000 characters                                                                                                                                                                                                                                                                                           |
| `version`                | Concurrency token ([§6.4](#64-concurrency))                                                                                                                                                                                                                                                                                                       |
| `createdAt`, `updatedAt` | Server time                                                                                                                                                                                                                                                                                                                                       |
| `createdBy`, `updatedBy` | The acting user                                                                                                                                                                                                                                                                                                                                   |

**Amounts.** Computed on decimal values. Rounding is to 2 decimals, half away from zero, so a negated input rounds to the negated result. Every amount is finite.

**Required to issue.** `performanceDate`; at least one line; the recipient's `name` and complete `address`; under `reverse_charge`, the recipient's `ustId`.

**Rendered document** — one per issued invoice and Storno:

- A PDF/A-3 with an embedded `factur-x.xml` in the ZUGFeRD EN 16931 (Comfort) profile, CII syntax.
- Shows the issuer with the brand logo ([AC-362](verification.md#1519a-brand-logo)), the recipient, number, issue and performance date, the lines with `quantity` and `unitPrice` unrounded, and the totals. The IBAN when `issuer.iban` is set; `issuer.footerText` at the foot; rules in the profile's accent color ([§5.17](#517-company-profile-entity)).
- `standard`: VAT per line and the per-rate breakdown. `reverse_charge`: no VAT, and `Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.`
- A Storno names its original's number and issue date — in the text and as the preceding-invoice reference (EN 16931 BT-25, BT-26).
- XML amounts are signed: as stored for an invoice (type code `380`), negated for a Storno (`381`), lines, per-rate bands and totals alike. A negative unit price renders as a negative quantity at the positive price (EN 16931 BR-27).
- Downloaded as `<number>_<recipient name>.pdf`, the name reduced to characters safe in a file name; `<number>.pdf` without one.

**Export archive** — the bookkeeper's export ([AC-717](verification.md#1530-invoices)):

- A zip named `Rechnungen_<scope>_<YYYY-MM-DD>.zip` — the export date in Germany — scope `auswahl` for a selection, else the filtered year or `alle`. At most 5000 invoices ([AC-718](verification.md#1530-invoices)).
- One `<number>.pdf` per invoice: its document as stored.
- `manifest.csv`: UTF-8 with byte-order mark, `;`-separated, CRLF line ends. Columns `Nr.`, `Datum` (DD.MM.YYYY), `Empfänger`, `Netto`, `USt`, `Brutto` (decimal comma, 2 decimals), `Status` (`Ausgestellt`, `Storniert`, `Storno`); one row per invoice, by issue date, then number, oldest first. Where a spreadsheet would read a recipient name as a formula, a `'` neutralizes it.

### 5.16 Invoice Sequence Entity

One counter per calendar year and kind — `invoice` for `RE-` numbers, `storno` for `ST-` numbers. Each starts at 1; only a committed issuance uses a value ([AC-694](verification.md#1530-invoices)), and only a restore or an import skips values ([§6.13](#613-gapless-sequence-allocation)). Restore and import: [§6.13](#613-gapless-sequence-allocation).

### 5.17 Company Profile Entity

The issuing company's identity, printed on every invoice. Exactly one exists ([AC-721](verification.md#1531-company-profile)). Behavior: [verification.md §15.31](verification.md#1531-company-profile). Screen: [ui/invoices.md §8.16.4](ui/invoices.md#8164-company-profile).

| Field                    | Constraint                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `companyName`            | Required; at most 200 characters                                                                                                                    |
| `address`                | `street` (at most 200 characters), `zip` (20), `city` (200); all required                                                                           |
| `taxId`                  | Steuernummer; required; at most 50 characters                                                                                                       |
| `ustId`                  | USt-IdNr.; required ([ADR-0026 § Compliance boundary](../adr/0026-invoices-immutability-and-zugferd.md#compliance-boundary)); at most 50 characters |
| `iban`                   | At most 50 characters                                                                                                                               |
| `accentColor`            | `#RGB` or `#RRGGBB`; colors the rendered invoice only. Unset: the brand accent ([architecture.md §12.5](architecture.md#125-theming-model))         |
| `footerText`             | At most 2000 characters                                                                                                                             |
| `defaultTaxMode`         | `standard` or `reverse_charge`; pre-fills new drafts ([AC-683](verification.md#1530-invoices)). `standard` on a new deployment                      |
| `version`                | Concurrency token ([§6.4](#64-concurrency))                                                                                                         |
| `updatedAt`, `updatedBy` | Server time; the acting user                                                                                                                        |

Required means non-empty. The stored profile can still lack one — on a new deployment, or after an import; issuing then fails ([AC-698](verification.md#1530-invoices)). The brand logo is deploy-time branding, not part of the profile ([architecture.md §12.2](architecture.md#122-company-configurable-settings)).

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
- **Versioned operations** (saving the customer edit form; input `expectedVersion` in [api.md](api.md)) carry the version their edit started from. A mismatch is rejected with `VERSION_CONFLICT` and nothing is written ([AC-375](verification.md#1517-data-integrity), [AC-699](verification.md#1530-invoices)). The check and the write are atomic: of two writes carrying the same current version, exactly one commits ([AC-381](verification.md#1517-data-integrity)).
- **Check order.** Request-shape validation first — a missing `expectedVersion` is a validation error ([AC-377](verification.md#1517-data-integrity)). Then: not found and archived ([AC-499](verification.md#1512-projects), [AC-513](verification.md#1530-invoices)); the invoice state checks (`INVOICE_FROZEN`, issue on a non-draft); the version check; business-rule checks (e.g. the issuance preconditions, [AC-696](verification.md#1530-invoices), [AC-697](verification.md#1530-invoices), [AC-698](verification.md#1530-invoices)).
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

### 6.13 Gapless Sequence Allocation

- An invoice number, once issued, is never issued again (§14 Abs. 4 Nr. 4 UStG); a gap is acceptable only after a restore or an import.
- After a database restore, numbering advances past every number that may have been issued since the backup ([AC-368](verification.md#1522-backup-and-recovery)). An import never lowers it ([AC-369](verification.md#1514-data-exchange)).

### 6.14 Immutability of Issued Invoices

- An issued or cancelled invoice never changes, except an issued one becoming cancelled ([AC-708](verification.md#1530-invoices)). A correction is a Storno and a new invoice. Its document stays as rendered, under the invoice lock ([AC-710](verification.md#1530-invoices)).
- An import never removes one ([AC-367](verification.md#1514-data-exchange)). Drafts carry no number and are not protected.

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
