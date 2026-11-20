# UI: Project Detail Page

Section 8.15 of the [product spec](../index.md) — the full-page view of one project at `/projects/:id`. The detail panel ([workflow-views.md §8.4](workflow-views.md#84-project-detail-panel)) is the quick-glance overlay on the board and calendar.

Shell and navigation live in [index.md](index.md); cross-cutting interaction rules (in-flight lock, error handling, dialogs) in [verification.md §15.15](../verification.md#1515-navigation-and-interaction).

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

- **Customer** — name; phone and email as links, for a worker on a soft-deleted project the name only ([AC-542](../verification.md#1521-role-scoping)). A caller who may edit customers opens the customer's edit form from it ([management.md §8.9.3](management.md#893-edit-customer)); the project's customer itself does not change ([data-model.md §5.1](../data-model.md#51-project-entity)).
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

- **States** — loading; forbidden; error with a German message and `Erneut versuchen`; ready, where an empty list reads `"Keine gelöschten Dateien"`.

### 8.15.11 Invoice

The project's invoices, for `invoice:read` holders. Behavior: [verification.md §15.30](../verification.md#1530-invoices).

- **List** — the columns, status labels, order and Storno grouping of [invoices.md §8.16.1](invoices.md#8161-list). Empty: `Noch keine Rechnungen`.
- **`Neue Rechnung`** — while the project is in `Rechnung fällig`; opens the draft form ([invoices.md §8.16.2](invoices.md#8162-draft-form)).
- **Draft row** — `Bearbeiten` opens the draft form. `Ausstellen` and `Verwerfen`, each after a confirmation previewing the draft ([AC-728](../verification.md#1530-invoices), [AC-729](../verification.md#1530-invoices)). Behavior: [AC-689](../verification.md#1530-invoices), [AC-692](../verification.md#1530-invoices), [AC-687](../verification.md#1530-invoices).
- **Issued invoice** — `PDF herunterladen` ([AC-711](../verification.md#1530-invoices)); `Stornieren`, with the confirmation of [invoices.md §8.16.3](invoices.md#8163-invoice-viewer).
- **Cancelled invoice, Storno** — `PDF herunterladen`.
- **Incomplete company profile** — [AC-725](../verification.md#1530-invoices).
- **`Alle Rechnungen anzeigen`** — the invoice list, filtered to this project.

---

_Cross-references: [index.md](../index.md) for scope and assumptions, [data-model.md](../data-model.md) for the Attachment entity, [workflow-views.md §8.4](workflow-views.md#84-project-detail-panel) for the quick-glance overlay, [verification.md](../verification.md) for acceptance criteria._
