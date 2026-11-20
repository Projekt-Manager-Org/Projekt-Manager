# API Specification

---

## 14. API Specification

The API is the boundary between the front end and all persistent state ([architecture.md §11.1](architecture.md#111-mandatory-constraints)). The front end's state layer is a client of this API (see [architecture.md §11.3](architecture.md#113-state-layer-behavioral-contract)).

### 14.1 Design Principles

- **Single source of truth.** The API is authoritative for all persisted data.
- **Stack-agnostic contract.** Operations, inputs, and outputs — not transport, URLs, or serialization.
- **Consistent error representation.** Machine-readable code + human-readable message (see [§14.4](#144-error-handling)).
- **Stateless requests.** Each request carries all context needed, including authentication.
- **Pagination-ready.** List operations accept `offset`/`limit`. The contract must support pagination even if the current data volume does not require it.
- **Stable list order.** List operations return rows in a deterministic order — a second fetch yields the same sequence, and pagination pages do not overlap or skip rows.
- **Timestamps managed server-side.** `createdAt`, `updatedAt`, `statusChangedAt` are set by the server, never by clients.

**Precedence.** This document is the normative contract. `docs/api/openapi.json` is a machine-readable artifact _generated from the implementation_ (AC-351) covering the request surface only; it is a derived view, not a second contract. Where the two disagree, this document wins and the divergence is a defect in the code or in §14.2 — never a reason to edit the generated file. See [ARCHITECTURE.md § API Surface](../../ARCHITECTURE.md#api-surface).

---

### 14.2 Operations

#### 14.2.0 Health

| Operation        | Input | Output                                                                | Notes                                                                                                                                                |
| ---------------- | ----- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Health check** | —     | status (`ok` or `degraded`), per-component checks (database, storage) | No authentication required. Returns degraded with component-level detail if any probe fails. Used by the deploy script for post-deploy verification. |

---

### 14.3 Authorization Rules

Every operation on protected data needs an active session ([AC-574](verification.md#154-authentication)). It also needs what the map below lists; a caller without it is refused ([AC-576](verification.md#1521-role-scoping)). Scope: [§15.21](verification.md#1521-role-scoping). Roles: [index.md §4.2](index.md#42-roles).

<!-- CHECKED:permissions-table:START — mirrors ROLE_PERMISSIONS (src/config/permissions.ts) over the production roles, pinned by src/config/__tests__/permissions.test.ts (AC-343). Edit the config, then this block. -->

| Role       | Permissions                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| owner      | attachment:hide, attachment:read, attachment:trash, attachment:write, audit:read, auth:change-password, customer:delete, customer:read, customer:write, data:export, data:restore, invoice:read, invoice:write, notifications:manage, project:create, project:dates, project:delete, project:purge, project:read, project:transition, project:update, user:delete, user:manage, user:read |
| office     | attachment:hide, attachment:read, attachment:trash, attachment:write, audit:read, auth:change-password, customer:read, customer:write, data:export, invoice:read, invoice:write, project:create, project:dates, project:delete, project:read, project:transition, project:update, user:read                                                                                               |
| worker     | attachment:hide, attachment:read, attachment:write, auth:change-password, customer:read, project:read                                                                                                                                                                                                                                                                                     |
| bookkeeper | attachment:read, auth:change-password, customer:read, invoice:read, project:read                                                                                                                                                                                                                                                                                                          |

<!-- CHECKED:permissions-table:END -->

| Area               | Operation                                                       | Needs                                                                                                                   |
| ------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Projects           | list, read, list workers                                        | `project:read`                                                                                                          |
|                    | create                                                          | `project:create`                                                                                                        |
|                    | edit, assign workers                                            | `project:update`                                                                                                        |
|                    | change dates                                                    | `project:dates`                                                                                                         |
|                    | transition                                                      | `project:transition`                                                                                                    |
|                    | archive, restore                                                | `project:delete`                                                                                                        |
|                    | delete permanently                                              | `project:purge`                                                                                                         |
| Customers          | list, read                                                      | `customer:read`                                                                                                         |
|                    | create, edit, extract from an email                             | `customer:write`                                                                                                        |
|                    | delete                                                          | `customer:delete`                                                                                                       |
| Attachments        | list, view, download, ZIP                                       | `attachment:read`                                                                                                       |
|                    | upload                                                          | `attachment:write`                                                                                                      |
|                    | hide                                                            | `attachment:hide`; a worker only their own uploads within the grace window ([AC-411](verification.md#1526-attachments)) |
|                    | list and restore the Papierkorb                                 | `attachment:trash`                                                                                                      |
| Invoices           | list, list years, read, PDF, export                             | `invoice:read`                                                                                                          |
|                    | create, edit, delete a draft, issue, cancel                     | `invoice:write`                                                                                                         |
| Company profile    | read                                                            | —                                                                                                                       |
|                    | edit                                                            | role `owner`                                                                                                            |
| Users              | list, read                                                      | `user:read`                                                                                                             |
|                    | create, edit, deactivate, reactivate, reset password            | `user:manage`                                                                                                           |
|                    | delete                                                          | `user:delete`                                                                                                           |
| Own account        | change password                                                 | `auth:change-password`                                                                                                  |
|                    | read, preferences, sign out, push subscription, realtime events | —                                                                                                                       |
| Data               | export, storage totals                                          | `data:export`                                                                                                           |
|                    | import                                                          | `data:restore`                                                                                                          |
| Backup status      | read                                                            | role `owner` ([AC-614](verification.md#1522-backup-and-recovery))                                                       |
| Audit log          | read                                                            | `audit:read`; office sees no destructive entries ([AC-182](verification.md#1523-audit-log))                             |
| Notification rules | list, read, create, edit, delete                                | `notifications:manage`                                                                                                  |

---

### 14.4 Error Handling

Every error response carries two components:

| Component                  | Purpose                               | Example                                                   |
| -------------------------- | ------------------------------------- | --------------------------------------------------------- |
| **Machine-readable code**  | Programmatic handling by the client   | `INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `NOT_PERMITTED` |
| **Human-readable message** | Display to the user (German, **[C]**) | `"Anmeldung fehlgeschlagen"`, `"Sitzung abgelaufen"`      |

An optional third component, `details`, may carry structured validation information (e.g., field-level errors from schema validation). Clients should handle its absence gracefully.

#### 14.4.1 Error Categories

The API must distinguish the following error categories. Each category has distinct client-side handling.

| Category                 | Meaning                                                                                                                                                                                                                                                         | Client behavior                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authentication error** | Credentials invalid, session expired, or session absent.                                                                                                                                                                                                        | Redirect to login screen. Show expiry message if session was previously valid.                                                                                 |
| **Authorization error**  | User is authenticated but lacks permission for the requested operation (e.g., changing another user's password).                                                                                                                                                | Show error message. Do not redirect to login.                                                                                                                  |
| **Validation error**     | Request is malformed or violates business rules (e.g., transition from `erledigt`, missing required field, invalid dates).                                                                                                                                      | Show error message. Revert optimistic update if applicable.                                                                                                    |
| **Not found**            | The requested entity (project or user ID) does not exist.                                                                                                                                                                                                       | Show error message. Re-fetch project list to sync state.                                                                                                       |
| **Route not found**      | No handler is registered for the request's method and URL — an unknown URL, or a known one under a verb it does not serve. Distinct from "Not found" above — the latter signals a known endpoint with an absent entity; this signals a stale client or a probe. | Show generic error message. Do not redirect.                                                                                                                   |
| **Gone**                 | The entity existed but is permanently unavailable; retry will not help (e.g., a Papierkorb row whose source bytes were lifecycle-reaped ahead of the row reaper, see [AC-424](verification.md#1526-attachments)).                                               | Show error message. Do not retry.                                                                                                                              |
| **Conflict**             | The mutation cannot proceed because the resource state has changed since it was read (e.g., concurrent state transition) or the operation conflicts with related state (e.g., deleting a customer with active projects).                                        | Refetch resource state. Optionally retry against the new state.                                                                                                |
| **Idempotency conflict** | A create request carried a client-supplied `id` that already identifies a row, but one or more user-supplied fields in the request body differ from the stored row ([AC-127](verification.md#1517-data-integrity)).                                             | Close the create form, refresh the affected list, surface the message. Do not retry the same id with the same body — the request is ambiguous by construction. |
| **Server error**         | Unexpected internal failure.                                                                                                                                                                                                                                    | Show generic error message. Do not expose internal details.                                                                                                    |
| **Rate limited**         | Too many requests in the configured time window.                                                                                                                                                                                                                | Show retry message. Back off before retrying.                                                                                                                  |

<!-- CHECKED:error-codes:START — mirrors ERROR_CODES (src/server/errors.ts), pinned by src/server/__tests__/error-codes.test.ts (AC-354). Edit the array, then this block. Not generated — see ARCHITECTURE.md § Design Decisions (documentation drift guards) for why. -->

The full set of machine-readable error codes: `INVALID_CREDENTIALS`, `UNAUTHENTICATED`, `SESSION_EXPIRED`, `NOT_PERMITTED`, `VALIDATION_ERROR`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `VERSION_CONFLICT`, `NOT_FOUND`, `ROUTE_NOT_FOUND`, `GONE`, `RATE_LIMITED`, `SCHEMA_VERSION_MISMATCH`, `TARGET_NOT_EMPTY`, `RESTORE_CONFIRMATION_MISMATCH`, `MISSING_USER_REFS`, `EXPORT_JOB_ACTIVE`, `IMPORT_JOB_ACTIVE`, `EXPORT_JOB_NOT_READY`, `UPLOAD_OFFSET_CONFLICT`, `UPLOAD_TOO_LARGE`, `UPLOAD_NOT_ACCEPTED`, `BULK_LIMIT_EXCEEDED`, `DEK_UNWRAP_FAILED`, `INVOICE_FROZEN`, `INVOICE_PROJECT_STATE`, `INVOICE_NOT_ISSUED`, `INVOICE_ALREADY_CANCELLED`, `DRAFT_NOT_EXPORTABLE`, `EXPORT_TOO_LARGE`, `COMPANY_PROFILE_REQUIRED`, `CUSTOMER_HAS_INVOICES`, `PROJECT_HAS_INVOICES`, `USER_HAS_INVOICES`, `IMPORT_DROPS_ISSUED_INVOICES`, `SERVER_ERROR`.

<!-- CHECKED:error-codes:END -->

`EXPORT_JOB_ACTIVE` / `IMPORT_JOB_ACTIVE` (409) signal a create request colliding with an export / import job already `pending` or `running` ([AC-331](verification.md#1514-data-exchange)); the response carries the active job's id so the client re-attaches rather than starting a second. `EXPORT_JOB_NOT_READY` (409) is a download requested before the build finished. `UPLOAD_OFFSET_CONFLICT` (409) is a resumable-upload chunk PATCHed at an offset other than the server's current one. `UPLOAD_NOT_ACCEPTED` (409) is a chunk PATCHed to an import job that is no longer `pending` — the upload already completed (the job is `running` or terminal); the normal client loop ends at `Upload-Length` before the flip, so this guards direct API misuse. A job id of the other kind is `NOT_FOUND` on every export / import job route. All five are conflict-category codes — the client resolves them by re-reading job / upload state, not by re-authenticating. `UPLOAD_TOO_LARGE` (413) is a resumable-upload chunk whose bytes would extend past the declared `Upload-Length`; the server offset does not advance and the client retries with at most the remaining length.

`TARGET_NOT_EMPTY` (409) is a conflict-category code; `RESTORE_CONFIRMATION_MISMATCH` (422) is a validation-category code ([§15.14](verification.md#1514-data-exchange)). `SCHEMA_VERSION_MISMATCH`, `MISSING_USER_REFS` and `IMPORT_DROPS_ISSUED_INVOICES` never reach a response; each fails an import job ([AC-593](verification.md#1514-data-exchange), [AC-367](verification.md#1514-data-exchange)). For `IMPORT_DROPS_ISSUED_INVOICES` the remedy is an archive exported after the latest issuance.

`VERSION_CONFLICT` (409) is a versioned edit whose `expectedVersion` no longer matches the stored row ([data-model.md §6.4](data-model.md#64-concurrency)); nothing was written. A conflict-category code, distinct from `CONFLICT` so the client runs stale-write recovery ([AC-379](verification.md#1517-data-integrity)) rather than a generic refetch.

`DEK_UNWRAP_FAILED` is also a specialization of the validation-error category (`422`) — a per-row attachment envelope cannot be unwrapped against the loaded binary keyring (corrupt envelope, or a key not in the keyring). The Service Worker translates the code to the [AC-244](verification.md#1526-attachments) "Schlüssel nicht verfügbar" placeholder render path.

The invoice-domain codes are specializations of the validation-error and conflict categories:

- **`INVOICE_FROZEN`** (`422`) — mutation rejected because the invoice is `issued` or `cancelled` ([data-model.md §6.14](data-model.md#614-immutability-of-issued-invoices)). Client should refetch and present a read-only viewer.
- **`INVOICE_PROJECT_STATE`** (`409`) — issue rejected because the parent project is not in `rechnung_faellig`. Client refetches the project status and surfaces the mismatch (the project may have moved while the draft was open).
- **`INVOICE_NOT_ISSUED`** (`409`) — cancel / download-PDF rejected on a draft. Client surfaces the message; the affordance should not have been presented (a client-state-drift indicator).
- **`INVOICE_ALREADY_CANCELLED`** (`409`) — cancel on a row whose `status` is already `'cancelled'`. Idempotent intent is acceptable, but the route does not silently succeed — the operator's view of the invoice should be refreshed before a re-cancel attempt.
- **`COMPANY_PROFILE_REQUIRED`** (`422`) — issue rejected because the singleton `company_profile` row lacks a required field ([data-model.md §5.17](data-model.md#517-company-profile-entity)). `details.missingFields` enumerates the missing field paths (e.g. `["companyName", "address.zip", "ustId"]`). Client routes the owner to the company-profile form ([ui/invoices.md §8.16.4](ui/invoices.md#8164-company-profile)).
- **`CUSTOMER_HAS_INVOICES`** (`409`) — [AC-532](verification.md#1511-customer-management). There is no remediation path — issued / cancelled rows are subject to §147 AO retention.
- **`DRAFT_NOT_EXPORTABLE`** (`422`) — bulk export rejected because at least one requested invoice id resolves to a draft. Drafts carry no rendered PDF, so including one would either bundle an empty document or fail mid-stream after bytes have already left the wire. `details.invoiceId` is the offending draft. Reachable only through the API: the client offers no draft for selection. Raised in ids-mode only; in filter-mode drafts are silently outside the filter. See [AC-717](verification.md#1530-invoices).
- **`EXPORT_TOO_LARGE`** (`422`) — bulk export rejected because the filter matches more invoices than the server will bundle into one archive. `details.total` is the matched-row count and `details.cap` the ceiling, so the client can phrase a precise message. The caller narrows the filter (typically by year) and retries. See [AC-718](verification.md#1530-invoices).
- **`PROJECT_HAS_INVOICES`** (`409`) — project hard-delete (`DELETE /api/projects/:id/purge`) rejected because the project carries any **issued or cancelled** `Invoice` row ([data-model.md §6.14](data-model.md#614-immutability-of-issued-invoices), [§6.6](data-model.md#66-referential-integrity)). Draft invoices on the project cascade-delete with the purge and do not trigger this code. `details.invoiceCount` carries the count of issued + cancelled rows. Distinct from `CONFLICT` (used for purging a non-archived project, AC-503) so the client can render the targeted invoice-notice copy rather than the generic archive-first hint.
- **`USER_HAS_INVOICES`** (`409`) — user hard-delete rejected because an **issued or cancelled** `Invoice` row references the user as `createdBy` or `updatedBy` ([data-model.md §6.9](data-model.md#69-soft-deletes)). References on drafts do not trigger this code. `details.invoiceCount` carries the count of those rows. The German message points to deactivation as the remedy.

#### 14.4.2 Error Principles

- **Authentication errors are distinguishable from authorization errors.** An expired session must not produce the same error as an insufficient permission — the client handles them differently (redirect vs. inline message).
- **Undefined input is refused.** A request body carrying a field the operation does not define, at any depth, is rejected as a validation error and changes nothing. Rationale: a client sending a stale or misspelled field must learn its request was not understood ([AC-516](verification.md#1517-data-integrity)).
- **Validation errors are structured.** When a mutation is rejected for business rule violations, the error must identify which rule was violated (e.g., "cannot transition from terminal state") so the client can render a meaningful message.
- **Error messages never leak internal details.** No stack traces, database field names, table names, file paths, or query information in any error response. This applies to all error categories including server errors.
- **HTTP statusCode reflects the failure class.** A request rejected at the transport layer (malformed body declared as JSON, payload exceeding configured limits, unsupported media type, request whose method and URL match no registered handler) preserves the 4xx HTTP statusCode native to that failure and surfaces a stable machine-readable code. Transport-layer rejections are never collapsed into a 5xx response, and they are not logged at the operational `error` level (used to back 5xx alerting on logs). Rationale: 5xx must mean "the server failed", not "the client made a recoverable mistake"; conflating the two — either through the wire response or through the log severity — trains operators to ignore real 5xx incidents.

---

_Cross-references: [index.md](index.md) for scope and assumptions, [data-model.md](data-model.md) for entity definitions, [ui/](ui/index.md) for client-side behavior that consumes this API, [architecture.md](architecture.md) for responsibility layers and security requirements, [verification.md](verification.md) for acceptance criteria and API integration tests._
