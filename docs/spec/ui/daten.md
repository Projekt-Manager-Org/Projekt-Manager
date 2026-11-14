# UI: Daten View

Section 8.11 of the [product spec](../index.md).

---

## 8.11 Daten View

Export and import of the whole deployment as one archive ([data-model.md §5.8](../data-model.md#58-export-archive)). Shown to `data:export` holders ([AC-142](../verification.md#1514-data-exchange)); the Import section needs `data:restore` ([AC-121](../verification.md#1521-role-scoping)). Behavior: [verification.md §15.14](../verification.md#1514-data-exchange).

### 8.11.1 Export

An Export section with the `Export` action. It opens the Export dialog:

| Phase       | Shows                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start       | `Daten exportieren`; `Der Papierkorb wird nicht mit exportiert.`; below the mobile-warning breakpoint **[C]** `Für Desktop-Nutzung gedacht; Downloads können sehr groß sein.`; `Export starten`, `Abbrechen` |
| In progress | `Export läuft`; files and bytes done of total; the current file. No cancel                                                                                                                                   |
| Ready       | `Export bereit`; `Herunterladen`                                                                                                                                                                             |
| Failed      | The failure reason                                                                                                                                                                                           |

The dialog is open while an export is in progress. Once it is closed, the Export section shows the latest export's download or failure reason inline. The download is named `projekt-manager-export-<YYYY-MM-DD>T<HH-mm-ss>.zip`.

### 8.11.2 Import

An Import section with the `Import` action. It opens a file picker, then the Import dialog:

| Phase        | Shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmation | `Daten importieren`; `Die bestehenden Daten werden unwiderruflich gelöscht.`; `Der Papierkorb ist nicht Teil des Archivs: gelöschte Anhänge, die dort noch wiederherstellbar sind, gehen dabei endgültig verloren.`; below the mobile-warning breakpoint **[C]** `Für Desktop-Nutzung gedacht; Importe können sehr groß sein.`; `Zur Bestätigung bitte „<phrase>" eingeben:` with an input; `Import starten`, `Abbrechen`; for a file whose size differs from the total size of an upload in progress, `Diese Datei gehört nicht zum laufenden Import.` and `Import starten` stays disabled |
| Upload       | `Hochladen …` while the open page uploads it, otherwise `Upload unterbrochen. Zum Fortsetzen das Archiv über „Import“ erneut wählen.`; bytes done of total                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Restore      | `Wiederherstellung läuft`; files done of total; the current file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Result       | `Import abgeschlossen`; `<n> Anhänge wiederhergestellt`; `Schließen`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Failed       | The failure reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 8.11.3 Speichernutzung

A row at the top of the view, above Export and Import, shown to `data:export` holders only. It shows two storage totals ([data-model.md §5.14](../data-model.md#514-storage-usage)), both always on screen, with no tooltip:

| Total      | Label           |
| ---------- | --------------- |
| Visible    | `Sichtbar`      |
| Papierkorb | `Im Papierkorb` |

Behavior: [verification.md §15.29](../verification.md#1529-storage-usage).

### 8.11.4 Company Profile

An owner-only form persisting the singleton `company_profile` row ([data-model.md §5.17](../data-model.md#517-company-profile-entity)) — the source from which every issued invoice's `issuer` block is snapshotted. The form is the only UI surface that mutates the row; the API contract is [api.md §14.2.15](../api.md#14215-company-profile-operations).

**Visibility.** The section is rendered to every authenticated role with read access; the editable surface (inputs enabled, save button visible) is owner-only. Office, worker, and bookkeeper see the section as a read-only summary — useful for verifying the values an invoice will snapshot, with no save affordance. The server is authoritative ([AC-576](../verification.md#1521-role-scoping)).

**Fields.**

- `Firmenname` — required, non-empty.
- `Adresse` — three components `Straße`, `PLZ`, `Ort`; all three required, non-empty (no all-or-none toggle here; an address with one or two components is meaningless on an invoice).
- `Steuernummer` — required, non-empty.
- `USt-IdNr.` — required, non-empty.
- `IBAN` — optional structurally; the renderer emits a payment block when present.
- `Akzentfarbe` — optional hex color used by the **rendered invoice** (the rules bracketing the line-item table); falls back to the deploy-time brand accent when unset. It is a document-styling value, not an app-theme override: the app theme needs a light/dark pair with contrast guarantees and is owned by the branding config ([architecture.md §12.5](../architecture.md#125-theming-model)).
- `Fußzeile` — optional free German text printed at the foot of every rendered invoice.
- `Standard-Steuermodus` (`defaultTaxMode`) — two-way dropdown (`Regulär`, `Reverse-Charge §13b`). Pre-fills new invoice drafts ([invoices.md §8.16.2](invoices.md#8162-draft-form)).

**Validation.** Required-field validation runs client-side as a UX affordance; the server re-validates and remains authoritative ([AC-303](../verification.md#1531-company-profile)). Submitting with a required field empty (e.g. `USt-IdNr.`) surfaces an inline German validation message next to the offending field and does NOT dispatch the PUT — the save handler short-circuits client-side. The save button is disabled only while an in-flight save is pending ([behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)); keeping it clickable on incomplete forms is intentional so the user gets explicit field-level feedback instead of a silently unresponsive button.

**Save.** A single `Speichern` action dispatches `PUT /api/company-profile`. On success the form re-renders with the persisted values; the audit log records the mutation per [AC-302](../verification.md#1531-company-profile). On rejection (e.g. `422 VALIDATION_ERROR` from an empty required field) the German error message names the offending fields and the form retains the user's typed values.

**No deletion.** The row is a singleton ([AC-300](../verification.md#1531-company-profile)) — no delete affordance exists.
