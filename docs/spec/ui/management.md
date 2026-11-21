# UI: Management Views

Sections 8.8–8.10 and 8.13 of the [product spec](../index.md) — the tabular CRUD surfaces for Projects, Customers, and Users, plus the global Audit View. Email Data Intake (§8.12) — a modal customer+project creation flow entered from a header button — is a sibling page at [email-intake.md](email-intake.md). Shell and navigation live in [index.md](index.md); cross-cutting interaction rules (in-flight lock, error handling, dialogs) in [verification.md §15.15](../verification.md#1515-navigation-and-interaction).

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

Behavior: [AC-475](../verification.md#1512-projects), [AC-476](../verification.md#1512-projects), [AC-762](../verification.md#1517-data-integrity).

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

Fields: [data-model.md §5.6](../data-model.md#56-customer-entity). Behavior: [AC-762](../verification.md#1517-data-integrity), [AC-518](../verification.md#1511-customer-management), [AC-539](../verification.md#1511-customer-management), [AC-520](../verification.md#1511-customer-management), [AC-537](../verification.md#1511-customer-management), [AC-538](../verification.md#1511-customer-management), [AC-521](../verification.md#1511-customer-management), [AC-536](../verification.md#1511-customer-management).

### 8.9.3 Edit Customer

The same fields with the customer's values, reached from a row or the Project Detail Page. Without `customer:write` every field is read-only and no save is offered ([AC-121](../verification.md#1521-role-scoping)). Behavior: [AC-519](../verification.md#1511-customer-management), [AC-520](../verification.md#1511-customer-management), [AC-537](../verification.md#1511-customer-management), [AC-538](../verification.md#1511-customer-management), [AC-521](../verification.md#1511-customer-management), [AC-543](../verification.md#1530-invoices), [AC-688](../verification.md#1530-invoices).

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

Shows the username (read-only), display name, roles, email and status. Editable fields: [AC-554](../verification.md#1513-user-management). Each saves on its own, outside a dialog ([AC-754](../verification.md#1515-navigation-and-interaction)). Actions:

- **Passwort zurücksetzen** — dialog: new password with confirmation; no submission until both match.
- **Deaktivieren / Reaktivieren** — confirmation dialog.
- **Löschen** — confirmation dialog; not offered on the user's own account.

---

## 8.13 Audit View

The `Aktivität` view ([index.md §8.7.1](index.md#871-views)): a table of audit entries ([data-model.md §5.10](../data-model.md#510-audit-log-entity)). Behavior: [verification.md §15.23](../verification.md#1523-audit-log); its default, recipient-scoped mode and the `Alles anzeigen` toggle: [AC-660](../verification.md#1524-notifications), [AC-672](../verification.md#1524-notifications), [AC-661](../verification.md#1524-notifications), [AC-662](../verification.md#1524-notifications).

Columns, in order:

| Column    | Shows                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------- |
| Zeitpunkt | Time, as in the activity feed ([workflow-views.md §8.4.1](workflow-views.md#841-activity-feed)) |
| Akteur    | Actor, as in the activity feed                                                                  |
| Projekt   | The entry's project, or `—` ([AC-641](../verification.md#1523-audit-log))                       |
| Objekt    | Entity type and recorded label — the entity's id when it has no label                           |
| Aktion    | German label of the action                                                                      |
| Details   | `Details anzeigen` ([AC-186](../verification.md#1523-audit-log)), or `—`                        |

Filters, each optional ([AC-629](../verification.md#1523-audit-log)): entity type (one), entity name (at least 3 characters; entries whose recorded label contains it, ignoring case), actor (one user), date from / to (both days included), action (one). `Filter aufheben` clears them all.

Below the table: `Ältere anzeigen` ([AC-628](../verification.md#1523-audit-log)).

---

## 8.14 Notification Rules View

The `Benachrichtigungen` view ([index.md §8.7.1](index.md#871-views)): the notification rules ([data-model.md §5.11](../data-model.md#511-notification-rule)). Behavior: [verification.md §15.24](../verification.md#1524-notifications).

Columns, in order, one row per rule; `Keine Regeln` when there is none:

| Column    | Shows                                                                               |
| --------- | ----------------------------------------------------------------------------------- |
| Ereignis  | Label of the event class                                                            |
| Filter    | Label of the `Ziel-Status`, or `—`                                                  |
| Empfänger | The recipients, e.g. `Rollen: Inhaber, Büro · Zugewiesene Mitarbeiter · 2 Benutzer` |
| Aktiv     | `Aktiv` or `Deaktiviert`                                                            |
| Aktionen  | `Bearbeiten`; `Löschen`, which asks `Regel wirklich löschen?` first                 |

`Regel erstellen` opens the rule form; `Bearbeiten` opens it on the rule. Fields: `Ereignis` (one class), `Ziel-Status` (one status, or `Beliebig`), `Rollen` (any number), `Zugewiesene Mitarbeiter benachrichtigen` (toggle), `Einzelne Benutzer` (search over active users; each pick a removable chip), `Aktiv` (toggle). Which fields a class admits: [AC-199](../verification.md#1524-notifications).
