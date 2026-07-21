# UI Specification

Section 8 of the [product spec](../index.md): UI surface. Split into per-subsystem pages; this file carries the overall shell (§8.1 Layout, §8.7 Navigation) and the sub-TOC.

## Structure

| File                                       | Sections          | Contents                                                                                             |
| ------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| **index.md** (this file)                   | §8.1, §8.7        | Shell: top-level layout states, navigation matrix, user menu                                         |
| **[workflow-views.md](workflow-views.md)** | §8.2–§8.6         | Kanban, Calendar, Project Detail Panel, Summary, Color Coding                                        |
| **[management.md](management.md)**         | §8.8–§8.10, §8.13 | Project, Customer, and User management tabular CRUD views; global Audit View                         |
| **[daten.md](daten.md)**                   | §8.11             | Daten view — unified business-data restore + export, storage usage, company profile                  |
| **[email-intake.md](email-intake.md)**     | §8.12             | Email Data Intake — modal LLM extraction to customer + project                                       |
| **[project-detail.md](project-detail.md)** | §8.15             | Project Detail Page — dedicated `/projects/:id` route with attachments and per-project invoice block |
| **[invoices.md](invoices.md)**             | §8.16             | Invoices View — list, draft form, issued-invoice viewer, Stornorechnung action                       |
| **[behavior.md](behavior.md)**             | §9, §10           | Cross-cutting behavioral rules + responsive column collapse                                          |

---

## 8.1 Layout

The application has two top-level layout states depending on authentication.

### 8.1.1 Unauthenticated State

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                     App Name / Logo                      │
│                                                          │
│                    ┌──────────────┐                      │
│                    │  Benutzername│                      │
│                    ├──────────────┤                      │
│                    │  Passwort    │                      │
│                    ├──────────────┤                      │
│                    │  [Anmelden]  │                      │
│                    └──────────────┘                      │
│                                                          │
│                    (error area)                          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

The server returns a generic error message on failed login — no distinction between "user not found" and "wrong password" to avoid information leakage. The client displays the server-provided message. The generic behavior is enforced server-side, not client-side.

The login screen is the **only** view available to unauthenticated users. No project data is accessible without authentication.

### 8.1.2 Authenticated State

```
┌──────────────────────────────────────────────────────────┐
│ [Insecure banner — only in insecure-mode evaluation]     │
├──────────────────────────────────────────────────────────┤
│  Header: App Name  |  Navigation (§8.7)  |  Summary      │
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
- **Header**: app name **[C]**, navigation ([§8.7](#87-navigation)), summary indicators.
- **User indicator**: displays the authenticated user's `displayName`. Clicking reveals a dropdown — see [§8.7.2](#872-user-menu).
- **Mutation error banner**: appears when the most recent mutation failed. German message from the API error category (see [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)), dismiss button. Cleared on next successful mutation or by dismissal.
- **Default view**: Meine Projekte for worker; Kanban for owner and office; Rechnungen for bookkeeper (see [§8.7.1](#871-views)).
- **Footer**: brand text driven by branding config **[C]**, plus a muted storage badge on the right surfacing the deployment-wide storage usage to privileged callers. Permission-gated by `data:export` (mirrors the server gate on [api.md §14.2.12](../api.md#14212-storage-usage) — owner / office under the default matrix); worker and bookkeeper see the brand text alone, no badge. The badge renders the German label `Daten:` followed by `ready.plaintext` from `GET /api/storage-usage` formatted via the shared byte-formatting helper — the user's "what I uploaded right now" view. Hover reveals a desktop-only tooltip with the two-bucket plaintext breakdown (`Sichtbar` and `Im Papierkorb`, the same labels pinned in [daten.md §8.11.3](daten.md#8113-speichernutzung)). The Footer (and therefore the badge and tooltip) is hidden on phones via the existing footer media query — there is no tooltip on touch because there is no Footer on touch; phones surface storage usage through the DatenView row instead, where the breakdown is always visible inline rather than hover-revealed. The ciphertext buckets the API also returns are operator / billing concerns and stay off the user-facing surface entirely. Refresh triggers and the SSE invalidation path are pinned in [daten.md §8.11.3](daten.md#8113-speichernutzung) (Footer and DatenView share the same storage-usage subscription).
- **Activity dock**: a collapsible panel docked at the bottom of the authenticated layout, directly above the Footer, surfacing the live activity feed so a privileged user can leave it open (e.g. on the Kanban board) and watch the business unfold in real time. Permission-gated by `audit:read` (owner and office under the default matrix, mirroring the [§8.7.1](#871-views) Aktivität tab); worker and bookkeeper never see it. The dock fetches the **full RBAC-scoped feed** ([verification.md AC-318](../verification.md#1532-activity-dock)) — every committed audit row the caller may read appears, with no recipient-rule narrowing applied (recipient scoping is a notifications concern and is exercised only on the Aktivität page via its `"Alles anzeigen"` toggle, [verification.md AC-200](../verification.md#1524-notifications)). Rows render in a **single-line glanceable format** — `Aktor · Projekt · Beschreibung` with the timestamp aligned right ([verification.md AC-339](../verification.md#1532-activity-dock)); the detail drawer is intentionally absent here, deferred to [management.md §8.13](management.md#813-audit-view) where the full table view with filters lives. An `"Ältere anzeigen"` affordance pages older entries. Live-updates via the `audit_changed` event ([api.md §14.2.13](../api.md#14213-realtime-events)) — new entries appear without a manual refresh. Default-collapsed; the collapse state persists across view navigation within the session (unlike an active filter, it does not reset on a view switch). A global keyboard shortcut **`Alt+A`** toggles the dock from any view ([verification.md AC-340](../verification.md#1532-activity-dock)); the toggle button renders the hint inline as `Aktivität (Alt+A)` so the shortcut is self-documenting. The dock is **hidden while Verwaltung → Aktivität is the active view** ([verification.md AC-341](../verification.md#1532-activity-dock)) — the page renders the full audit table, so a second feed below it would be redundant. Desktop-only — hidden on phones, parity with the Footer's media query above; mobile users reach the same history through Verwaltung → Aktivität ([management.md §8.13](management.md#813-audit-view)), the space-appropriate surface for touch. Content is fetched through the `audit:read`-gated read endpoint ([api.md §14.2.8](../api.md#1428-audit-log)); no audit content rides the SSE channel, which stays contentless ([api.md §14.2.13](../api.md#14213-realtime-events), [verification.md AC-320](../verification.md#1528-realtime-events)).

---

## 8.7 Navigation

The authenticated layout provides navigation between all available views. The navigation mechanism (sidebar, top tabs, or other) is an implementation decision.

### 8.7.1 Views

| View          | Label                | Access                                                                                                                                                                                                                                                                                                                  | Default                                          |
| ------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| My Projects   | "Meine Projekte"     | Worker only. Owner, office, bookkeeper: hidden. Shows the logged-in worker's assigned projects, grouped Heute / Demnächst / Weitere, each row a single tap target deep-linking to `/projects/:id`. Designed for phone-first field use.                                                                                  | Yes for worker (landing view after login)        |
| Kanban        | "Kanban"             | Owner, office, worker (scoped — see below). Bookkeeper: hidden.                                                                                                                                                                                                                                                         | Yes for owner, office (landing view after login) |
| Calendar      | "Kalender"           | Owner, office, worker (scoped — see below). Bookkeeper: hidden.                                                                                                                                                                                                                                                         | No                                               |
| Projects      | "Projekte"           | Owner, office, bookkeeper. Worker: hidden.                                                                                                                                                                                                                                                                              | No                                               |
| Customers     | "Kunden"             | Owner, office, bookkeeper. Worker: hidden.                                                                                                                                                                                                                                                                              | No                                               |
| Invoices      | "Rechnungen"         | `invoice:read` permission required (owner, office, bookkeeper under the default matrix — see [api.md §14.3](../api.md#143-authorization-rules)). Worker: hidden. See [invoices.md §8.16](invoices.md#816-invoices-view).                                                                                                | Yes for bookkeeper (landing view after login)    |
| Users         | "Benutzer"           | `user:manage` permission required (owner only under the default role set). Everyone else: hidden.                                                                                                                                                                                                                       | No                                               |
| Daten         | "Daten"              | `data:export` permission required (owner, office under the default role set). Everyone else: hidden. Includes the deployment-wide storage usage row ([daten.md §8.11.3](daten.md#8113-speichernutzung)) and, for the owner, the company-profile form ([daten.md §8.11.4](daten.md#8114-company-profile)).               | No                                               |
| Audit         | "Aktivität"          | `audit:read` permission required (owner, office under the default matrix). Worker and bookkeeper do not hold `audit:read` — the tab is hidden and `/audit` deep-link returns the not-permitted surface. Office visibility is narrowed by the destructive-action predicate ([api.md §14.2.8](../api.md#1428-audit-log)). | No                                               |
| Notifications | "Benachrichtigungen" | `notifications:manage` required (owner only under the default matrix — see [api.md §14.3](../api.md#143-authorization-rules)). Everyone else: hidden; `/benachrichtigungen` deep-link returns the not-permitted surface.                                                                                                | No                                               |

**Primary / secondary header grouping.** "Benutzer", "Daten", "Aktivität", and "Benachrichtigungen" are lower-frequency admin / observability surfaces. The header groups them under a secondary "Verwaltung" dropdown when a role sees two or more; a single secondary entry renders inline (dropdown chrome is reserved for real grouping). Bookkeeper sees no secondary entries.

**Worker-scoped views.** For workers, the data presented in Kanban and Calendar is filtered to the projects the worker is assigned to — the same scoping rule that applies to the server-side list operation (see [index.md §4.2](../index.md#42-users) and [api.md §14.3](../api.md#143-authorization-rules)). The views render normally; only the row set is reduced. A project whose detail the worker is not authorized for is not reachable from a scoped Kanban or Calendar.

**Landing view.** The default landing view is Kanban for owner and office. Worker lands on "Meine Projekte", a phone-first personal list of the worker's assigned projects (Kanban remains accessible as secondary nav — workers spend most of their app time on phones, where the kanban board's horizontal scroll and per-state columns are a poor fit). Bookkeeper lands on Rechnungen — the invoice register (search/filter/export) is their primary workflow; bookkeeper also lacks Kanban access under the nav matrix. A bookkeeper arriving at `/kanban` via a manual URL entry is treated under the unpermitted-route rule below rather than silently redirected.

Navigation between views preserves shared state (cached project list, customer list, authenticated user). Switching views clears any active filter.

Views that the user lacks permission to access are hidden from navigation. Server-side authorization remains authoritative — hiding is a UX convenience. A manual URL entry to a view the caller is not permitted to access presents an explicit not-permitted error surface in the client (see [AC-149](../verification.md#1521-role-scoping)) rather than a silent redirect — the client must not obscure an authorization failure behind a destination swap.

### 8.7.2 User Menu

The user menu (accessible from the header area) provides:

- Display of the authenticated user's `displayName`
- "Darstellung" — a 3-way theme selector with options "Hell" (light), "Dunkel" (dark), "Systemstandard" (system). Selecting an option applies immediately and persists server-side (see [behavior.md §9.6](behavior.md#96-theme-handling)).
- "Push-Benachrichtigungen" — grouped control for browser push delivery (see [behavior.md §9.8](behavior.md#98-push-notifications)). Exposes:
  - **Push-Benachrichtigungen aktivieren** — user-initiated opt-in affordance that requests browser permission and registers the current device. Rendered only when the device is unregistered AND the browser permission is not denied. The app MUST NOT auto-request on page load — every prompt is user-initiated from this affordance.
  - **Stummschalten** — boolean toggle mirroring `UserAccount.pushMuted` ([data-model.md §5.3](../data-model.md#53-user-entity)). `true` suppresses push across every subscription the user owns; activity feed unaffected. Optimistic; reverts on failed mutation per [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior).
  - **Gerät abmelden** — shown when the current device has an active subscription. Removes the current device's subscription; other devices remain subscribed.
- "Passwort ändern" — opens a password change form (current password, new password, confirmation)
- "Abmelden" — logs out and returns to the login screen

---

_Cross-references: [index.md](../index.md) for workflow states and assumptions, [data-model.md](../data-model.md) for entity definitions, [api.md](../api.md) for API operations, [verification.md](../verification.md) for acceptance criteria._
