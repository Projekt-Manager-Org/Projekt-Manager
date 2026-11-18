# UI: Invoices View

Section 8.16 of the [product spec](../index.md).

---

## 8.16 Invoices View

`/rechnungen`, for `invoice:read` holders ([index.md §8.7.1](index.md#871-views)). Behavior: [verification.md §15.30](../verification.md#1530-invoices). Fields: [data-model.md §5.15](../data-model.md#515-invoice-entity).

### 8.16.1 List

- **`Firmendaten`** — the company profile (§8.16.4), collapsed.
- **Filters** — `Jahr` ([AC-716](../verification.md#1530-invoices)), `Status` (`Entwurf`, `Ausgestellt`, `Storniert`, `Alle`) ([AC-715](../verification.md#1530-invoices)), search ([AC-714](../verification.md#1530-invoices)); `Alle Filter zurücksetzen`. Opened from a project's invoice block, also a removable project filter.
- **Export** — `Alle herunterladen (N)`, or `N ausgewählte herunterladen` for a selection ([AC-717](../verification.md#1530-invoices), [AC-718](../verification.md#1530-invoices), [AC-730](../verification.md#1530-invoices)). A draft cannot be selected.
- **Columns** — selection, number, status, issue date (`—` on a draft), recipient name, gross total.
- **Status** — `Entwurf`, `Ausgestellt`, `Storniert`; a Storno shows `Storno` and `Storno zu <number>`.
- **Order** — [AC-712](../verification.md#1530-invoices); each Storno under its original ([AC-713](../verification.md#1530-invoices)).
- **Empty** — `Keine Rechnungen`.
- **Row** — a draft opens its project with the draft form (§8.16.2); any other row opens the viewer (§8.16.3). Actions: on a draft, `Bearbeiten` and `Verwerfen` with a confirmation ([AC-687](../verification.md#1530-invoices)); otherwise `PDF herunterladen` ([AC-711](../verification.md#1530-invoices)). Issuing happens on the project only ([project-detail.md §8.15.11](project-detail.md#81511-invoice)).

### 8.16.2 Draft Form

A modal, opened from a project's invoice block ([project-detail.md §8.15.11](project-detail.md#81511-invoice)):

- **Recipient** — name, street, zip, city, USt-IdNr. ([AC-523](../verification.md#1530-invoices)); the note `Daten werden bei Ausstellung der Rechnung eingefroren.`
- **Lines** — `Beschreibung`, `Menge`, `Einheit`, `Einzelpreis (€ netto)`, `MwSt %` (the rates of the chosen tax mode), `Position (€ netto)` read-only; `+ Position hinzufügen`, a remove action per line.
- **Tax mode** — `Regulär`, `Reverse-Charge §13b` ([AC-683](../verification.md#1530-invoices)). A 0 % line under `Regulär`: [AC-726](../verification.md#1530-invoices).
- **Performance date** — pre-filled with the project's planned end.
- **Totals** — net, VAT per rate under `Regulär`, gross; recomputed while typing.
- **Actions** — `Speichern` ([AC-731](../verification.md#1530-invoices), [AC-684](../verification.md#1530-invoices), [AC-686](../verification.md#1530-invoices), [AC-379](../verification.md#1517-data-integrity)), `Abbrechen`. A live refresh keeps the form ([AC-720](../verification.md#1530-invoices)).

### 8.16.3 Invoice Viewer

`/rechnungen/:id`, for an issued or cancelled invoice or a Storno; read-only ([AC-708](../verification.md#1530-invoices)).

- **Shows** — number, status, issue and performance date, tax mode, a Storno's reason; issuer; recipient; lines; totals.
- **`ZUGFeRD herunterladen`** ([AC-711](../verification.md#1530-invoices)).
- **`Stornieren`** — on an issued invoice, not on a Storno. A confirmation with a required `Grund` ([AC-707](../verification.md#1530-invoices)) and the warning `Diese Aktion erstellt eine Storno-Rechnung. Beide Rechnungen bleiben dauerhaft erhalten. Der Projektstatus wird NICHT automatisch zurückgesetzt — bitte separat anpassen.` Behavior: [AC-702](../verification.md#1530-invoices), [AC-704](../verification.md#1530-invoices), [AC-720](../verification.md#1530-invoices).
- **Links** — a Storno to its original (`Original anzeigen`); an original to its Storno.

### 8.16.4 Company Profile

The `Firmendaten` panel of the list: `Firmenname`, `Straße`, `PLZ`, `Ort`, `Steuernummer`, `USt-IdNr.`, `IBAN`, `Akzentfarbe`, `Fußzeile`, `Standard-Steuermodus` (`Regulär`, `Reverse-Charge §13b`). Fields: [data-model.md §5.17](../data-model.md#517-company-profile-entity). The owner edits it with `Speichern`; for anyone else it is read-only ([AC-121](../verification.md#1521-role-scoping)). Behavior: [verification.md §15.31](../verification.md#1531-company-profile).
