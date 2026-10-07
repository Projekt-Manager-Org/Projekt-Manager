# Verfahrensdokumentation (GoBD) — Systemteil Projekt-Manager

> **Baseline, not the document of record.** The operating company keeps its own copy outside this public repo and fills the `⟨…⟩` placeholders there. This file holds only what the system itself determines; facts link to their canonical source instead of restating it ([D-SSOT](../../review/conventions-docs-general.md)). German by design — the reader is the tax auditor. Legal assessments are unconfirmed and marked **[zu bestätigen]**; confirmations are recorded only in the private copy, never here.

Struktur nach [GoBD](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/2019-11-28-GoBD.html) Rz. 151 ff.: allgemeine Beschreibung, Anwender-, technische System- und Betriebsdokumentation; ergänzt um IKS, Aufbewahrung und Datenzugriff.

**[zu bestätigen]** kennzeichnet rechtliche Einschätzungen ohne steuerliche Prüfung. Bestätigung oder Korrektur nur in der unternehmenseigenen Fassung.

## 0. Geltungsbereich und Stand

| Punkt                | Inhalt                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Unternehmen          | ⟨Firma, Anschrift, Steuernummer⟩                                                                |
| Verantwortlich       | ⟨Name, Funktion⟩ · Betrieb/IT: ⟨Name⟩ · Steuerberatung: ⟨Kanzlei⟩                               |
| System               | Projekt-Manager, eingesetzte Version ⟨Image-Tag / Commit⟩                                       |
| Abgedeckt            | Erstellung, Stornierung und Archivierung von **Ausgangsrechnungen**                             |
| Nicht abgedeckt      | Eingangsrechnungen, Buchführung, Zahlungsverkehr, Kasse — ⟨jeweilige Teil-Dokumentation/System⟩ |
| Gültig ab · Freigabe | ⟨Datum⟩ · ⟨Name, Unterschrift⟩                                                                  |

## 1. Allgemeine Beschreibung — Prozess Ausgangsrechnung

```
Projekt "Rechnung fällig"
  → Entwurf (frei änderbar, keine Nummer)
  → Ausstellung: Nummer RE-JJJJ-NNNN, Inhalt eingefroren,
                 ZUGFeRD-PDF erzeugt und unveränderbar abgelegt (§3),
                 Projekt → "Abgerechnet"
  → PDF-Download → Versand an Kunden ⟨Kanal, z. B. E-Mail aus Postfach X⟩
  → Übergabe an die Buchhaltung ⟨Weg, Turnus⟩
Korrektur: nur per Stornorechnung ST-JJJJ-NNNN + neue Rechnung
```

Kanonische Beschreibung: [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md), [spec architecture.md §11.14](../spec/architecture.md#1114-invoice-domain).

## 2. Anwenderdokumentation

- **Bedienung:** [spec ui/invoices.md](../spec/ui/invoices.md) (Liste, Entwurf, Ausstellung, Storno). ⟨Ggf. interne Kurzanleitung⟩
- **Rollen und Rechte:** Rolle → Berechtigung: [api.md §14.3](../spec/api.md#143-authorization-rules); Berechtigung → Aktion: [ui/invoices.md §8.16.4](../spec/ui/invoices.md#8164-permissions-summary). Vergabe der Rollen an Personen: ⟨Liste Benutzer → Rolle, Stand⟩.
- **Anmeldung:** persönliche Konten, keine Sammelkonten ⟨bestätigen⟩.

## 3. Technische Systemdokumentation

| Thema             | Umsetzung                                                                                                                                                                                                                                                                                                                                                                                              | Quelle                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format            | ZUGFeRD EN 16931 (Comfort): PDF/A-3 mit eingebetteter `factur-x.xml`; XSD-Schema-Validierung vor der Ablage (keine Geschäftsregel-/Schematron-Prüfung)                                                                                                                                                                                                                                                 | [ADR-0026 §E-invoice format](../adr/0026-invoices-immutability-and-zugferd.md#e-invoice-format)                                                       |
| Nummernkreis      | Je Jahr und Art (RE/ST) lückenlos, vergeben in derselben Transaktion wie die Rechnung. Ausnahme: Lücke nach Datenwiederherstellung (§4.2)                                                                                                                                                                                                                                                              | [data-model.md §6.13](../spec/data-model.md#613-gapless-sequence-allocation)                                                                          |
| Unveränderbarkeit | (a) Änderung ausgestellter Rechnungen: von der Anwendung abgewiesen und zusätzlich per Datenbank-Trigger blockiert; Korrektur nur per Storno. Löschen verhindert nur die Anwendung. (b) Speicher: PDF mit Compliance Object Lock beim Speicheranbieter — auch mit Administratorrechten vor Ablauf nicht löschbar. Ausreichend nach GoBD Rz. 107 ff.: **[zu bestätigen]**                               | [data-model.md §6.14](../spec/data-model.md#614-immutability-of-issued-invoices), [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md) |
| Sperrfrist        | Pro Objekt, `INVOICE_OBJECT_LOCK_DAYS` ⟨produktiver Wert⟩                                                                                                                                                                                                                                                                                                                                              | [ADR-0026 §Storage and retention](../adr/0026-invoices-immutability-and-zugferd.md#storage-and-retention)                                             |
| Verschlüsselung   | PDF verschlüsselt abgelegt; Schlüssel des Betreibers außerhalb des Systems verwahrt (§4.3)                                                                                                                                                                                                                                                                                                             | [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)                                                                                           |
| Protokollierung   | Ausstellung und Storno im Änderungsprotokoll (`audit_log`) mit Benutzer und Zeitpunkt; Löschung nach `AUDIT_RETENTION_WINDOW_DAYS` ⟨produktiver Wert⟩. In den Rechnungsdatensätzen bleiben Nummer, Ausstellungsdatum und die Storno-Verknüpfung (Storno: Datum, Grund, Benutzer); der ausstellende Benutzer nur bis zu einem Storno. Keine Aufbewahrungspflicht für das Protokoll: **[zu bestätigen]** | [data-model.md §5.10](../spec/data-model.md#510-audit-log-entity), [§6.10](../spec/data-model.md#610-audit-log-retention)                             |
| Infrastruktur     | Ein Server (VPS) mit PostgreSQL; Rechnungs-PDFs bei Backblaze B2; Datensicherungen bei Cloudflare R2. Standort/Region: ⟨je Anbieter⟩; AV-Verträge: ⟨Ablage⟩                                                                                                                                                                                                                                            | [DATA.md](../../DATA.md)                                                                                                                              |

## 4. Betriebsdokumentation

### 4.1 Datensicherung

- **Datenbank:** automatische, verschlüsselte Vollsicherung nach festem Zeitplan; jede Sicherung wird vor dem Hochladen durch eine Probe-Wiederherstellung geprüft. Zeitplan: [overview.md §Cadence](../ops/backup/overview.md#cadence). Aufbewahrung: [ADR-0020 §Retention](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention).
- **Rechnungs-PDFs:** keine zusätzliche Sicherung außerhalb des Speicheranbieters; Schutz durch Versionierung + Object Lock ([DATA.md Layer 3](../../DATA.md#layer-3--binary-attachments-provider-enforced-durability--e2e)).

### 4.2 Wiederherstellung und akzeptiertes Verlustfenster

**Unternehmerische Entscheidung (RPO):** Daten zwischen der letzten Sicherung und einem Totalausfall können verloren gehen. Das Fenster ergibt sich aus dem Zeitplan (§4.1). Akzeptiert durch ⟨Name⟩ am ⟨Datum⟩. Mit dem Ersatzweg unten steuerlich vertretbar: **[zu bestätigen]**.

Folgen für Rechnungen, die in diesem Fenster ausgestellt wurden:

| Folge                                        | Behandlung                                                                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rechnung fehlt in der wiederhergestellten DB | Das PDF bleibt gesperrt im Speicher, ist ohne den verlorenen DB-Eintrag aber nicht entschlüsselbar (offen: #478). Doppel aus dem Versandweg beschaffen (⟨gesendete E-Mails⟩, notfalls beim Empfänger), ablegen in ⟨Ablageort⟩ |
| Nummernkreis                                 | Wird über die verlorenen Nummern hinaus fortgesetzt — keine Doppelvergabe; die Lücke wird im Störfallprotokoll begründet                                                                                                      |
| Projektstatus zurück auf "Rechnung fällig"   | Manuell korrigieren — Doppelabrechnung vermeiden                                                                                                                                                                              |

Ablauf: [recovery.md](../ops/backup/recovery.md). Störfallprotokolle: ⟨Ablageort⟩.

### 4.3 Schlüsselverwahrung

Zwei unabhängige Schlüssel des Betreibers: der Speicherschlüssel (Rechnungs-PDFs) und der Sicherungsschlüssel (Datenbanksicherungen). Ohne den jeweiligen Schlüssel sind diese Daten nicht lesbar.

| Schlüssel           | Verwahrung                                                                       | Orte   | Prüfung der Verwahrkopie                                       |
| ------------------- | -------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| Speicherschlüssel   | [binary-key/setup.md §2](../ops/binary-key/setup.md#2-generate-the-age-key-pair) | ⟨Orte⟩ | monatlich, [binary-key/drills.md](../ops/binary-key/drills.md) |
| Sicherungsschlüssel | [backup/setup.md §2](../ops/backup/setup.md#2-generate-the-age-key-pair)         | ⟨Orte⟩ | ⟨Turnus⟩                                                       |

### 4.4 Änderungsmanagement

Jede Programmänderung über Pull Request mit automatischen Prüfungen; ausgelieferte Versionen sind unveränderliche Container-Images ([ADR-0011](../adr/0011-build-images-in-ci-distribute-via-ghcr.md), [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)). Versionshistorie im Betrieb: ⟨Datum → Image-Tag⟩.

## 5. Internes Kontrollsystem

| Kontrolle                                                                      | Turnus      | Verantwortlich | Nachweis        |
| ------------------------------------------------------------------------------ | ----------- | -------------- | --------------- |
| Sicherungs- und Drill-Status (Anzeige in der Anwendung)                        | ⟨täglich⟩   | ⟨⟩             | ⟨⟩              |
| Probe-Wiederherstellung am Arbeitsplatz ([drills.md](../ops/backup/drills.md)) | monatlich   | ⟨⟩             | ⟨Ops-Log-Notiz⟩ |
| Schlüssel-Drill Speicherschlüssel                                              | monatlich   | ⟨⟩             | ⟨Ops-Log-Notiz⟩ |
| Abgleich Ausgangsrechnungen ↔ Buchhaltung                                      | ⟨monatlich⟩ | ⟨⟩             | ⟨⟩              |
| Benutzer- und Rollenübersicht prüfen                                           | ⟨jährlich⟩  | ⟨⟩             | ⟨⟩              |

## 6. Aufbewahrung

- **Frist:** Rechnungsdoppel 8 Jahre (§14b UStG, §147 AO) **[zu bestätigen]**.
- **Form:** vollständiges PDF/A-3 inkl. eingebetteter XML, unverändert wie versandt (§3). Erfüllt die Anforderungen an hybride E-Rechnungen (strukturierter Teil) nach der GoBD-Änderung 2025: **[zu bestätigen]**.
- **Lesbarkeit über die Frist:** setzt den Speicherschlüssel (§4.3) und derzeit die Datenbank voraus (§4.2). ⟨Exit-Strategie bei Systemwechsel: Export nach §7⟩.

## 7. Datenzugriff der Finanzverwaltung (§147 Abs. 6 AO)

| Art                               | Umsetzung                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Z1 unmittelbar (Nur-Lese-Zugriff) | Konto mit Rolle `bookkeeper` — nur lesend, sieht aber auch Kunden, Projekte und Anhänge ([api.md §14.3](../spec/api.md#143-authorization-rules)) ⟨Vergabe nach Bedarf⟩. Als Z1-Zugang geeignet: **[zu bestätigen]** |
| Z2 mittelbar                      | Auswertung durch ⟨Name⟩ nach Vorgabe des Prüfers                                                                                                                                                                    |
| Z3 Datenträgerüberlassung         | ZIP-Export der Rechnungen (ZUGFeRD-PDFs + CSV-Übersicht), `POST /api/invoices/export` ([openapi.json](../api/openapi.json)). Als Z3-Datenträger geeignet: **[zu bestätigen]**                                       |

## Änderungshistorie

| Datum   | Änderung                                    | Freigabe |
| ------- | ------------------------------------------- | -------- |
| ⟨Datum⟩ | Erstfassung auf Basis der Baseline ⟨Commit⟩ | ⟨⟩       |
