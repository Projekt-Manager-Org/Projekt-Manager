# UI: Project Detail Page

Section 8.15 of the [product spec](../index.md) — the dedicated, shareable detail surface for a single project at `/projects/:id`. The existing Project Detail Panel ([workflow-views.md §8.4](workflow-views.md#84-project-detail-panel)) stays as the quick-glance overlay on Kanban and Calendar; the page is the canonical full-context view.

Shell and navigation live in [index.md](index.md); cross-cutting behavioral rules (in-flight lock, error handling, mutation semantics) in [behavior.md](behavior.md).

---

## 8.15 Project Detail Page

A full-page view of a single project. Reachable by URL (`/projects/:id`) and from the `Öffnen` affordance on the quick-glance detail panel. Route access follows the role matrix — workers land on the not-permitted surface ([AC-149](../verification.md#1521-role-scoping)) when the project is out of their scope.

### 8.15.1 Layout

```
┌──────────────────────────────────────────────────────────┐
│ Header — number, title, status badge                     │
├──────────────────────────────────────────────────────────┤
│ Core fields — customer, dates, value, notes              │
├──────────────────────────────────────────────────────────┤
│ Assigned workers — inline editor                         │
├──────────────────────────────────────────────────────────┤
│ Photo gallery — thumbnails + lightbox                    │
├──────────────────────────────────────────────────────────┤
│ Binary list — PDFs, DOCX, other non-photo attachments    │
├──────────────────────────────────────────────────────────┤
│ Invoice — per-project list + Neue Rechnung CTA (§8.15.11)│
├──────────────────────────────────────────────────────────┤
│ Activity feed — scoped to this project (see §8.4.1)      │
└──────────────────────────────────────────────────────────┘
```

Every region renders read-only for a caller without the relevant write permission; mutation controls follow [AC-121](../verification.md#1516-management-views).

### 8.15.2 Core Fields

The core-field region reuses the read contents of [workflow-views.md §8.4](workflow-views.md#84-project-detail-panel) — project number and title, status badge, customer (name, phone, email), `Baustelle:` line (see below), planned start/end date pickers, estimated value, notes, audit timestamps. Editability parity matches the management edit view ([management.md §8.8.3](management.md#883-edit-project)) — notes, customer, site address, estimated value, dates, and assigned workers are editable with `project:update`. Title edits also go through `project:update`. Status is mutated only through the transition operations; project number is immutable.

**`Baustelle:` rendering.** The detail surface shows a single `Baustelle:` line carrying the work site address. When `project.siteAddress` is non-null, render `street, zip city` from that object. When `project.siteAddress` is null, fall back to the customer's `address` ([data-model.md §5.6](../data-model.md#56-customer-entity)) and append a subtle inline hint `"(Kundenadresse)"` so the reader knows the displayed value is the billing address standing in for the site (see [data-model.md §5.1](../data-model.md#51-project-entity) for the fallback rule). The map-link affordance is rendered on whichever address is shown — there is exactly one map link per detail surface and it points at the address actually displayed. When both `project.siteAddress` and `customer.address` are absent, the line renders the German placeholder `"Keine Adresse"` and no map link. The same rendering rule applies to the quick-glance Project Detail Panel ([workflow-views.md §8.4](workflow-views.md#84-project-detail-panel)).

**`Baustelle:` editing.** Unlike the page's other core fields (notes, dates, estimated value, customer, title, assigned workers) which commit save-on-blur, the `Baustelle` group commits via an explicit `Speichern` button. The toggle + structured triple + all-or-none requiredness ([management.md §8.9.2](management.md#892-create-customer)) do not fit per-field blur semantics — a blur on `street` while `zip` is still empty would either dispatch a partial body or silently swallow the edit, neither acceptable. The save button is disabled while a mutation is in flight to prevent duplicate dispatches.

### 8.15.3 Assigned-Worker Editor

Worker-assignment editor visible on the page (not routed to a dedicated view). Backed by the existing Update project API operation ([api.md §14.2.2](../api.md#1422-projects)) with a patch carrying `assignedWorkerIds`.

- Multi-select from the active set of users holding the `worker` role. Each selected entry renders as a chip carrying the worker's `displayName`; a remove affordance detaches.
- Mutations require `project:update`. The control is hidden for callers without it; the page-level read surface continues to render the current assigned list.
- Changes are audited per [AC-177](../verification.md#1523-audit-log) — the `mutate()` helper writes a `project_worker` audit row (`action` ∈ `create` / `delete`; `entityLabel` = worker displayName per [data-model.md §5.10](../data-model.md#510-audit-log-entity)).
- In-flight mutation lock per [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior): while the patch is resolving, the chip set and the add control are disabled; a failed mutation reverts the optimistic UI ([AC-53](../verification.md#1515-navigation)).

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

### 8.15.9 Permissions Summary

Capability-to-region mapping on the project detail page:

| Region                   | Permission required to see / use                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| View gallery + list      | `attachment:read`                                                                                                                  |
| Upload photo / binary    | `attachment:write` (worker additionally requires project assignment)                                                               |
| Hide an attachment       | `attachment:hide` (soft-hide per ADR-0022; worker additionally requires authorship AND self-delete grace window **[C]** — §8.15.6) |
| Papierkorb tab + restore | `attachment:trash` (list hidden attachments and restore them)                                                                      |
| Bulk download (ZIP)      | `attachment:read`                                                                                                                  |
| Assigned-worker editor   | read inherent to the page; edit requires `project:update`                                                                          |

The role → capability mapping (which role holds `attachment:read`, `attachment:write`, `attachment:hide`, `attachment:trash`) is defined by the permission matrix in [api.md §14.3](../api.md#143-authorization-rules) — that is the SSOT. Server-side authorization is authoritative ([api.md §14.3](../api.md#143-authorization-rules)); client-side hiding is a UX convenience per [AC-121](../verification.md#1516-management-views).

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

_Cross-references: [index.md](../index.md) for scope and assumptions, [data-model.md](../data-model.md) for the Attachment entity, [api.md](../api.md) for the presigned-PUT upload flow, [workflow-views.md §8.4](workflow-views.md#84-project-detail-panel) for the quick-glance overlay, [verification.md](../verification.md) for acceptance criteria._
