# UI: Workflow Views

Sections 8.2–8.4 of the [product spec](../index.md) — the Kanban board, the Calendar, and the Project Detail Panel shared between them. Their behavior: [verification.md §15.1](../verification.md#151-workflow-board). Shell and navigation live in [index.md](index.md); cross-cutting interaction rules in [verification.md §15.15](../verification.md#1515-navigation-and-interaction).

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
- **`Öffnen`** — opens the Project Detail Page ([AC-207](../verification.md#1512-projects), [AC-472](../verification.md#151-workflow-board))
- Status badge in the state color, with the German label
- Customer: name, phone (clickable), email (clickable)
- `Baustelle:` line, rendered as on the Project Detail Page ([project-detail.md §8.15.2](project-detail.md#8152-core-fields)), with a single map link
- **Planned start / end** date pickers ([AC-7](../verification.md#151-workflow-board), [AC-471](../verification.md#151-workflow-board); valid combinations: [AC-482](../verification.md#1512-projects))
- Assigned workers (display names). Editing is on the Project Detail Page ([project-detail.md §8.15.3](project-detail.md#8153-assigned-worker-editor)).
- Estimated value, formatted as `8.500,00 €`
- Notes, read-only here; editable on the Project Detail Page ([project-detail.md §8.15.2](project-detail.md#8152-core-fields))
- Timestamps: created, last updated, status changed

### 8.4.1 Activity Feed

The detail panel lists the project's audit entries ([AC-631](../verification.md#1523-audit-log)) to callers holding `audit:read`. Each row shows:

- a German description of the change **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)), e.g. `Status geändert: Geplant → In Arbeit`;
- the actor: the user's current display name, `Benutzer` once that user is deleted, or `System` with its reason;
- the entity type;
- the time: date as in [AC-468](../verification.md#151-workflow-board), then `HH:mm`;
- `Details anzeigen` — the change's details ([AC-186](../verification.md#1523-audit-log)).

Below the rows, while older entries exist: `Ältere anzeigen` ([AC-628](../verification.md#1523-audit-log)). Empty: `Keine Aktivität`.
