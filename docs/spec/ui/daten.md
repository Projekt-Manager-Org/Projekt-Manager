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

The dialog is open while an export is in progress. Once it is closed, the Export section shows the latest export's download or failure reason inline; once its archive is deleted ([AC-589](../verification.md#1514-data-exchange)), `Das Archiv ist nicht mehr verfügbar. Starten Sie einen neuen Export.` instead of the download. The download is named `projekt-manager-export-<YYYY-MM-DD>T<HH-mm-ss>.zip`.

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
