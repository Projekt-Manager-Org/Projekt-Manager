# UI: Daten View

Section 8.11 of the [product spec](../index.md) — the unified business-data exchange surface (export + import). See [ADR-0018](../../adr/0018-data-persistence-and-recovery-layered-strategy.md) for the layered persistence strategy and [api.md §14.2.4](../api.md#1424-unified-data-exchange) for the server contract.

---

## 8.11 Daten View

The view surfaces the full-account export and import jobs ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Export job / Import job). Visible only to users with `data:export`; the import section is visible only to users who additionally hold `data:restore`.

The business-data export/import (`ExportService` / `ImportService`) are not standalone UI actions — the export and import jobs call them server-side for the business-data leg. See [api.md §14.2.4](../api.md#1424-unified-data-exchange).

### 8.11.1 Export

A single **"Export"** action starts a server-side **export job** ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Export job) that builds the full-account takeout archive on the VPS — `data.json` (the envelope) + `manifest.json` + every `status='ready'` attachment as plaintext under `attachments/<projektnummer>-<projekt-titel>/<attachment-id>-<dateiname>` — then offers it as an authenticated, resumable download. The browser triggers, polls, and downloads; it never assembles the archive.

**Workflow:**

1. **Resume probe (on mount).** The view probes `GET /api/export-jobs` (latest). A `running` job re-attaches to the progress view; a `ready` job surfaces the download action — so a page reload mid-build loses nothing.
2. **Start.** Clicking **"Export"** `POST`s `/api/export-jobs`. Below the configured mobile-warning breakpoint **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)) a non-blocking warning precedes the start: `"Für Desktop-Nutzung gedacht; Downloads können sehr groß sein."` — the user may proceed. If an export job is already active the call returns `409 EXPORT_JOB_ACTIVE` and the view re-attaches to it.
3. **Progress.** The dialog tracks the job by refetching the latest export job (`GET /api/export-jobs`) on each `data_exchange_job_changed` SSE frame ([api.md §14.2.13](../api.md#14213-realtime-events)), surfacing `status`, files-done / total, bytes-done / total, and the current item. (There is no per-id status poll — the client always re-reads the latest job; `:id` is used only for `/download`.) The build runs server-side; closing the dialog does not stop it (the job continues and the resume probe re-attaches). There is no client-side cancel in this version.
4. **Download.** When `status = 'ready'` the dialog shows a download action that GETs `/api/export-jobs/:id/download`; the response is Range-capable, so an interrupted download resumes natively. Suggested filename: `projekt-manager-export-<YYYY-MM-DD>T<HH-mm-ss>.zip`. A `ready` job is always complete — an unreadable row fails the build instead ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Export job build), so there is no partial-result affordance.
5. **Failure.** `status = 'failed'` renders the job's `error_detail`. The staged archive is reaped after the takeout staging TTL **[C]**; a download attempt afterwards returns `404`, and the dialog invites re-running the export.

**Surface placement.** The dialog hosts only the _active_ build — a `pending`/`running` job auto-opens it (including the live `ready → download` transition while the operator watches). Once terminal and the dialog is closed (or re-attached on a reload), the affordance moves **inline** into the Export section (download, or `error_detail`), never an auto-opened modal — so a finished export cannot cover the Import action below it.

Permission: `data:export`. Users without it do not see the action — a component-level gate (defense in depth on the nav-level gate in [index.md §8.7.1](index.md#871-views), [AC-150](../verification.md#1521-role-scoping)); the server remains authoritative ([AC-133](../verification.md#1514-data-exchange), [AC-322](../verification.md#1514-data-exchange)).

The archive's envelope includes archived (soft-deleted) business data with archive state preserved: `users` (incl. inactive accounts and `passwordHash`), the singleton `company_profile`, every `invoice` (issued, cancelled, Storno), and `invoice_sequence`. Sessions and `audit_log` are excluded — ephemeral / per-instance state. See [data-model.md §5.8](../data-model.md#58-export-envelope).

**The Papierkorb is not exported** ([AC-431](../verification.md#1526-attachments)). The preflight says so — `"Der Papierkorb wird nicht mit exportiert."` — because the operator's model of what a backup contains forms here, not at restore time.

### 8.11.2 Import

A single **"Import"** action restores a takeout archive via a server-side **import job** ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Import job). The browser uploads the archive to the VPS over a resumable chunked protocol; the server validates it, wipes-and-restores the business data in one transaction, and re-encrypts every attachment to B2. The browser never unzips, hashes, or re-uploads per attachment.

**Workflow:**

1. **File picker + destructive confirmation.** Clicking **"Import"** opens the OS file picker. A full-account restore overwrites the deployment, so the dialog renders a visually distinct confirmation input naming the configured confirmation phrase **[C]**; the start action stays disabled until the typed value matches. Alongside the generic destructive notice the gate carries a **second, explicit** one: the archive holds no `hidden` attachments, so the restore is also a Papierkorb purge ([AC-432](../verification.md#1526-attachments)) — `"Der Papierkorb ist nicht Teil des Archivs: gelöschte Anhänge, die dort noch wiederherstellbar sind, gehen dabei endgültig verloren."` "The existing data is deleted" does not tell an operator that the archive cannot bring the trash back; that gap is the whole point of the second line. Below the mobile-warning breakpoint **[C]** the dialog adds: `"Für Desktop-Nutzung gedacht; Importe können sehr groß sein."` Client-side matching is a UX affordance; the server re-validates the phrase ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Import job override + confirmation).
2. **Create + resumable upload.** On confirmation the client `POST`s `/api/import-jobs` (`Upload-Length` = archive size, `override: true`, the phrase), then uploads the archive in chunks (`PATCH …/archive` at byte offsets), surfacing upload bytes-done / total. A network drop resumes from the server's offset (`HEAD …/archive`) rather than restarting — the load-bearing reason the flow is resumable ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Import job resumable upload). `409 IMPORT_JOB_ACTIVE` re-attaches to an in-flight job.
3. **Server processing.** When the upload completes the job goes `running`; the dialog refetches the latest import job (`GET /api/import-jobs`, on the `data_exchange_job_changed` SSE) and surfaces files-done / total plus the current item (`current_item` — free text, not a structured phase field) as the server works through validate → restore → per-attachment re-encrypt. `:id` is used only for the `/archive` upload, never a status poll. A validation failure (schema mismatch, corrupt / tampered archive) terminates the job `failed` **before any write**; the dialog shows `error_detail` and the deployment is untouched.
4. **Session re-auth.** The restore wipes `users`, so the operator's session dies mid-job and the next poll returns `401`. The dialog routes to the login screen; after re-authentication (the operator's account round-trips through the archive with its original password) the view re-attaches to the job via `GET /api/import-jobs` (latest) and resumes the progress view to completion. No bearer token is involved — all byte work is server-side ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Import job session invalidation).
5. **Done / failure summary.** On `status = 'ready'` the dialog renders the restored per-entity counts; the operator closes it explicitly. On `failed`, the `error_detail` is shown. Per-attachment idempotency means a re-run of a job that failed mid-restore resumes rather than duplicates.

**Surface placement.** Unlike the export, a _terminal_ import auto-opens its dialog too: the summary must re-attach after the post-wipe re-auth (step 4), which lands the operator straight back on the Daten view. The operator's explicit close is remembered for the page session so the summary does not re-pop on a later Daten visit; a full reload re-attaches it.

**A picked file always starts a new import.** `GET /api/import-jobs` keeps returning the last finished job, so a prior _terminal_ job must never take over a dialog opened with a picked archive — it would render that old summary instead of the confirmation gate, making the restore usable exactly once per deployment. Re-attach (no picked file) still resumes onto a terminal job, per the paragraph above.

Permission: `data:restore`. Users without it do not see the action; the server remains authoritative ([AC-134](../verification.md#1514-data-exchange), [AC-329](../verification.md#1514-data-exchange)). The job re-encrypts attachments server-side under its own loaded identity, so `attachment:write` is not a UI prerequisite.

### 8.11.3 Speichernutzung

A row at the top of the view, above Export and Import, shown to `data:export` holders only. It shows two storage totals ([data-model.md §5.14](../data-model.md#514-storage-usage)), both always on screen, with no tooltip:

| Total      | Label           |
| ---------- | --------------- |
| Visible    | `Sichtbar`      |
| Papierkorb | `Im Papierkorb` |

Behavior: [verification.md §15.29](../verification.md#1529-storage-usage).

### 8.11.4 Company Profile

An owner-only form persisting the singleton `company_profile` row ([data-model.md §5.17](../data-model.md#517-company-profile-entity)) — the source from which every issued invoice's `issuer` block is snapshotted. The form is the only UI surface that mutates the row; the API contract is [api.md §14.2.15](../api.md#14215-company-profile-operations).

**Visibility.** The section is rendered to every authenticated role with read access; the editable surface (inputs enabled, save button visible) is owner-only. Office, worker, and bookkeeper see the section as a read-only summary — useful for verifying the values an invoice will snapshot, with no save affordance. The server is authoritative ([AC-301](../verification.md#1531-company-profile)).

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
