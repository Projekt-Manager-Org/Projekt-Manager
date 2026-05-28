# UI: Workflow Views

Section 8.2–8.6 of the [product spec](../index.md) — the Kanban + Calendar workflow-dashboard experience, the Project Detail Panel shared between them, the header Summary Area, and the color-coding conventions. Shell and navigation live in [index.md](index.md); cross-cutting behavioral rules in [behavior.md](behavior.md).

---

## 8.2 Kanban View

### 8.2.1 Columns

The board has **9 columns**, one per workflow state (see [index.md — Workflow States](../index.md#3-workflow-states)). Each column header shows the German label and the card count.

Action columns are visually distinct from buffer columns (e.g., warm-tinted background for action, neutral for buffer).

### 8.2.2 Project Card

```
┌─────────────────────────────┐
│ [●] 2026-042                │
│ Fassadenanstrich Müller     │
│ Familie Müller              │
│ 14.04. – 18.04.2026         │
│                        [→]  │
└─────────────────────────────┘
```

- **[●]** Color dot matching the state color (see 8.6).
- **Project number** and **title**.
- **Customer name**.
- **Date range** if available; `"Kein Termin"` otherwise.
- **[→] button** advances to the next workflow state with a German confirmation dialog showing current and target state. Hidden for `Erledigt` cards.

Cards within a column are sorted by `statusChangedAt` ascending (longest-waiting on top).

### 8.2.3 Entry Date and Aging

Every card shows its `statusChangedAt` as a date label. The `"seit X Tagen"` aging text is a separate indicator that appears below for aged buffer cards — both the date and the aging text are shown.

**Action states**: after a configurable threshold (`agingBoldDays`), the entry date turns **bold** — a subtle but clear flag that this item has been waiting too long. Default thresholds **[C]**:

- Anfrage: 3 days
- Beauftragt: 5 days
- Rechnung fällig: 3 days

**Buffer states**: after a configurable threshold, the entry date turns bold AND the card additionally shows `"seit X Tagen"` as a text indicator. The state config carries **two** fields for buffer states — `agingBoldDays` controls when the entry date switches to bold, and `agingThresholdDays` controls when the `"seit X Tagen"` text appears. The fields are kept separate so the two effects can be staggered (e.g., bold at 14 days, "seit X Tagen" at 18) via configuration; in the default config both values match so the effects transition together. See [data-model.md §5.2](../data-model.md#52-state-metadata) for the field mapping. Default thresholds **[C]**:

- Angebot: 14 days
- Geplant: 21 days
- Abnahme: 7 days
- Abgerechnet: 30 days

### 8.2.4 Interactivity

- **Click on a card** → opens the Project Detail Panel (8.4).
- **[→] button** → state transition with confirmation dialog.
- **Drag between adjacent columns** → optional. If implemented, only adjacent-column drops are accepted (no skipping states).

---

## 8.3 Calendar View

### 8.3.1 Display

- **Default**: month view of the current month. Navigation to previous/next months.
- **Week view toggle**: available via Monat/Woche buttons in the calendar navigation bar. Month view is the default; week view shows a single week with date-range label.
- Projects with `plannedStart` and `plannedEnd` render as **horizontal bars** spanning those dates.
- Projects with only `plannedStart` (no `plannedEnd`) render as a **single-day block** on the start date.
- Bar color encodes the workflow state (see 8.6).
- Projects without planned dates do **not** appear. A counter below the calendar reads: `"X Projekte ohne Termin"` — clicking it switches to Kanban view AND applies a "no dates" filter so only the undated projects are visible. A `"Filter aufheben"` button clears the filter, and switching views also clears it.

### 8.3.2 Interactivity

- **Click on a project bar** → opens the Project Detail Panel (8.4).
- **Date editing** is done via the Project Detail Panel (8.4).

---

## 8.4 Project Detail Panel

A detail view that preserves the context of the underlying view (the user should not lose sight of the board or calendar).

Contents:

- Project number, title
- **`Öffnen` affordance** in the panel header area — navigates to the canonical Project Detail Page at `/projects/:id` ([ui/project-detail.md §8.15](project-detail.md#815-project-detail-page)). The navigation preserves the originating view (Kanban or Calendar) as the back target so the user can return without re-navigating. Rendered whenever the panel is.
- Current status with colored badge + German label
- **Forward transition button** (same as [→]). Hidden for `Erledigt`.
- **Backward transition button**, styled less prominently. Hidden for `Anfrage` (no previous state) and `Erledigt` (terminal).
- Customer: name, phone (clickable), email (clickable)
- `Baustelle:` line — rendered from `project.siteAddress` when non-null; falls back to the customer's `address` with a subtle inline `"(Kundenadresse)"` hint when null. Single map link on whichever address is shown. Full rule and edge cases in [project-detail.md §8.15.2](project-detail.md#8152-core-fields) (the SSOT — the panel and the page render this line identically).
- **Dates: planned start/end** — editable via date picker inputs. Changes update `plannedStart`/`plannedEnd` and are reflected in both views immediately. The UI prevents invalid combinations: clearing `plannedStart` while `plannedEnd` is set also clears `plannedEnd` (see [data-model.md §6.8](../data-model.md#68-date-validation)).
- Assigned workers (list of display names). Editing is available on the Project Detail Page ([ui/project-detail.md §8.15.3](project-detail.md#8153-assigned-worker-editor)) and in the Project Management View ([management.md §8.8.3](management.md#883-edit-project)).
- Estimated value, formatted as `8.500,00 €` (German locale)
- Notes (read-only in the Kanban/Calendar context; editable in the Project Management View, [management.md §8.8.3](management.md#883-edit-project))
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

---

## 8.5 Summary Area

Displayed in the header. Shows aggregate counts computed from current project data:

- Count of projects in each action state: e.g., `"3× Rechnung fällig"`, `"2× Anfrage"`
- Count of projects in buffer states exceeding aging thresholds: e.g., `"1 Angebot seit >14 Tagen"`

Indicators remain visible across all views as reminders of open items requiring attention. Clicking an indicator from any view navigates to the Kanban view and applies the filter; clicking the same active indicator clears it without navigating. For action-state indicators, this filters to all projects in that state. For aged buffer indicators, this filters to only the projects exceeding the threshold — not all projects in that buffer state. The filter state must distinguish between "all projects in state X" (action-state filter) and "only aged projects in state X" (buffer-aging filter). Non-matching cards are hidden (not dimmed). A `"Filter aufheben"` (clear filter) button appears in the summary area while a filter is active. Switching views clears the filter.

Summary values update immediately after any state change.

---

## 8.6 Color Coding

Each state has an assigned color. Action states use warm tones, buffer states use cool tones.

| State           | Type   | Suggested Color | Hex       |
| --------------- | ------ | --------------- | --------- |
| Anfrage         | Action | Orange          | `#F97316` |
| Angebot         | Buffer | Light blue      | `#93C5FD` |
| Beauftragt      | Action | Amber           | `#F59E0B` |
| Geplant         | Buffer | Blue            | `#3B82F6` |
| In Arbeit       | Active | Green           | `#22C55E` |
| Abnahme         | Buffer | Teal            | `#14B8A6` |
| Rechnung fällig | Action | Red             | `#EF4444` |
| Abgerechnet     | Buffer | Indigo          | `#6366F1` |
| Erledigt        | Done   | Gray            | `#9CA3AF` |

Colors are configurable via the state configuration (see [Data Model — State Metadata](../data-model.md#52-state-metadata)). The warm/cool grouping is the design principle; exact values may be adjusted during implementation.
