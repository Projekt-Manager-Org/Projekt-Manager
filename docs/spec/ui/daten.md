# UI: Daten View

Section 8.11 of the [product spec](../index.md) — the unified business-data exchange surface (export + import). See [ADR-0018](../../adr/0018-data-persistence-and-recovery-layered-strategy.md) for the layered persistence strategy and [api.md §14.2.4](../api.md#1424-unified-data-exchange) for the server contract.

---

## 8.11 Daten View

The view surfaces the full-account export and import jobs ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Export job / Import job). Visible only to users with `data:export`; the import section is visible only to users who additionally hold `data:restore`.

The text-row endpoints (`GET /api/export`, `POST /api/import`) are not surfaced as standalone UI actions — the export and import jobs reuse them server-side for the business-data leg. See [api.md §14.2.4](../api.md#1424-unified-data-exchange).

### 8.11.1 Export

A single **"Export"** action starts a server-side **export job** ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Export job) that builds the full-account takeout archive on the VPS — `data.json` (the envelope) + `manifest.json` + every `status='ready'` attachment as plaintext under `attachments/<projektnummer>-<projekt-titel>/<attachment-id>-<dateiname>` — then offers it as an authenticated, resumable download. The browser triggers, polls, and downloads; it never assembles the archive.

**Workflow:**

1. **Resume probe (on mount).** The view probes `GET /api/export-jobs` (latest). A `running` job re-attaches to the progress view; a `ready` job surfaces the download action — so a page reload mid-build loses nothing.
2. **Start.** Clicking **"Export"** `POST`s `/api/export-jobs`. Below the configured mobile-warning breakpoint **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)) a non-blocking warning precedes the start: `"Für Desktop-Nutzung gedacht; Downloads können sehr groß sein."` — the user may proceed. If an export job is already active the call returns `409 EXPORT_JOB_ACTIVE` and the view re-attaches to it.
3. **Progress.** The dialog tracks the job by refetching the latest export job (`GET /api/export-jobs`) on each `data_exchange_job_changed` SSE frame ([api.md §14.2.13](../api.md#14213-realtime-events)), surfacing `status`, files-done / total, bytes-done / total, and the current item. (There is no per-id status poll — the client always re-reads the latest job; `:id` is used only for `/download`.) The build runs server-side; closing the dialog does not stop it (the job continues and the resume probe re-attaches). There is no client-side cancel in this version.
4. **Download.** When `status = 'ready'` the dialog shows a download action that GETs `/api/export-jobs/:id/download`; the response is Range-capable, so an interrupted download resumes natively. Suggested filename: `projekt-manager-export-<YYYY-MM-DD>T<HH-mm-ss>.zip`. A skipped-attachment count (`"X Dateien übersprungen"`) is surfaced when the build skipped any unreadable row ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Export job build).
5. **Failure.** `status = 'failed'` renders the job's `error_detail`. The staged archive is reaped after the takeout staging TTL **[C]**; a download attempt afterwards returns `404`, and the dialog invites re-running the export.

**Surface placement.** The dialog hosts only the _active_ build — a `pending`/`running` job auto-opens it (including the live `ready → download` transition while the operator watches). Once terminal and the dialog is closed (or re-attached on a reload), the affordance moves **inline** into the Export section (download + skipped-count, or `error_detail`), never an auto-opened modal — so a finished export cannot cover the Import action below it.

Permission: `data:export`. Users without it do not see the action — a component-level gate (defense in depth on the nav-level gate in [index.md §8.7.1](index.md#871-views), [AC-150](../verification.md#1521-role-scoping)); the server remains authoritative ([AC-133](../verification.md#1514-data-exchange), [AC-322](../verification.md#1514-data-exchange)).

The archive's envelope includes archived (soft-deleted) business data with archive state preserved: `users` (incl. inactive accounts and `passwordHash`), the singleton `company_profile`, every `invoice` (issued, cancelled, Storno), and `invoice_sequence`. Sessions and `audit_log` are excluded — ephemeral / per-instance state. See [data-model.md §5.8](../data-model.md#58-export-envelope).

### 8.11.2 Import

A single **"Import"** action restores a takeout archive via a server-side **import job** ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Import job). The browser uploads the archive to the VPS over a resumable chunked protocol; the server validates it, wipes-and-restores the business data in one transaction, and re-encrypts every attachment to B2. The browser never unzips, hashes, or re-uploads per attachment.

**Workflow:**

1. **File picker + destructive confirmation.** Clicking **"Import"** opens the OS file picker. A full-account restore overwrites the deployment, so the dialog renders a visually distinct confirmation input naming the configured confirmation phrase **[C]**; the start action stays disabled until the typed value matches. Below the mobile-warning breakpoint **[C]** the dialog adds: `"Für Desktop-Nutzung gedacht; Importe können sehr groß sein."` Client-side matching is a UX affordance; the server re-validates the phrase ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Import job override + confirmation).
2. **Create + resumable upload.** On confirmation the client `POST`s `/api/import-jobs` (`Upload-Length` = archive size, `override: true`, the phrase), then uploads the archive in chunks (`PATCH …/archive` at byte offsets), surfacing upload bytes-done / total. A network drop resumes from the server's offset (`HEAD …/archive`) rather than restarting — the load-bearing reason the flow is resumable ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Import job resumable upload). `409 IMPORT_JOB_ACTIVE` re-attaches to an in-flight job.
3. **Server processing.** When the upload completes the job goes `running`; the dialog refetches the latest import job (`GET /api/import-jobs`, on the `data_exchange_job_changed` SSE) and surfaces files-done / total plus the current item (`current_item` — free text, not a structured phase field) as the server works through validate → restore → per-attachment re-encrypt. `:id` is used only for the `/archive` upload, never a status poll. A validation failure (schema mismatch, corrupt / tampered archive) terminates the job `failed` **before any write**; the dialog shows `error_detail` and the deployment is untouched.
4. **Session re-auth.** The restore wipes `users`, so the operator's session dies mid-job and the next poll returns `401`. The dialog routes to the login screen; after re-authentication (the operator's account round-trips through the archive with its original password) the view re-attaches to the job via `GET /api/import-jobs` (latest) and resumes the progress view to completion. No bearer token is involved — all byte work is server-side ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Import job session invalidation).
5. **Done / failure summary.** On `status = 'ready'` the dialog renders the restored per-entity counts and any skipped-attachment count; the operator closes it explicitly. On `failed`, the `error_detail` is shown. Per-attachment idempotency means a re-run of a job that failed mid-restore resumes rather than duplicates.

**Surface placement.** Unlike the export, a _terminal_ import auto-opens its dialog too: the summary must re-attach after the post-wipe re-auth (step 4), which lands the operator straight back on the Daten view. The operator's explicit close is remembered for the page session so the summary does not re-pop on a later Daten visit; a full reload re-attaches it.

Permission: `data:restore`. Users without it do not see the action; the server remains authoritative ([AC-134](../verification.md#1514-data-exchange), [AC-329](../verification.md#1514-data-exchange)). The job re-encrypts attachments server-side under its own loaded identity, so `attachment:write` is not a UI prerequisite.

### 8.11.3 Speichernutzung

A storage-usage row sits at the top of the DatenView, above the Export ([§8.11.1](#8111-export)) and Import ([§8.11.2](#8112-import)) sections. It surfaces the deployment-wide totals from `GET /api/storage-usage` ([api.md §14.2.12](../api.md#14212-storage-usage)) inline — mobile-first, always-visible, no hover affordance.

**Visibility.** Permission-gated by `data:export`, parity with the Export action gate ([§8.11.1](#8111-export)) and the server gate on the global storage endpoint ([api.md §14.2.12](../api.md#14212-storage-usage)). Worker and bookkeeper hold neither permission and do not see the row. The component-level gate is defense in depth on top of the nav-level gate ([index.md §8.7.1](index.md#871-views)); the server remains authoritative.

**Layout.** Inline two-bucket plaintext breakdown — both buckets are on the surface at all times (mobile-first posture rules out a hover tooltip; no hover on touch). German labels:

| Bucket             | Label           | Meaning                                                                                                                |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ready.plaintext`  | `Sichtbar`      | what the user sees in the gallery / binary list (their "what I uploaded" view)                                         |
| `hidden.plaintext` | `Im Papierkorb` | recoverable until the hidden reaper consumes it ([data-model.md §6.12](../data-model.md#612-attachment-hidden-reaper)) |

The ciphertext buckets the API also returns (`ready.ciphertext`, `hidden.ciphertext`, see [api.md §14.2.12](../api.md#14212-storage-usage)) are operator / billing concerns over the same rows and stay off the user-facing surface; surfacing them here would conflate the user's "what I uploaded" view with the ops-storage-cost view, and the latter has no consumer in v1.

Each value is rendered via the shared byte-formatting helper at the same precision as the Footer badge ([index.md §8.1.2](index.md#812-authenticated-state)).

**Refresh triggers (apply equally to the Footer badge in [index.md §8.1.2](index.md#812-authenticated-state) and the DatenView row).** Footer and DatenView share a single storage-usage subscription that owns the fetch lifecycle:

1. **Mount** — fetch on first render of the consuming surface.
2. **`visibilitychange → visible`** — refetch when the tab returns to foreground (the always-open observer's idle-tab gap closer for the single-user case).
3. **Post-mutation refresh hooks** — the orchestrators that move counter bytes invoke `refresh()` after their successful path: the upload-complete orchestrator ([project-detail.md §8.15](project-detail.md#815-project-detail-page) — covers `AttachmentService.completeUpload`), the Papierkorb hide and restore orchestrators ([project-detail.md §8.15](project-detail.md#815-project-detail-page) — covers `AttachmentService.hide` and `AttachmentService.restore`). The import **job** moves bytes server-side, so its storage delta reaches this surface via the `storage_usage_changed` SSE (trigger 4 below), not a client `refresh()`.
4. **`storage_usage_changed` SSE event** — the cross-session invalidation path ([api.md §14.2.13](../api.md#14213-realtime-events), [architecture.md §11.13](../architecture.md#1113-realtime-invalidation-channel)). Closes the always-open-observer gap that mount + `visibilitychange` + post-mutation alone leave open: when another session's worker uploads a photo from the field, the office observer's Footer badge and DatenView row both reflect the new total without manual refresh. This is THE multi-user value the SSE channel exists to deliver — verified by [AC-273](../verification.md#1529-storage-usage-ui).

The refetch always re-issues the global `GET /api/storage-usage`; the SSE event is an invalidation hint, not a data payload ([ADR-0025](../../adr/0025-realtime-ui-invalidation-via-sse.md)).

### 8.11.4 Company Profile

An owner-only form persisting the singleton `company_profile` row ([data-model.md §5.17](../data-model.md#517-company-profile-entity)) — the source from which every issued invoice's `issuer` block is snapshotted. The form is the only UI surface that mutates the row; the API contract is [api.md §14.2.15](../api.md#14215-company-profile-operations).

**Visibility.** The section is rendered to every authenticated role with read access; the editable surface (inputs enabled, save button visible) is owner-only. Office, worker, and bookkeeper see the section as a read-only summary — useful for verifying the values an invoice will snapshot, with no save affordance. The server is authoritative ([AC-301](../verification.md#1531-company-profile)).

**Fields.**

- `Firmenname` — required, non-empty.
- `Adresse` — three components `Straße`, `PLZ`, `Ort`; all three required, non-empty (no all-or-none toggle here; an address with one or two components is meaningless on an invoice).
- `Steuernummer` — required, non-empty.
- `USt-IdNr.` — required when `defaultTaxMode` is `standard` or `reverse_charge`; optional for `kleinunternehmer`. The form re-renders the requiredness asterisk when `defaultTaxMode` changes.
- `IBAN` — optional structurally; the renderer emits a payment block when present.
- `Logo` — optional image upload. Uses the existing binary descriptor pipeline ([data-model.md §5.13](../data-model.md#513-attachment), [ADR-0024](../../adr/0024-binary-attachment-e2e-encryption.md)); the form stores only the descriptor id. Accepts `image/png`, `image/jpeg`, `image/webp` per the existing MIME whitelist.
- `Akzentfarbe` — optional hex color; falls back to the brand accent ([architecture.md §12.5](../architecture.md#125-theming-model)).
- `Fußzeile` — optional free German text printed at the foot of every rendered invoice.
- `Standard-Steuermodus` (`defaultTaxMode`) — three-way dropdown (`Regulär`, `Kleinunternehmer §19`, `Reverse-Charge §13b`). Pre-fills new invoice drafts ([invoices.md §8.16.2](invoices.md#8162-draft-form)).

**Validation.** Required-field validation runs client-side as a UX affordance; the server re-validates and remains authoritative ([AC-303](../verification.md#1531-company-profile)). Submitting with a required field empty (e.g. `USt-IdNr.` under `defaultTaxMode ∈ {standard, reverse_charge}`) surfaces an inline German validation message next to the offending field and does NOT dispatch the PUT — the save handler short-circuits client-side. The save button is disabled only while an in-flight save is pending ([behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)); keeping it clickable on incomplete forms is intentional so the user gets explicit field-level feedback instead of a silently unresponsive button.

**Save.** A single `Speichern` action dispatches `PUT /api/company-profile`. On success the form re-renders with the persisted values; the audit log records the mutation per [AC-302](../verification.md#1531-company-profile). On rejection (e.g. `422 VALIDATION_ERROR` from a required-when-mode violation) the German error message names the offending fields and the form retains the user's typed values.

**No deletion.** The row is a singleton ([AC-300](../verification.md#1531-company-profile)) — no delete affordance exists.
