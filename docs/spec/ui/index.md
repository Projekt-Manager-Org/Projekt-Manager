# UI Specification

Section 8 of the [product spec](../index.md): UI surface. Split into per-subsystem pages; this file carries the overall shell (§8.1 Layout, §8.7 Navigation) and the sub-TOC.

## Structure

| File                                       | Sections          | Contents                                                                                             |
| ------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| **index.md** (this file)                   | §8.1, §8.7        | Shell: top-level layout states, navigation matrix, user menu                                         |
| **[workflow-views.md](workflow-views.md)** | §8.2–§8.4         | Kanban, Calendar, Project Detail Panel                                                               |
| **[management.md](management.md)**         | §8.8–§8.10, §8.13 | Project, Customer, and User management tabular CRUD views; global Audit View                         |
| **[daten.md](daten.md)**                   | §8.11             | Daten view — unified business-data restore + export, storage usage, company profile                  |
| **[email-intake.md](email-intake.md)**     | §8.12             | Email Data Intake — modal LLM extraction to customer + project                                       |
| **[project-detail.md](project-detail.md)** | §8.15             | Project Detail Page — dedicated `/projects/:id` route with attachments and per-project invoice block |
| **[invoices.md](invoices.md)**             | §8.16             | Invoices View — list, draft form, issued-invoice viewer, Stornorechnung action                       |
| **[behavior.md](behavior.md)**             | §9                | Cross-cutting behavioral rules                                                                       |

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
│ [Mutation error banner — only when a mutation failed]    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│                     Active View                          │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Footer: configurable text [C]              Daten: 1.2 GB│
└──────────────────────────────────────────────────────────┘
```

- **Insecure banner**: non-dismissible, visually prominent warning shown when the page loaded over plain HTTP on a non-localhost host. Covers both login and authenticated layout. See [AC-45](../verification.md#156-deployment) and [ADR-0013](../../adr/0013-http-only-evaluation-mode.md).
- **Header**: app name **[C]**, navigation ([§8.7](#87-navigation)).
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

- **User indicator**: displays the authenticated user's `displayName`. Clicking reveals a dropdown — see [§8.7.2](#872-user-menu).
- **Mutation error banner**: appears when the most recent mutation failed. German message from the API error category (see [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)), dismiss button. Cleared on next successful mutation or by dismissal.
- **Default view**: Meine Projekte for worker; Kanban for owner and office; Rechnungen for bookkeeper (see [§8.7.1](#871-views)).
- **Footer** (desktop only): brand text driven by branding config **[C]**, and the storage badge ([AC-448](../verification.md#1529-storage-usage), [AC-449](../verification.md#1529-storage-usage)).
- **Activity dock**: a collapsible panel directly above the Footer, for callers holding `audit:read` ([AC-638](../verification.md#1532-activity-dock)); absent on phones and on the Aktivität view. Header button `Aktivität (Alt+A)` ([AC-640](../verification.md#1532-activity-dock)). It lists audit entries ([AC-637](../verification.md#1532-activity-dock)) one per line — `Aktor · Projekt · Beschreibung`, the time at the right, as in the activity feed ([workflow-views.md §8.4.1](workflow-views.md#841-activity-feed)) — with no `Details anzeigen`; then `Ältere anzeigen`.

---

## 8.7 Navigation

The authenticated layout provides navigation between all available views. The navigation mechanism (sidebar, top tabs, or other) is an implementation decision.

### 8.7.1 Views

The table below mirrors the route table in `src/config/routes.ts`; CI fails on drift (AC-349). `Access` is the declared rule, `Roles` is that rule resolved against the default role matrix ([api.md §14.3](../api.md#143-authorization-rules)), and `Landing` is the post-login view for a caller holding that role alone ([§8.1.2](#812-authenticated-state)) — see the first-match note below the table for multi-role callers.

<!-- CHECKED:nav-matrix:START — mirrors ROUTES and LANDING_ORDER (src/config/routes.ts), pinned by src/config/__tests__/routes.test.ts (AC-349). Edit the route table, then this block. -->

| View                 | Path                  | Label                | Access                          | Roles                     | Landing       |
| -------------------- | --------------------- | -------------------- | ------------------------------- | ------------------------- | ------------- |
| `meineProjekte`      | `/meine-projekte`     | "Meine Projekte"     | Role: worker                    | worker                    | worker        |
| `kanban`             | `/kanban`             | "Kanban"             | Role: owner, office, worker     | owner, office, worker     | owner, office |
| `kalender`           | `/calendar`           | "Kalender"           | Role: owner, office, worker     | owner, office, worker     | —             |
| `projekte`           | `/projects`           | "Projekte"           | Role: owner, office, bookkeeper | owner, office, bookkeeper | —             |
| `kunden`             | `/customers`          | "Kunden"             | Role: owner, office, bookkeeper | owner, office, bookkeeper | —             |
| `rechnungen`         | `/rechnungen`         | "Rechnungen"         | `invoice:read`                  | owner, office, bookkeeper | bookkeeper    |
| `benutzer`           | `/users`              | "Benutzer"           | `user:manage`                   | owner                     | —             |
| `daten`              | `/daten`              | "Daten"              | `data:export`                   | owner, office             | —             |
| `aktivitaet`         | `/audit`              | "Aktivität"          | `audit:read`                    | owner, office             | —             |
| `benachrichtigungen` | `/benachrichtigungen` | "Benachrichtigungen" | `notifications:manage`          | owner                     | —             |

**Landing is first-match over this order:** worker → `meineProjekte`; owner / office → `kanban`; bookkeeper → `rechnungen`. A caller holding several roles takes the first rule that matches, so the ordering — not a per-role exclusion — is what keeps the choice unambiguous. A caller matching no rule has no landing view and falls back to their first accessible route.

<!-- CHECKED:nav-matrix:END -->

Parametrized routes (`/projects/:id`, `/rechnungen/:id`) are deep-link targets rather than nav entries and are omitted above; their gating is specified with the surface itself ([project-detail.md §8.15](project-detail.md#815-project-detail-page), [invoices.md §8.16.3](invoices.md#8163-issued-invoice-viewer)).

**Per-view notes.** What the table cannot carry:

- **"Meine Projekte"** — the logged-in worker's assigned projects, grouped Heute / Demnächst / Weitere, each row a single tap target deep-linking to `/projects/:id`. Designed for phone-first field use.
- **"Kanban"**, **"Kalender"** — worker access is scoped; see **Worker-scoped views** below.
- **"Rechnungen"** — the invoice register; see [invoices.md §8.16](invoices.md#816-invoices-view).
- **"Daten"** — includes the deployment-wide storage usage row ([daten.md §8.11.3](daten.md#8113-speichernutzung)) and, for the owner, the company-profile form ([daten.md §8.11.4](daten.md#8114-company-profile)).
- **"Aktivität"** — office does not see destructive entries ([AC-182](../verification.md#1523-audit-log)); the permission gate above governs tab visibility only.
- **"Benutzer"**, **"Benachrichtigungen"** — hidden for every other role, and a deep link to `/users` or `/benachrichtigungen` returns the not-permitted surface rather than redirecting.

**Primary / secondary grouping.** "Rechnungen", "Benutzer", "Daten", "Aktivität", and "Benachrichtigungen" are secondary: lower-frequency admin / observability surfaces, plus the invoice register — owner / office draft and issue invoices on the project page ([project-detail.md §8.15.11](project-detail.md#81511-invoice)). Navigation groups them under "Verwaltung" when a caller sees two or more; a single secondary entry renders inline with the primary entries. Bookkeeper's only secondary entry, "Rechnungen", therefore renders inline.

**Phone width.** The nav matrix and the grouping above apply at every viewport width. At phone width, from any view, every entry outside "Verwaltung" is one tap away and every entry inside it is reachable through the group. Navigation layout is an implementation decision ([§8.7](#87-navigation)).

**Worker-scoped views.** For workers, the data presented in Kanban and Calendar is filtered to the projects the worker is assigned to — the same scoping rule that applies to the server-side list operation ([AC-579](../verification.md#1521-role-scoping)). The views render normally; only the row set is reduced. A project whose detail the worker is not authorized for is not reachable from a scoped Kanban or Calendar.

**Landing view.** The default landing view is Kanban for owner and office. Worker lands on "Meine Projekte", a phone-first personal list of the worker's assigned projects (Kanban stays in the nav — workers spend most of their app time on phones, where the kanban board's horizontal scroll and per-state columns are a poor fit). Bookkeeper lands on Rechnungen — the invoice register (search/filter/export) is their primary workflow; bookkeeper also lacks Kanban access under the nav matrix. A bookkeeper arriving at `/kanban` via a manual URL entry is treated under the unpermitted-route rule below rather than silently redirected.

Navigation between views preserves shared state (cached project list, customer list, authenticated user). Switching views clears any active filter.

Views that the user lacks permission to access are hidden from navigation. Server-side authorization remains authoritative — hiding is a UX convenience. A manual URL entry to a view the caller is not permitted to access presents an explicit not-permitted error surface in the client (see [AC-149](../verification.md#1521-role-scoping)) rather than a silent redirect — the client must not obscure an authorization failure behind a destination swap.

### 8.7.2 User Menu

The user menu (accessible from the header area) provides:

- Display of the authenticated user's `displayName`
- "Darstellung" — a 3-way theme selector with options "Hell" (light), "Dunkel" (dark), "Systemstandard" (system). Selecting an option applies immediately and persists server-side (see [behavior.md §9.6](behavior.md#96-theme-handling)).
- "Push-Benachrichtigungen" — for this device ([verification.md §15.24](../verification.md#1524-notifications)): `Push-Benachrichtigungen aktivieren` while the device is not registered and the browser does not block push; `Gerät abmelden` while it is registered; the `Stummschalten` toggle. A hint takes the place of `Push-Benachrichtigungen aktivieren` when the browser blocks push, and of the whole group when it lacks push; after activation, a hint names a failure, e.g. no push keys configured on the server.
- "Passwort ändern" — opens a password change form (current password, new password, confirmation)
- "Abmelden" — logs out and returns to the login screen

---

_Cross-references: [index.md](../index.md) for workflow states and assumptions, [data-model.md](../data-model.md) for entity definitions, [api.md](../api.md) for API operations, [verification.md](../verification.md) for acceptance criteria._
