# Product Specification

This spec defines **what** the application does — not how it does it, how it was in the past, or how the project evolves.

- **How** (implementation): [ARCHITECTURE.md](../../ARCHITECTURE.md) at the repo root — the navigation guide to the codebase. Major decisions with context and rationale live in [ADRs](../adr/index.md).
- **Why** (vision, final scope, out-of-scope): [Kickoff](../project/kickoff.md).
- **Conventions** (rules the spec must satisfy): [review/conventions-spec.md](../../review/conventions-spec.md).
- **`[C]`** marks values deliberately made configurable so the application can be adjusted to a real company's needs. Catalogue, and which are env vars vs. source constants: [architecture.md §12.2](architecture.md#122-company-configurable-settings).

---

## 1. Goal

A hosted, authenticated system for centralized management of projects, customers, and users across the main company workflow. The system persists structured data in a database, authenticates users via a configurable role-based permission matrix (see [§4.2](#42-users)), and serves the front end through a backend API. Binary/object storage is included as a system component (see [architecture.md §11.4](architecture.md#114-object-storage-module)).

The system provides:

- **Workflow views** — Kanban board and Calendar — making inaction visible through board structure, aging indicators, and summary counts.
- **Management views** — tabular interfaces for projects, customers, and users with full CRUD capabilities.
- **Data exchange** — unified export of business data and restore-only import from an exported envelope (see [ADR-0018](../adr/0018-data-persistence-and-recovery-layered-strategy.md) and [api.md §14.2.4](api.md#1424-unified-data-exchange)).

All views are role-gated. The system enforces that every pending action (unanswered inquiry, unscheduled job, unsent invoice) is impossible to overlook.

---

## 2. Scope

### Workflow

- Kanban board with one column per workflow state
- Calendar view (month/week) showing scheduled projects
- Project detail panel accessible from both views
- State transitions (forward/backward by one step)
- Date changes (planned start/end)
- Summary area with aggregate indicators and clickable filters

### Management

- Project management: searchable list with filter, sort, create, edit, soft-delete
- Customer management: searchable list with create, edit
- User management (admin): list, create, edit, deactivate/reactivate, password reset
- Change-own-password for all authenticated users

### Data Exchange

- Unified export of the business-data layer (customers, projects, project-worker assignments) for backup and portability, gated by `data:export`.
- Unified restore-only import from an exported envelope, gated by `data:restore`.
- Email-based data intake via LLM extraction (paste email text, review extracted customer and project fields, save).

### Notifications

- DB-stored admin-editable rules mapping a closed, code-defined event catalog to recipient specs ([ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md)).
- Two channels: browser push to the installed PWA and the in-app activity feed ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed), [ui/management.md §8.13](ui/management.md#813-audit-view)).
- Admin-only rule CRUD UI ([ui/management.md §8.14](ui/management.md#814-notification-rules-view)); rule list RBAC-scoped via the repository-layer predicate ([ADR-0019](../adr/0019-worker-data-scoping-repository-layer-predicate.md)).
- Per-user push-mute toggle; push permission is user-initiated from the settings affordance ([ui/index.md §8.7.2](ui/index.md#872-user-menu)).

### Cross-Cutting

- German UI, English code
- API layer between front end and data store
- Persistent data storage in a database
- Seed data providing a realistic starting snapshot
- User authentication (login/logout, session management) with a configurable role-based permission matrix ([§4.2](#42-users))
- Object storage module encapsulating all binary storage operations (see [architecture.md §11.4](architecture.md#114-object-storage-module))
- Deployment to a hosted environment (reverse proxy, application, database, object storage)
- CI builds images and pushes to the container registry; manual pull-based deploy over VPN per [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)

---

## 3. Workflow States

The Kanban board reflects the full company workflow. The number and definition of states are driven by configuration — the system does not hardcode a specific state count or state names.

The current configuration defines 9 states:

| #   | State               | Type   | Description                                          |
| --- | ------------------- | ------ | ---------------------------------------------------- |
| 1   | **Anfrage**         | Action | Inquiry received — company must write an offer       |
| 2   | **Angebot**         | Buffer | Offer sent — waiting for customer confirmation       |
| 3   | **Beauftragt**      | Action | Customer confirmed — company must plan and schedule  |
| 4   | **Geplant**         | Buffer | Planned — waiting for its turn on the calendar       |
| 5   | **In Arbeit**       | Active | Being executed (incl. Aufmaß, photos, etc.)          |
| 6   | **Abnahme**         | Buffer | Execution complete — waiting for customer acceptance |
| 7   | **Rechnung fällig** | Action | Customer accepted — company must write the invoice   |
| 8   | **Abgerechnet**     | Buffer | Invoice sent — waiting for payment                   |
| 9   | **Erledigt**        | Done   | Payment received — project closed                    |

Three action states, four buffer states, one active, one terminal. The Kanban board makes action states naturally visible — items accumulating in an action column signal that work is falling behind.

**[C]** The state set (names, types, order, count) is defined in a single configuration array; the `WorkflowState` type is derived from it. Adding or removing states requires updating the array and any boundary-state references in the domain layer, plus a database migration if the default status changes.

---

## 4. Reasonable Assumptions

### 4.1 Company Profile

| Attribute                  | Assumed Value                                               |
| -------------------------- | ----------------------------------------------------------- |
| Trade                      | Maler- und Lackiererbetrieb (painter / coating contractor)  |
| Employees                  | Owner, 1 office manager, 4–6 workers, 1 external bookkeeper |
| Concurrent active projects | 10–30                                                       |
| Typical project duration   | 1–10 working days                                           |
| Region                     | Single metropolitan area (~50 km radius)                    |

### 4.2 Users

The system is authenticated and implements a **four-role permission matrix**. The roles — `owner`, `office`, `worker`, `bookkeeper` — are enforced server-side on every protected route via a role-based permission check. See [api.md §14.3](api.md#143-authorization-rules) for the full role ↔ permission mapping.

- **Owner** carries full read + write permissions on projects and customers, plus administrative user management (create, update, deactivate, reactivate, reset password) and the unified data-exchange surface (`data:export`, `data:restore`).
- **Office** carries full read + write permissions on projects and customers, plus read access to user accounts and `data:export` (read-only access to the business-data backup).
- **Worker** has read-only access scoped to the projects the worker is assigned to (assignment recorded in `project_workers`). Customer reads are scoped to the customers referenced by those projects — a worker can reach a customer's detail from a project the worker is assigned to, but the customer list and direct customer lookups exclude customers the worker has no project link to. Workers also have change-own-password.
- **Bookkeeper** currently has unscoped read access to projects and customers plus change-own-password. This is an MVP placeholder: the kickoff calls for an invoice-oriented view ([kickoff.md](../project/kickoff.md)) tailored to the bookkeeping role, which is not yet implemented. Until that view lands, the bookkeeper is given the broader read surface rather than no view at all. Tightening the scope is deferred until the invoice-oriented view in [kickoff.md](../project/kickoff.md) is specified — not in scope for iteration 7.
- Self-registration is not available — users are created by an administrator, by seed data, or by the first-run bootstrap (see [§4.5](#45-authentication)).
- The Daten navigation tab ([ui/daten.md §8.11](ui/daten.md#811-daten-view)) is governed by `data:export`; the restore form within it is additionally governed by `data:restore`.

The role set and per-role permission list are configurable **[C]**.

### 4.3 Scheduling

Each project has at most one planned date range (start/end) representing the main execution slot.

### 4.4 Data Origin

All data is stored in a persistent database, accessed through an API layer. Seed data (see [data-model.md §7](data-model.md#7-seed-data-specification)) is loaded only in non-production environments — the production start-up path deliberately skips seeding to avoid overwriting real data on a first deploy. Re-seeding drops and recreates all seed records.

### 4.5 Authentication

| Attribute                            | Assumed Value                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Authentication method                | Username + password                                                                                  |
| Password policy                      | Min 8 characters, max 72 UTF-8 bytes, common-password blocklist **[C]**                              |
| Session duration                     | 24 hours **[C]**                                                                                     |
| Maximum concurrent sessions per user | Unlimited                                                                                            |
| Default admin account                | Environment-driven bootstrap on first run — see [ADR-0010](../adr/0010-first-run-admin-bootstrap.md) |
| Self-registration                    | Not available                                                                                        |
| Password-change side effect          | See [data-model.md §5.4](data-model.md#54-session)                                                   |

**Password policy detail.** The minimum length is 8 characters; the maximum is 72 UTF-8 bytes — the system enforces a hard ceiling so long inputs fail loudly rather than silently truncating. A blocklist of common passwords is checked on every password set to reject trivially guessable values. Both checks run through a single validation path so the bootstrap path and the change-password endpoint cannot diverge. See [ADR-0006](../adr/0006-password-policy-nist-blocklist.md).

For development, initial users come from seed data (see [data-model.md §7.2](data-model.md#72-user-dataset)). For production, the first admin account is created by the first-run bootstrap mechanism (see [ADR-0010](../adr/0010-first-run-admin-bootstrap.md)); subsequent users are added administratively.

---

## Spec Structure

This specification is split across multiple files:

| File                                   | Sections | Contents                                                                                                      |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| **[index.md](index.md)** (this file)   | 1–4      | Goal, scope, workflow states, assumptions                                                                     |
| **[data-model.md](data-model.md)**     | 5–7      | Project, Customer, User, Session, Audit Log entities; state metadata; persistence principles; seed data       |
| **[ui/](ui/index.md)**                 | 8–10     | UI: shell, navigation, workflow views, management, Daten, email intake, project detail, behavior + responsive |
| **[architecture.md](architecture.md)** | 11–13    | Responsibility layers, dependencies, extensibility, configuration, NFRs, security                             |
| **[api.md](api.md)**                   | 14       | API design principles, operations, authorization, error handling                                              |
| **[verification.md](verification.md)** | 15–17    | Acceptance criteria, test specifications, risks                                                               |

The test-spec traceability matrix (AC ↔ tests) lives in [docs/testing/traceability.md](../testing/traceability.md) — not in the spec itself, because it is a verification artifact maintained alongside the test suite (see [CONTRIBUTING.md §Workflow](../../CONTRIBUTING.md#workflow) step 3).

`[C]` catalogue: [architecture.md §12.2](architecture.md#122-company-configurable-settings).
