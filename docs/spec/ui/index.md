# UI Specification

Section 8 of the [product spec](../index.md): UI surface. Split into per-subsystem pages; this file carries the overall shell (§8.1 Layout, §8.7 Navigation) and the sub-TOC.

## Structure

| File                                       | Sections          | Contents                                                                                             |
| ------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| **index.md** (this file)                   | §8.1, §8.7        | Shell: top-level layout states, navigation matrix, user menu                                         |
| **[workflow-views.md](workflow-views.md)** | §8.2–§8.4         | Kanban, Calendar, Project Detail Panel                                                               |
| **[management.md](management.md)**         | §8.8–§8.10, §8.13 | Project, Customer, and User management tabular CRUD views; global Audit View                         |
| **[daten.md](daten.md)**                   | §8.11             | Daten view — unified business-data restore + export, storage usage                                   |
| **[email-intake.md](email-intake.md)**     | §8.12             | Email Data Intake — modal LLM extraction to customer + project                                       |
| **[project-detail.md](project-detail.md)** | §8.15             | Project Detail Page — dedicated `/projects/:id` route with attachments and per-project invoice block |
| **[invoices.md](invoices.md)**             | §8.16             | Invoices View — list, export, draft form, invoice viewer, company profile                            |

---

## 8.1 Layout

The application has two top-level layout states depending on authentication.

### 8.1.1 Unauthenticated State

The login screen shows the app name, `Benutzername` and `Passwort` inputs, an `Anmelden` button and an error area. Behavior: [verification.md §15.4](../verification.md#154-authentication).

### 8.1.2 Authenticated State

```
┌──────────────────────────────────────────────────────────┐
│ [Insecure banner — only in insecure-mode evaluation]     │
├──────────────────────────────────────────────────────────┤
│  Header: App Name  |  Navigation (§8.7)                  │
│                                    [Maria Schmidt ▾]     │
├──────────────────────────────────────────────────────────┤
│ [Mutation error banner — only after a failed change]    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│                     Active View                          │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Footer: configurable text [C]              Daten: 1.2 GB│
└──────────────────────────────────────────────────────────┘
```

- **Insecure banner**: warning on plain HTTP ([AC-766](../verification.md#156-deployment)).
- **Header**: brand mark, app name **[C]**, navigation ([§8.7](#87-navigation)).
- **Brand mark** (decorative): the configured logo **[C]**, or the generic mark ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)).
- **Backup badge** (owners only, [AC-612](../verification.md#1522-backup-and-recovery), [AC-613](../verification.md#1522-backup-and-recovery)): one icon in the header whose colour shows the state; hovering or tapping it shows the label, followed by the last backup run's time (`lastBackupAt`, `HH:mm EEE dd.MM.yyyy`) when there is one. The first row whose condition holds wins; fields are the backup status ([data-model.md §5.9](../data-model.md#59-backup-status)), thresholds are **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)):

  | Condition                                                                     | Colour | Label                                        |
  | ----------------------------------------------------------------------------- | ------ | -------------------------------------------- |
  | The database holding the backup status is unreachable                         | grey   | `Status unbekannt`                           |
  | No backup run yet                                                             | red    | `Backup: noch nie ausgeführt`                |
  | The last backup run failed                                                    | red    | `Backup: fehlgeschlagen`                     |
  | The last drill failed ([AC-621](../verification.md#1522-backup-and-recovery)) | red    | `Drill: fehlgeschlagen`                      |
  | No drill yet                                                                  | red    | `Drill: noch nie ausgeführt`                 |
  | The last backup run is more full days old than the backup red threshold       | red    | `Backup: veraltet`                           |
  | The last drill is more full days old than the drill red threshold             | red    | `Drill: überfällig`                          |
  | The last status-mirror write failed                                           | amber  | `Backup: Statuskopie fehlgeschlagen`         |
  | The last backup run is more full days old than the backup amber threshold     | amber  | `Backup: wird alt`                           |
  | The last drill is more full days old than the drill amber threshold           | amber  | `Backup: aktuell, Drill-Schlüssel neu laden` |
  | Otherwise                                                                     | green  | `Backup: aktuell`                            |

- **User menu**: the signed-in user's `displayName` (initials at most 768 px wide), opening the user menu ([§8.7.2](#872-user-menu)).
- **Mutation error banner**: the message of a failed change made outside a dialog — to a project, the theme or push muting ([AC-755](../verification.md#1515-navigation-and-interaction)), with a dismiss button. Dialogs and other views show their own failures in place.
- **Footer** (desktop only): footer brand line **[C]**, and the storage badge ([AC-448](../verification.md#1529-storage-usage), [AC-449](../verification.md#1529-storage-usage)).
- **Activity dock**: a collapsible panel directly above the Footer, for callers holding `audit:read` ([AC-638](../verification.md#1532-activity-dock)); absent on phones and on the Aktivität view. Header button `Aktivität (Alt+A)` ([AC-640](../verification.md#1532-activity-dock)). It lists audit entries ([AC-637](../verification.md#1532-activity-dock)) one per line — `Aktor · Projekt · Beschreibung`, the time at the right, as in the activity feed ([workflow-views.md §8.4.1](workflow-views.md#841-activity-feed)) — with no `Details anzeigen`; then `Ältere anzeigen`.

---

## 8.7 Navigation

The authenticated layout navigates between the views below. Behavior: [verification.md §15.15](../verification.md#1515-navigation-and-interaction).

### 8.7.1 Views

`Access` is the declared rule, `Roles` is that rule resolved against the default role matrix ([api.md §14.3](../api.md#143-authorization-rules)), and `Landing` is the post-login view for a caller holding that role alone — see the first-match note below the table for multi-role callers.

<!-- CHECKED:nav-matrix:START — mirrors ROUTES and LANDING_ORDER (src/config/routes.ts), pinned by src/config/__tests__/routes.test.ts. Edit the route table, then this block. -->

| Path                  | Label                | Access                          | Roles                     | Landing       |
| --------------------- | -------------------- | ------------------------------- | ------------------------- | ------------- |
| `/meine-projekte`     | "Meine Projekte"     | Role: worker                    | worker                    | worker        |
| `/kanban`             | "Kanban"             | Role: owner, office, worker     | owner, office, worker     | owner, office |
| `/calendar`           | "Kalender"           | Role: owner, office, worker     | owner, office, worker     | —             |
| `/projects`           | "Projekte"           | Role: owner, office, bookkeeper | owner, office, bookkeeper | —             |
| `/customers`          | "Kunden"             | Role: owner, office, bookkeeper | owner, office, bookkeeper | —             |
| `/rechnungen`         | "Rechnungen"         | `invoice:read`                  | owner, office, bookkeeper | bookkeeper    |
| `/users`              | "Benutzer"           | `user:manage`                   | owner                     | —             |
| `/daten`              | "Daten"              | `data:export`                   | owner, office             | —             |
| `/audit`              | "Aktivität"          | `audit:read`                    | owner, office             | —             |
| `/benachrichtigungen` | "Benachrichtigungen" | `notifications:manage`          | owner                     | —             |

**Landing is first-match over this order:** worker → `/meine-projekte`; owner / office → `/kanban`; bookkeeper → `/rechnungen`. A caller holding several roles takes the first rule that matches.

<!-- CHECKED:nav-matrix:END -->

Parametrized routes (`/projects/:id`, `/rechnungen/:id`) are deep-link targets rather than nav entries and are omitted above; their gating is specified with the surface itself ([project-detail.md §8.15](project-detail.md#815-project-detail-page), [invoices.md §8.16.3](invoices.md#8163-invoice-viewer)).

**Per-view notes.** What the table cannot carry:

- **"Meine Projekte"** — the worker's assigned projects, grouped ([AC-753](../verification.md#1515-navigation-and-interaction)); each group heading shows its count, an empty group is hidden, and with no assigned project the view reads `"Keine zugewiesenen Projekte."`. Each row shows number, title, state, planned dates and customer, and opens `/projects/:id`.
- **"Kanban"**, **"Kalender"** — a worker sees only their assigned projects ([AC-579](../verification.md#1521-role-scoping)).
- **"Rechnungen"** — the invoice register and the company profile; see [invoices.md §8.16](invoices.md#816-invoices-view).
- **"Daten"** — includes the deployment-wide storage usage row ([daten.md §8.11.3](daten.md#8113-speichernutzung)).

**Grouping.** "Rechnungen", "Benutzer", "Daten", "Aktivität" and "Benachrichtigungen" are secondary. A caller who sees two or more of them finds them under "Verwaltung"; a single one shows inline with the primary entries (bookkeeper: "Rechnungen"). The grouping holds at every viewport width.

A view the caller may not access is absent from navigation ([AC-75](../verification.md#1515-navigation-and-interaction)); opened by URL, it shows the not-permitted surface ([AC-149](../verification.md#1521-role-scoping)).

### 8.7.2 User Menu

The user menu, opened from the header, offers:

- "Darstellung" — the theme selector: "Hell" (`light`), "Dunkel" (`dark`), "Systemstandard" (`system`) ([verification.md §15.19](../verification.md#1519-theming)).
- "Push-Benachrichtigungen" — for this device ([verification.md §15.24](../verification.md#1524-notifications)): `Push-Benachrichtigungen aktivieren` while the device is not registered for the user and the browser does not block push; `Gerät abmelden` while it is; the `Stummschalten` toggle. A hint takes the place of `Push-Benachrichtigungen aktivieren` when the browser blocks push, and of the whole group when it lacks push; after activation, a hint names a failure, e.g. no push keys configured on the server.
- "Passwort ändern" — opens a password change form (current password, new password, confirmation)
- "Abmelden" — logs out and returns to the login screen

---

_Cross-references: [index.md](../index.md) for workflow states and assumptions, [data-model.md](../data-model.md) for entity definitions, [api.md](../api.md) for permissions and error categories, [verification.md](../verification.md) for acceptance criteria._
