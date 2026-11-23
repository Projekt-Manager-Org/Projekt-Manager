# API Specification

---

## 14. API Specification

This file holds the role ↔ permission matrix and the error categories ACs refuse with. The HTTP API between front end and server is internal: [ARCHITECTURE.md § API Surface](../../ARCHITECTURE.md#api-surface).

---

### 14.3 Authorization Rules

Every operation on protected data needs an active session ([AC-574](verification.md#154-authentication)). It also needs what the map below lists; a caller without it is refused ([AC-576](verification.md#1521-role-scoping)). Scope: [§15.21](verification.md#1521-role-scoping). Roles: [index.md §4.2](index.md#42-roles).

<!-- CHECKED:permissions-table:START — mirrors ROLE_PERMISSIONS (src/config/permissions.ts) over the production roles, pinned by src/config/__tests__/permissions.test.ts. Edit the config, then this block. -->

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

Every refusal falls into one category and carries a German message for the user ([AC-755](verification.md#1515-navigation-and-interaction)).

#### 14.4.1 Error Categories

| Category                 | Meaning                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Authentication error** | The credentials are invalid, or the request carries no valid session                                              |
| **Authorization error**  | The caller is signed in but lacks what [§14.3](#143-authorization-rules) requires                                 |
| **Validation error**     | The request is malformed, or breaks a field constraint or a business rule                                         |
| **Not found**            | The entity does not exist, or is not available to the operation (e.g. archived, hidden)                           |
| **Route not found**      | No operation matches the request's method and URL                                                                 |
| **Gone**                 | The entity existed, but its content is permanently lost; a retry cannot help                                      |
| **Conflict**             | The entity changed since it was loaded, or its own or related state forbids the operation                         |
| **Idempotency conflict** | A create carries the ID of an existing record but differs from it ([AC-127](verification.md#1517-data-integrity)) |
| **Server error**         | An unexpected internal failure                                                                                    |
| **Rate limited**         | Too many requests in the rate-limit window                                                                        |

Where a refusal fits more than one category, its AC names the one used.

---

_Cross-references: [index.md](index.md) for scope and assumptions, [data-model.md](data-model.md) for entity definitions, [architecture.md](architecture.md) for external constraints and configuration, [verification.md](verification.md) for acceptance criteria._
