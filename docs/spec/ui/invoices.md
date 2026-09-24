# UI: Invoices View

Section 8.16 of the [product spec](../index.md) — the invoice list and per-invoice surfaces. Architectural rationale and the contract pinned by [ADR-0026](../../adr/0026-invoices-immutability-and-zugferd.md). Entity in [data-model.md §5.15](../data-model.md#515-invoice-entity); API in [api.md §14.2.14](../api.md#14214-invoice-operations).

Shell and navigation live in [index.md](index.md); cross-cutting behavioral rules (in-flight lock, error handling, mutation semantics) in [behavior.md](behavior.md).

---

## 8.16 Invoices View

Reachable at `/rechnungen`; nav placement per [index.md §8.7.1](index.md#871-views). Visible to callers with `invoice:read`. Workers do not see the entry.

### 8.16.1 List View

```
┌──────────────────────────────────────────────────────────┐
│  [Jahr ▾]  [Status ▾]  [Suche …]                         │
├──────────────────────────────────────────────────────────┤
│  Nr.           Status       Datum       Kunde      Summe  │
│  RE-2026-0042  Storniert    12.04.2026  Müller    1.250,00│
│   ↳ ST-2026-0003 Storno     18.04.2026  Müller   -1.250,00│
│  RE-2026-0041  Ausgestellt  05.04.2026  Schmidt   2.380,00│
│  RE-2026-0040  Entwurf      —           Weber     1.100,00│
└──────────────────────────────────────────────────────────┘
```

A paginated table over `GET /api/invoices` ([api.md §14.2.14](../api.md#14214-invoice-operations)). Columns: `number`, `status` (German label per the mapping below), `issueDate` (DD.MM.YYYY; `—` for drafts), recipient name from the snapshotted `Invoice.recipient.name`, `totals.grossGrandTotal` (EUR, German locale).

- **Status labels.** `Invoice.status` ([data-model.md §5.15](../data-model.md#515-invoice-entity)) maps to German display labels: `'draft' → "Entwurf"`, `'issued' → "Ausgestellt"`, `'cancelled' → "Storniert"`. Storno sibling rows (`cancellationOf` non-null, status `'issued'`) render with the row-kind label `"Storno"` so the user distinguishes them at a glance from a fresh issued invoice. No payment-state labels — payment tracking is out of scope per the kickoff.
- **Filters.** `Jahr` dropdown (years derived from existing invoice issue dates plus the current year), `Status` dropdown (`Entwurf` / `Ausgestellt` / `Storniert` + an `Alle` option), and a free-text `Suche` matching `number` and recipient name (substring, case-insensitive). Filters AND-compose; the server enforces the same composition.
- **Stornorechnung grouping.** Storno rows render visually subordinated under their `cancellationOf` original — same row group, indented chevron, muted text on the original's row. The grouping is rendered client-side from the `cancellationOf` references in the list response; the underlying rows are independent in the database. Bookkeeper exports include both rows independently.
- **Default sort.** `issueDate DESC` then `createdAt DESC`, `id` as stable tiebreaker. Drafts (with `issueDate = null`) sort first within their group, ordered by `createdAt DESC`.
- **Empty state.** `"Keine Rechnungen"` German placeholder. A `data:export`-less role with no invoices visible (none on any project) sees the same placeholder.
- **Permission gate.** The list is rendered when the caller holds `invoice:read` ([api.md §14.3](../api.md#143-authorization-rules)). Out-of-scope rows (worker case) are excluded server-side via the repository predicate ([AC-298](../verification.md#1530-invoices)); the client never sees them. Bookkeeper sees the full list per the matrix.
- **Row actions.** Clicking an issued or cancelled row navigates to the per-invoice viewer (`/rechnungen/:id`, §8.16.3); clicking a draft row navigates to the parent project's detail page (`/projects/:id`) where the per-project block (§8.15.11) hosts the only editable surface for a draft. Action affordances render as buttons inside the row's action area; row click and action-button clicks are distinct interactions. Draft rows (visible only to `invoice:write` holders): `Bearbeiten` (navigates to the project so the per-project block's form opens with the row pre-filled) and `Verwerfen` (deletes the draft via `DELETE /api/invoices/:id` after a confirmation). `Ausstellen` is intentionally NOT exposed on this surface — issuing requires the project context (project-status flip per AC-287, project refetch), which lives on the per-project block. Issued and Storno rows: `PDF herunterladen` only.

> **Future-work seam — bookkeeper view.** The kickoff ([kickoff.md "Done when"](../../project/kickoff.md#done-when-final-product)) calls for "searching, **grouping** and **exporting**" on the bookkeeper invoice list. The current surface delivers `Suche`, `Jahr`, and `Status` filters plus the per-invoice PDF download. Grouping (by year / customer / tax mode) and bulk CSV export are deferred to a follow-up issue covering the bookkeeper view. Tracked explicitly here so the kickoff requirement is not silently dropped.

### 8.16.2 Draft Form

Visible to callers with `invoice:write` (owner / office). Reachable from the per-project block's `Neue Rechnung` CTA ([project-detail.md §8.15.11](project-detail.md#81511-invoice)) on a project in `rechnung_faellig`, and from the per-project block's `Bearbeiten` row action on an existing draft. The form's actions are limited to persistence — `Ausstellen` and `Verwerfen` are row-level affordances on the per-project block; see §8.15.11 for the issuance flow (including the `COMPANY_PROFILE_REQUIRED` banner contract).

- **Recipient block.** Auto-filled from the project's customer (`name` and `address`); every field is editable inline. A note next to the block reminds: `"Daten werden bei Ausstellung der Rechnung eingefroren."` — driving home the snapshot-at-issuance semantics ([data-model.md §5.15](../data-model.md#515-invoice-entity)).
- **Line editor.** A table with rows of `Beschreibung` (description), `Menge` (quantity), `Einheit` (unit — free text), `Einzelpreis (€ netto)` (unit price, net of VAT), `MwSt %` (tax rate — 0 / 7 / 19 in the dropdown), and `Position (€ netto)` (line total, computed client-side from `quantity * unitPrice`, rendered in real time, server re-derives at issuance). An `+ Position hinzufügen` action appends a row; a row-level remove affordance deletes. The line total column is read-only; everything else is editable.
- **Tax-mode select.** Three-way dropdown (`Regulär`, `Kleinunternehmer §19`, `Reverse-Charge §13b`). Pre-filled from `company_profile.defaultTaxMode` ([data-model.md §5.17](../data-model.md#517-company-profile-entity)). Changing the value triggers a re-render of the totals block (the per-rate breakdown disappears for `kleinunternehmer` and `reverse_charge`).
- **Performance date input.** Required to issue; pre-filled with `project.plannedEnd` when present (a sensible default — the Leistungsdatum often matches the project's planned end). German date picker (DD.MM.YYYY).
- **Totals block.** Read-only; rendered from the client-side computation over `lines` + `taxMode` (`Nettosumme` + per-rate `MwSt …%` rows for `standard`, just net + gross for `kleinunternehmer` / `reverse_charge`, plus `Bruttosumme`). EUR with German locale formatting. The server re-derives at issue time; the visible totals are a UX preview.
- **Actions.** `Speichern` persists the draft via `PATCH /api/invoices/:id` (or `POST /api/invoices` on first save). `Abbrechen` (or modal close) discards any unsaved typed changes and closes the form; persisted state on the row stays intact. Issuance and discarding the persisted row are row-level affordances on the per-project block (§8.15.11) — the form itself does not expose them.
- **In-flight lock.** Per [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior), all inputs and the modal close affordances are disabled while a save request is in flight ([AC-131](../verification.md#153-behavioral)).
- **Accessibility.** The form is announced as a modal dialog with a labelled heading; focus is trapped within the form and Escape closes (unless a save is in flight). Same pattern as the cancel dialog (§8.16.3).

### 8.16.3 Issued Invoice Viewer

The viewer for `status ∈ {'issued', 'cancelled'}` rows — reachable from a list-view row click (§8.16.1) or from the `/rechnungen/:id` deep link.

- **Read-only by structure.** Every field is displayed without an edit affordance — the row is immutable ([data-model.md §6.14](../data-model.md#614-immutability-of-issued-invoices)).
- **Snapshot summary.** Number, status (German label including `Storniert` for cancelled originals and `Storno` for Storno rows), issue date, performance date, recipient (name + address from the snapshot), issuer (company snapshot), lines (read-only table), totals.
- **Actions.**
  - `PDF herunterladen` — calls `GET /api/invoices/:id/pdf` and triggers a download. Renamed to `ZUGFeRD herunterladen` when the snapshotted `profile = 'zugferd-en16931'` (clarifies the content for B2B receivers).
  - `Stornorechnung erstellen` — visible on `status = 'issued'` rows for `invoice:write` holders. Opens a confirmation dialog with a free-text `Grund` input (snapshotted onto `Invoice.cancellationReason`) and a German warning: `"Diese Aktion erstellt eine Storno-Rechnung. Beide Rechnungen bleiben dauerhaft erhalten. Der Projektstatus wird NICHT automatisch zurückgesetzt — bitte separat anpassen."` On confirm dispatches `POST /api/invoices/:id/cancel`.
  - The Storno row, when opened directly, links back to its `cancellationOf` original via an `Original anzeigen` affordance. The original row, when opened, links to every Storno sibling via the same indented chevron used in the list view.

### 8.16.4 Permissions Summary

| Region                              | Permission                                                                                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List view (read)                    | `invoice:read`                                                                                                                                                                                                                                                  |
| Draft form (create / edit / delete) | `invoice:write` + project in `rechnung_faellig` for new                                                                                                                                                                                                         |
| Issue action                        | `invoice:write` + draft passes pre-conditions                                                                                                                                                                                                                   |
| Cancel action                       | `invoice:write` + invoice `status = 'issued'`                                                                                                                                                                                                                   |
| PDF download                        | `invoice:read` (per [AC-299](../verification.md#1530-invoices))                                                                                                                                                                                                 |
| Worker access                       | Not visible. Worker is excluded by the repository scope predicate ([ADR-0019](../../adr/0019-worker-data-scoping-repository-layer-predicate.md)). The `/rechnungen` route returns the not-permitted surface per [AC-149](../verification.md#1521-role-scoping). |

Server-side authorization is authoritative; client-side hiding is a UX convenience per [AC-121](../verification.md#1516-management-views).

### 8.16.5 Realtime Refresh

The list view and any open per-invoice viewer subscribe to `invoice_changed` SSE events ([api.md §14.2.13](../api.md#14213-realtime-events), [architecture.md §11.13](../architecture.md#1113-realtime-invalidation-channel)). On event receipt the client refetches the list / detail surface; an inflight draft form is not interrupted (the user's typed values remain — the refresh affects only the read surface). An open Stornorechnung confirmation dialog on a per-invoice viewer is similarly protected: the refetch silently updates the underlying viewer's read state but does not close the open dialog or replace its content — closing a dialog the user is mid-action on is a misleading-state defect class. If the underlying invoice was concurrently cancelled by another session (race-condition window), the subsequent cancel request returns `INVOICE_ALREADY_CANCELLED` and the dialog surfaces the error via the standard mutation error banner. Cross-session value: an office user looking at the invoice list sees a fresh `RE-YYYY-NNNN` row appear within one SSE round trip when the owner issues a new invoice from a different session.

---

_Cross-references: [index.md](../index.md) for scope and assumptions, [data-model.md](../data-model.md) for the Invoice / InvoiceSequence / CompanyProfile entities, [api.md](../api.md) for the invoice operations, [project-detail.md §8.15](project-detail.md#815-project-detail-page) for the per-project invoice block, [daten.md §8.11.4](daten.md#8114-company-profile) for the company-profile form, [verification.md](../verification.md) for acceptance criteria._
