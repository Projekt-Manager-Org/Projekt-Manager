# UI: Email Data Intake

Section 8.12 of the [product spec](../index.md).

---

## 8.12 Email Data Intake

A header action `E-Mail Import` opens a dialog that turns a pasted email into a customer and a project. Shown to `customer:write` holders ([AC-121](../verification.md#1521-role-scoping)) while extraction is configured ([AC-734](../verification.md#1518-email-data-intake)). Behavior: [verification.md §15.18](../verification.md#1518-email-data-intake).

| Step   | Shows                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paste  | A textarea for the email text; `Daten extrahieren`, `Abbrechen`; `Extrahiere Daten...` while extracting; the error, if extraction failed                                                                                                                                                                                                                                                                                                           |
| Review | `Kundendaten`: a `Vorhandener Kunde` search over existing customers; name, street, zip, city, phone, email. `Projektdaten`: number (when left empty, shows the generated number it saves) with its free / taken verdict ([AC-478](../verification.md#1512-projects), [AC-479](../verification.md#1512-projects)), title, Baustelle as in [Create Project](management.md#882-create-project). `Speichern`, `Abbrechen`; the error, if saving failed |

All review fields are editable. The customer search starts with the extracted name; selecting a customer hides the customer fields.
