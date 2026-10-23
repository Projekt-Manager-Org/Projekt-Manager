# UI: Project Detail Page

Section 8.15 of the [product spec](../index.md) — the full-page view of one project at `/projects/:id`. The detail panel ([workflow-views.md §8.4](workflow-views.md#84-project-detail-panel)) is the quick-glance overlay on the board and calendar.

Shell and navigation live in [index.md](index.md); cross-cutting behavioral rules (in-flight lock, error handling, mutation semantics) in [behavior.md](behavior.md).

---

## 8.15 Project Detail Page

Reached by URL, from a project list row ([AC-496](../verification.md#1512-projects)), from the panel's `Öffnen` ([AC-207](../verification.md#1512-projects)), and on narrow viewports from the board and calendar ([AC-474](../verification.md#151-workflow-board)). Access: [AC-509](../verification.md#1512-projects), [AC-507](../verification.md#1512-projects), [AC-508](../verification.md#1512-projects). An archived project: [AC-500](../verification.md#1512-projects). Controls a caller may not use are hidden ([AC-121](../verification.md#1521-role-scoping)); who may do what: [api.md §14.3](../api.md#143-authorization-rules).

### 8.15.1 Layout

```
┌──────────────────────────────────────────────────────────┐
│ Header — number, title, status badge; actions            │
├──────────────────────────────────────────────────────────┤
│ Core fields — customer, Baustelle, dates, value, notes   │
├──────────────────────────────────────────────────────────┤
│ Assigned workers                                         │
├──────────────────────────────────────────────────────────┤
│ Attachments — photo gallery, binary list; Papierkorb tab │
├──────────────────────────────────────────────────────────┤
│ Invoice (§8.15.11)                                       │
├──────────────────────────────────────────────────────────┤
│ Activity feed — scoped to this project (see §8.4.1)      │
└──────────────────────────────────────────────────────────┘
```

- **Header** — number; title, editable in place ([AC-480](../verification.md#1512-projects)); status badge; `Archiviert` badge and notice on an archived project. Actions: download of all attachments as ZIP; `Archivieren` on an active project, `Wiederherstellen` and `Endgültig löschen` on an archived one ([AC-497](../verification.md#1512-projects), [AC-498](../verification.md#1512-projects), [AC-501](../verification.md#1512-projects), [AC-505](../verification.md#1512-projects), [AC-506](../verification.md#1512-projects)).
- **Camera button** — on touch devices, for a caller who may upload (§8.15.4).

### 8.15.2 Core Fields

- **Customer** — name; phone and email as links. A caller who may edit customers opens the customer's edit form from it ([management.md §8.9.3](management.md#893-edit-customer)); the project's customer itself does not change ([data-model.md §5.1](../data-model.md#51-project-entity)).
- **`Baustelle:` line** — the site address, or its fallback ([AC-489](../verification.md#1512-projects), [AC-490](../verification.md#1512-projects), [AC-491](../verification.md#1512-projects)), with one map link ([AC-283](../verification.md#1512-projects)); the same on the panel. Clicking it opens a dialog with the Baustelle group and `Speichern` ([AC-483](../verification.md#1512-projects), [AC-484](../verification.md#1512-projects), [AC-485](../verification.md#1512-projects), [AC-486](../verification.md#1512-projects), [AC-487](../verification.md#1512-projects), [AC-488](../verification.md#1512-projects), [AC-510](../verification.md#1512-projects)).
- **Planned start, planned end, estimated value, notes** — editable in place ([AC-480](../verification.md#1512-projects), [AC-511](../verification.md#1512-projects), [AC-482](../verification.md#1512-projects)).

### 8.15.3 Assigned-Worker Editor

The assigned workers as chips, each with a remove control, and an add control offering the active users with the worker role ([AC-481](../verification.md#1512-projects)).

### 8.15.4 Photo Gallery

The project's photo attachments ([AC-409](../verification.md#1526-attachments)) as thumbnails; a thumbnail opens the original in a lightbox.

- **Upload** — with `attachment:write`: drop zone and file browse, plus camera capture on camera-capable devices. CTA copy **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)). Photos are labeled `Foto`. A progress indicator per upload; a failed upload can be dismissed. Behavior: [AC-404](../verification.md#1526-attachments), [AC-405](../verification.md#1526-attachments), [AC-225](../verification.md#1526-attachments).
- **Per photo** — delete (§8.15.6).
- **Unavailable content** — placeholders per [AC-436](../verification.md#1526-attachments), [AC-244](../verification.md#1526-attachments), [AC-437](../verification.md#1526-attachments).

### 8.15.5 Binary List

The project's binary attachments — PDF, DOCX ([AC-409](../verification.md#1526-attachments)) — as a table: file name, label, uploader, upload time, `Herunterladen` ([AC-417](../verification.md#1526-attachments)).

- **Upload** — with `attachment:write`: a file picker and a label dropdown ([AC-446](../verification.md#1526-attachments)), default `Sonstiges`. A progress indicator per upload; a failed upload can be dismissed. Behavior: [AC-406](../verification.md#1526-attachments), [AC-225](../verification.md#1526-attachments).
- **Per file** — delete (§8.15.6).
- **Bulk download** — with at least one file selected, `Auswahl als ZIP` ([AC-433](../verification.md#1526-attachments), [AC-434](../verification.md#1526-attachments), [AC-435](../verification.md#1526-attachments)).
- **Unavailable content** — as in §8.15.4.

### 8.15.6 Soft-Hide

The delete action moves an attachment to the Papierkorb (§8.15.10, [AC-419](../verification.md#1526-attachments)). Offered to owner and office on every attachment, to a worker on their own uploads within the self-delete grace window **[C]** ([AC-411](../verification.md#1526-attachments)), never to the bookkeeper, and to no one on an archived project ([AC-412](../verification.md#1526-attachments)).

It asks first: a Yes / No dialog whose German warning names the Papierkorb, the retention window `L` **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)) during which restore is possible, and the permanent deletion after it ([AC-426](../verification.md#1526-attachments)).

### 8.15.10 Papierkorb Tab

Shown with `attachment:trash`; its badge counts the hidden attachments. Lists them ([AC-421](../verification.md#1526-attachments)) with file name, label, time since hiding as a German relative time (`"vor 1 Stunde"`), and a one-click restore without confirmation ([AC-422](../verification.md#1526-attachments)). Also available on archived projects ([AC-425](../verification.md#1526-attachments)).

- **States** — loading; forbidden; error with a German message and `Erneut versuchen` ([behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)); ready, where an empty list reads `"Keine gelöschten Dateien"`.

### 8.15.11 Invoice

Per-project invoice block. Surfaces every invoice tied to the project as a list with row-level actions and exposes the entry point to the invoice draft form ([invoices.md §8.16.2](invoices.md#8162-draft-form)). The standalone cross-project list view lives at [invoices.md §8.16](invoices.md#816-invoices-view) — same data, different surface.

- **List.** Paginated-shape but unfiltered table over `GET /api/invoices?projectId=...` ([api.md §14.2.14](../api.md#14214-invoice-operations)). Each row carries `number` (`RE-YYYY-NNNN` / `ST-YYYY-NNNN`, or `—` for drafts), German `status` label per the [invoices.md §8.16.1](invoices.md#8161-list-view) mapping, `issueDate` (DD.MM.YYYY; `—` for drafts), the snapshotted recipient name, and `totals.grossGrandTotal` (EUR, German locale). Default sort matches the standalone view (`issueDate DESC, createdAt DESC, id`).
- **Storno grouping.** A Storno sibling row (`cancellationOf` non-null) renders visually subordinated under its `cancellationOf` original — indented + muted accent + a `"Storno zu RE-YYYY-NNNN"` hint line. The grouping is rendered client-side from the `cancellationOf` reference; the underlying rows are independent in the database.
- **Row actions.**
  - **Draft row** (`status = 'draft'`, `invoice:write`): `Bearbeiten` re-opens the draft form pre-filled with the row; `Ausstellen` issues via `POST /api/invoices/:id/issue` after a confirmation dialog; `Verwerfen` hard-deletes via `DELETE /api/invoices/:id` after a confirmation dialog. Both dialogs preview the draft as it will be frozen or discarded — recipient, lines, `taxMode`, `performanceDate`, totals — and send the version that preview shows ([behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)). The form (§8.16.2 in [invoices.md](invoices.md)) carries only `Speichern` + `Abbrechen` — `Ausstellen` and `Verwerfen` live exclusively on the row.
  - **Issued row** (`status = 'issued'`, `cancellationOf` null): `PDF herunterladen` calls `GET /api/invoices/:id/pdf`; `Stornieren` (`invoice:write` only) opens the cancel dialog (below).
  - **Cancelled original / Storno sibling**: PDF download only. The cancellation atom on the issued row is one-shot — a second Storno on either the cancelled original or the Storno sibling is not offered.
- **`COMPANY_PROFILE_REQUIRED` handling.** When `Ausstellen` returns `422 COMPANY_PROFILE_REQUIRED` (missing required fields on the `company_profile` singleton), the block renders a dedicated German banner above the list. The banner names the missing field labels (translated from `details.missingFields` paths — e.g. `address.zip` → `PLZ`, `ustId` → `USt-IdNr.`) and offers a direct link to `/daten` ([daten.md §8.11.4](daten.md#8114-company-profile)) so the owner can complete the profile inline. The draft row stays untouched; the user fixes the profile and retries the row's `Ausstellen` action.
- **`Neue Rechnung` CTA.** Visible to `invoice:write` holders only, and only when the project's `status = 'rechnung_faellig'`. Opens the draft form inline as a modal panel; the new draft inherits the project's customer (server-side recipient pre-fill at create), the project's `plannedEnd` as the performance date, and the company profile's `defaultTaxMode`. Outside `rechnung_faellig`, the CTA is hidden; the list remains visible with whatever invoices the project already carries. An empty list renders the German placeholder `"Noch keine Rechnungen"`.
- **Cancel dialog.** Bespoke dialog (not the shared `ConfirmDialog` because the call requires a free-text `Grund` input). German warning copy per [invoices.md §8.16.3](invoices.md#8163-issued-invoice-viewer) (both rows remain, project status NOT auto-reverted). Reason is required client-side; the server validates again and remains authoritative. On confirm dispatches `POST /api/invoices/:id/cancel` with the reason; on success the original row's badge flips to `Storniert` and the Storno sibling appears in the list.
- **Project-status flip.** The issue path flips `project.status` to `abgerechnet` server-side (AC-287); the block refetches the project so the page header / Kanban column reflect the new state without a manual reload. The cancel path deliberately does NOT auto-revert (AC-290 trailing clause) — a user staring at an `abgerechnet` project with a cancelled invoice sees the gap and acts on it manually.
- **Cross-link to the full invoice view.** A `Alle Rechnungen anzeigen` affordance below the list navigates to `/rechnungen?projectId=<thisProjectId>` ([invoices.md §8.16.1](invoices.md#8161-list-view)). The standalone view reads the query on mount and pre-sets the projectId filter; the active filter renders as a removable chip on the toolbar so the user sees why the list is constrained (clearing strips the query param and refetches the unfiltered set).
- **Worker exclusion.** Workers do not hold `invoice:read` and never see the section. The page renders without it for worker callers.
- **Realtime refresh.** Subscribes to the `invoice_changed` SSE event ([api.md §14.2.13](../api.md#14213-realtime-events)) so a fresh issuance / cancellation from another session updates the block without a manual refresh.

---

_Cross-references: [index.md](../index.md) for scope and assumptions, [data-model.md](../data-model.md) for the Attachment entity, [workflow-views.md §8.4](workflow-views.md#84-project-detail-panel) for the quick-glance overlay, [verification.md](../verification.md) for acceptance criteria._
