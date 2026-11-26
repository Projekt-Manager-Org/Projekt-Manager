# Product Specification

This spec defines **what** the application does — not how it does it, how it was in the past, or how the project evolves.

- **How** (implementation): [ARCHITECTURE.md](../../ARCHITECTURE.md) at the repo root — the high-level navigation guide to the codebase. Major decisions with context and rationale live in [ADRs](../adr/index.md).
- **Why** (vision, final scope, out-of-scope): [Kickoff](../project/kickoff.md).
- **`[C]`** marks values deliberately made configurable so the application can be adjusted to a real company's needs. Catalogue, and which are env vars vs. source constants: [architecture.md §12.2](architecture.md#122-company-configurable-settings).

---

## 1. Goal

The system holds one company's projects, tracked along the workflow in [§3](#3-workflow-states), with their customers and the company's users, so that no pending action goes unnoticed. Purpose: [kickoff § Purpose](../project/kickoff.md#purpose).

---

## 2. Scope

Each feature's behavior is in its AC section.

- **Workflow** — Kanban board and calendar: [§15.1](verification.md#151-workflow-board); the worker's Meine Projekte view: [§15.15](verification.md#1515-navigation-and-interaction).
- **Records** — projects [§15.12](verification.md#1512-projects), customers [§15.11](verification.md#1511-customer-management), users [§15.13](verification.md#1513-user-management).
- **Access** — sign-in and sessions [§15.4](verification.md#154-authentication), role scoping [§15.21](verification.md#1521-role-scoping).
- **Attachments** — [§15.26](verification.md#1526-attachments), storage usage [§15.29](verification.md#1529-storage-usage).
- **Invoices** — [§15.30](verification.md#1530-invoices), company profile [§15.31](verification.md#1531-company-profile).
- **Email data intake** — [§15.18](verification.md#1518-email-data-intake).
- **Notifications and activity** — [§15.24](verification.md#1524-notifications), activity dock [§15.32](verification.md#1532-activity-dock), threshold monitor [§15.33](verification.md#1533-threshold-monitor), audit log [§15.23](verification.md#1523-audit-log).
- **Data safety** — data exchange [§15.14](verification.md#1514-data-exchange), backup and recovery [§15.22](verification.md#1522-backup-and-recovery).
- **Theming and branding** — [§15.19](verification.md#1519-theming), [§15.20](verification.md#1520-branding).
- **Cross-cutting** — navigation and interaction [§15.15](verification.md#1515-navigation-and-interaction), multi-user [§15.5](verification.md#155-multi-user), data integrity [§15.17](verification.md#1517-data-integrity), realtime events [§15.28](verification.md#1528-realtime-events), configuration [§15.27](verification.md#1527-configuration-and-feature-manifest), deployment [§15.6](verification.md#156-deployment), security baseline [§15.34](verification.md#1534-security-baseline).

Out of scope: [kickoff § Not Doing](../project/kickoff.md#not-doing).

---

## 3. Workflow States

| #   | State               | Type   | Description                                          | Aging threshold, days **[C]** | Collapse tier **[C]** |
| --- | ------------------- | ------ | ---------------------------------------------------- | ----------------------------- | --------------------- |
| 1   | **Anfrage**         | Action | Inquiry received — company must write an offer       | 3                             | 1                     |
| 2   | **Angebot**         | Buffer | Offer sent — waiting for customer confirmation       | 14                            | 3                     |
| 3   | **Beauftragt**      | Action | Customer confirmed — company must plan and schedule  | 5                             | 1                     |
| 4   | **Geplant**         | Buffer | Planned — waiting for its turn on the calendar       | 21                            | 2                     |
| 5   | **In Arbeit**       | Active | Being executed (incl. Aufmaß, photos, etc.)          | —                             | 2                     |
| 6   | **Abnahme**         | Buffer | Execution complete — waiting for customer acceptance | 7                             | 2                     |
| 7   | **Rechnung fällig** | Action | Customer accepted — company must write the invoice   | 3                             | 1                     |
| 8   | **Abgerechnet**     | Buffer | Invoice sent — waiting for payment                   | 30                            | 3                     |
| 9   | **Erledigt**        | Done   | Payment received — project closed                    | —                             | 3                     |

A project moves one state forward or back at a time. No transition leaves Erledigt; Anfrage has no previous state.

Aging threshold: [AC-461](verification.md#151-workflow-board), [AC-462](verification.md#151-workflow-board). Collapse tier: [AC-470](verification.md#151-workflow-board).

---

## 4. Reasonable Assumptions

### 4.2 Roles

Every user holds one or more roles **[C]**: `owner`, `office`, `worker`, `bookkeeper`. What each may do: [api.md §14.3](api.md#143-authorization-rules).

Users are created by an owner, by a data import, or by the first-run bootstrap ([ADR-0010](../adr/0010-first-run-admin-bootstrap.md)); there is no self-registration.

---

## Spec Structure

### Equivalence Boundary

Two conforming implementations are functionally equivalent, not byte-identical. The boundary is the deployed product:

- **Contract** — what users, operators and attackers observe, and data leaving the system (export archive, invoice output, push, backups). The spec defines it.
- **Internal** — everything behind it, including the HTTP API between front end and back end. The spec leaves it to the implementation.

### Placement

Each statement has one home; everywhere else, a link.

| Statement                                                                         | Home                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Goal, scope, role set, workflow-state set                                         | [index.md](index.md) (this file)                                                           |
| Entity, field with its observable constraints (limit, enum, whitelist), invariant | [data-model.md](data-model.md)                                                             |
| Format of data leaving the system                                                 | [data-model.md](data-model.md)                                                             |
| Screen inventory — what each screen shows and offers                              | [ui/](ui/index.md)                                                                         |
| Role ↔ permission matrix, error classes                                           | [api.md](api.md)                                                                           |
| Constraint imposed from outside (kickoff, environment)                            | [architecture.md §11](architecture.md#11-external-constraints)                             |
| `[C]` value without a home above                                                  | [`[C]` catalogue](architecture.md#122-company-configurable-settings), which links the rest |
| Feature behavior or property observable by a user, operator or attacker           | AC ([verification.md §15](verification.md#15-acceptance-criteria))                         |
| Property that exists because of an ADR                                            | AC citing the ADR                                                                          |
| Choice among alternatives, and why                                                | [ADR](../adr/index.md)                                                                     |
| Cross-module flow                                                                 | [ARCHITECTURE.md](../../ARCHITECTURE.md)                                                   |
| Internal detail — HTTP API, single-module mechanism, unobservable parameter       | Code: generated OpenAPI document, module comment, config, schema                           |
| Precise executable behavior                                                       | Tests                                                                                      |
