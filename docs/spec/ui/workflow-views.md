# UI: Workflow Views

Section 8.2–8.4 of the [product spec](../index.md) — the Kanban board, the Calendar, and the Project Detail Panel shared between them. Their behavior: [verification.md §15.1](../verification.md#151-workflow-board). Shell and navigation live in [index.md](index.md); cross-cutting behavioral rules in [behavior.md](behavior.md).

---

## 8.2 Kanban View

### 8.2.1 Columns

One column per workflow state ([index.md §3](../index.md#3-workflow-states)). Each column header shows:

- the German state label and the card count;
- in a buffer column, the aged signal ([AC-463](../verification.md#151-workflow-board)).

Action columns are tinted ([AC-11](../verification.md#151-workflow-board)). A collapsed column ([AC-470](../verification.md#151-workflow-board)) shows its label, card count and aged marker, and hides its cards.

While the no-dates filter is active ([AC-465](../verification.md#151-workflow-board)), a banner above the board shows the number of projects shown and a `"Filter aufheben"` button.

### 8.2.2 Project Card

```
┌─────────────────────────────┐
│ [●] 2026-042                │
│ Fassadenanstrich Müller     │
│ Familie Müller              │
│ 14.04. – 18.04.2026         │
│ 10.04.2026                  │
│ seit 14 Tagen     [←]  [→]  │
└─────────────────────────────┘
```

- **[●]** dot in the state color ([AC-12](../verification.md#151-workflow-board)).
- **Project number** and **title**.
- **Customer name**; `—` when none.
- **Planned dates** ([AC-468](../verification.md#151-workflow-board)); `"Kein Termin"` when none.
- **Entry date** — when the project entered its state ([AC-461](../verification.md#151-workflow-board)).
- **`"seit X Tagen"`** on aged buffer cards ([AC-462](../verification.md#151-workflow-board)).
- **[←] [→]** backward and forward transition buttons ([AC-457](../verification.md#151-workflow-board), [AC-460](../verification.md#151-workflow-board)), for users holding `project:transition` ([api.md §14.3](../api.md#143-authorization-rules)).

---

## 8.3 Calendar View

- Month view, opening on the current month, and a week view (`Monat` / `Woche`), each with previous / next navigation.
- Project bars and one-day blocks ([AC-455](../verification.md#151-workflow-board), [AC-456](../verification.md#151-workflow-board)) in the state color ([AC-12](../verification.md#151-workflow-board)).
- Below the calendar, the counter `"X Projekte ohne Termin"` ([AC-464](../verification.md#151-workflow-board), [AC-465](../verification.md#151-workflow-board)).

---

## 8.4 Project Detail Panel

On wide viewports ([AC-473](../verification.md#151-workflow-board)), a panel over the board or calendar; the view stays visible behind it.

Contents:

- Project number, title
- **`Öffnen`** — opens the Project Detail Page ([AC-207](../verification.md#1525-project-detail-page), [AC-472](../verification.md#151-workflow-board))
- Status badge in the state color, with the German label
- Customer: name, phone (clickable), email (clickable)
- `Baustelle:` line, rendered as on the Project Detail Page ([project-detail.md §8.15.2](project-detail.md#8152-core-fields)), with a single map link
- **Planned start / end** date pickers ([AC-7](../verification.md#151-workflow-board), [AC-471](../verification.md#151-workflow-board); valid combinations: [data-model.md §6.8](../data-model.md#68-date-validation))
- Assigned workers (display names). Editing is on the Project Detail Page ([project-detail.md §8.15.3](project-detail.md#8153-assigned-worker-editor)) and in the Project Management View ([management.md §8.8.3](management.md#883-edit-project)).
- Estimated value, formatted as `8.500,00 €`
- Notes, read-only here; editable in the Project Management View ([management.md §8.8.3](management.md#883-edit-project))
- Timestamps: created, last updated, status changed

### 8.4.1 Activity Feed

The detail panel surfaces the project's activity history — a reverse-chronological list of `audit_log` entries whose ancestor is this project (`ancestorType = 'project'` for this `ancestorId`). Every row scoped to the project is returned, regardless of its own `entityType`: the project itself self-ancestors, and nested entities (`project_worker`, `attachment`, `invoice`, and any future nested type) set the ancestor triple to `('project', projectId, projectLabel)` at write time ([architecture.md §11.12](../architecture.md#1112-audit-ancestor-link)). The `projectLabel` slot of the ancestor triple is unused on this per-project surface (the panel header already names the project) but is load-bearing for the cross-project surfaces — the dock and the global Aktivität view. See [data-model.md §5.10](../data-model.md#510-audit-log-entity) and [api.md §14.2.8](../api.md#1428-audit-log).

**Content per row (newest first):**

- A German one-line description derived from `action` and `payload` — e.g. `"Status geändert: Geplant → In Arbeit"`, `"Termine aktualisiert"`, `"Mitarbeiter zugewiesen: Jan Nowak"`. Mapping from `(action, payload)` to string is configured **[C]**.
- Actor display: `displayName` for `user`-actor entries, resolved server-side. When the actor has been hard-deleted (AC-98 sets `actor_id` to null) the UI renders a neutral German label `"Benutzer"`. `system`-actor entries display the German label `"System"` and the `actorReason` as supporting text.
- Timestamp — `createdAt` in German locale (`DD.MM.YYYY HH:mm`).
- Payload drawer — a disclosure toggle (`Details anzeigen`) revealing the field-level `{ before, after }` diff. Rendered only when the API response for the entry includes a non-null `payload` ([api.md §14.2.8](../api.md#1428-audit-log)); client-side hiding is defense-in-depth, not the authoritative gate.

**Pagination:** default page size matches the list endpoints. A `"Ältere anzeigen"` action fetches the next page and appends; a page-boundary does not collapse already-visible rows.

**Empty-state:** `"Keine Aktivität"` when the scoped result set is empty.

**Permission:** the activity feed is rendered whenever the caller can open the project detail panel and holds `audit:read` — owner and office under the default matrix. The drawer is rendered on any entry carrying a payload.

**Destructive-action rows:** entries whose `action` is `purge`, `delete` on `entityType = 'user'`, or `update` on `entityType = 'user'` touching `roles` are admitted only to callers for whom the `auditDestructiveScopeForCaller` predicate ([api.md §14.2.8](../api.md#1428-audit-log)) returns null (owner under the default matrix). Every other role with `audit:read` has the predicate contribute a repository-layer `WHERE` fragment that excludes these rows — they are never returned by the API. Client-side hiding is defense-in-depth, not the authoritative gate.
