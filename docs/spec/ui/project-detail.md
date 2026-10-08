# UI: Project Detail Page

Section 8.15 of the [product spec](../index.md) — the dedicated, shareable detail surface for a single project at `/projects/:id`. The existing Project Detail Panel ([workflow-views.md §8.4](workflow-views.md#84-project-detail-panel)) stays as the quick-glance overlay on Kanban and Calendar; the page is the canonical full-context view.

Shell and navigation live in [index.md](index.md); cross-cutting behavioral rules (in-flight lock, error handling, mutation semantics) in [behavior.md](behavior.md).

---

## 8.15 Project Detail Page

A full-page view of a single project. Reachable by URL (`/projects/:id`) and from the `Öffnen` affordance on the quick-glance detail panel. Route access follows the role matrix — workers land on the not-permitted surface ([AC-149](../verification.md#1521-role-scoping)) when the project is out of their scope.

### 8.15.1 Layout

```
┌──────────────────────────────────────────────────────────┐
│ Header — number, title, status badge, forward/backward   │
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

The core-field region reuses the read contents of [workflow-views.md §8.4](workflow-views.md#84-project-detail-panel) — project number and title, status badge, forward/backward transition buttons, customer (name, phone, email), `Baustelle:` line (see below), planned start/end date pickers, estimated value, notes, audit timestamps. Editability parity matches the management edit view ([management.md §8.8.3](management.md#883-edit-project)) — notes, customer, site address, estimated value, dates, and assigned workers are editable with `project:update`. Title edits also go through `project:update`. Status is mutated only through the transition operations; project number is immutable.

**`Baustelle:` rendering.** The detail surface shows a single `Baustelle:` line carrying the work site address. When `project.siteAddress` is non-null, render `street, zip city` from that object. When `project.siteAddress` is null, fall back to the customer's `address` ([data-model.md §5.6](../data-model.md#56-customer-entity)) and append a subtle inline hint `"(Kundenadresse)"` so the reader knows the displayed value is the billing address standing in for the site (see [data-model.md §5.1](../data-model.md#51-project-entity) for the fallback rule). The map-link affordance is rendered on whichever address is shown — there is exactly one map link per detail surface and it points at the address actually displayed. When both `project.siteAddress` and `customer.address` are absent, the line renders the German placeholder `"Keine Adresse"` and no map link. The same rendering rule applies to the quick-glance Project Detail Panel ([workflow-views.md §8.4](workflow-views.md#84-project-detail-panel)).

**`Baustelle:` editing.** Unlike the page's other core fields (notes, dates, estimated value, customer, title, assigned workers) which commit save-on-blur, the `Baustelle` group commits via an explicit `Speichern` button. The toggle + structured triple + all-or-none requiredness ([management.md §8.9.2](management.md#892-create-customer)) do not fit per-field blur semantics — a blur on `street` while `zip` is still empty would either dispatch a partial body or silently swallow the edit, neither acceptable. The save button is disabled while a mutation is in flight to prevent duplicate dispatches.

### 8.15.3 Assigned-Worker Editor

Worker-assignment editor visible on the page (not routed to a dedicated view). Backed by the existing Update project API operation ([api.md §14.2.2](../api.md#1422-projects)) with a patch carrying `assignedWorkerIds`.

- Multi-select from the active set of users holding the `worker` role. Each selected entry renders as a chip carrying the worker's `displayName`; a remove affordance detaches.
- Mutations require `project:update`. The control is hidden for callers without it; the page-level read surface continues to render the current assigned list.
- Changes are audited per [AC-177](../verification.md#1523-audit-log) — the `mutate()` helper writes a `project_worker` audit row (`action` ∈ `create` / `delete`; `entityLabel` = worker displayName per [data-model.md §5.10](../data-model.md#510-audit-log-entity)).
- In-flight mutation lock per [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior): while the patch is resolving, the chip set and the add control are disabled; a failed mutation reverts the optimistic UI ([AC-53](../verification.md#153-behavioral)).

### 8.15.4 Photo Gallery

Displays every `status = 'ready'` attachment with `kind = 'photo'` for the project. Thumbnails render via the synthetic same-origin URL `/encrypted-storage/<projectId>/<attachmentId>.thumbnail` (`<img src="...">`); the Service Worker intercepts the request, calls the download-URL endpoint to obtain the presigned-GET URL plus the unwrapped per-blob DEK, fetches the ciphertext from object storage, AES-GCM-decrypts, and returns the plaintext bytes through the Fetch response — see [AC-222](../verification.md#1526-attachments) and [AC-243](../verification.md#1526-attachments). Clicking a thumbnail opens a lightbox that points at the same synthetic origin with `<attachmentId>.original`; the original ciphertext is fetched and decrypted on demand. The synthetic origin is browser-internal — no TTL is surfaced in the UI; the configured attachment presigned-URL TTL **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)) governs the underlying B2 fetch the SW makes.

- **Upload surface.** Shown for callers with `attachment:write`. An upload affordance supporting drop and explicit browse; on camera-capable devices the affordance additionally invokes camera capture. German CTA copy lives in the attachment upload CTA labels `[C]` catalogue entry ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)).
- **Client image pipeline.** Before calling init, the browser re-encodes the original (preserving EXIF including GPS) and produces a thumbnail variant, applying the sizing and quality parameters in the `[C]` catalogue entry for attachment client-encoding ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)). The browser then computes the MD5 of each blob and passes the size + MD5 of both to init; the server signs one presigned PUT per blob with `Content-Type` + `Content-Length` + `Content-MD5` bound by SigV4. The browser PUTs each blob directly to object storage ([api.md §14.2.11](../api.md#14211-attachments)); the app server never sees the bytes. Preserving EXIF (including GPS) matches [kickoff.md](../../project/kickoff.md)'s worker-view expectation that GPS coordinates stay available to the worker; EXIF preservation as a whole is a design choice of this spec. The concrete transcoding steps and the libraries used live in `ARCHITECTURE.md § Attachments Module`.
- **Size cap.** If the re-encoded original exceeds the configured attachment per-file size cap **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)), the client surfaces a German validation message (`"Datei zu groß"`) and does not call init. The cap is also enforced server-side at init validation, then pinned via the presigned PUT's signed `Content-Length`; a mismatch between the two is a client-side bug, not a security gap.
- **Per-photo controls.** Each thumbnail carries a label dropdown (closed enum — `Foto` by default on photo uploads, selectable from the full enum) and a delete affordance. Delete follows the permission matrix in §8.15.6.
- **No offline binary processing.** The service worker does not queue, compress, or resume uploads in the background. A page reload cancels an in-flight upload cleanly; the server-side reaper ([data-model.md §6.11](../data-model.md#611-attachment-orphan-reaper)) removes the orphan `pending` row.

### 8.15.5 Binary List

Displays every `status = 'ready'` attachment with `kind = 'binary'` (PDF, DOCX) for the project. Renders as a tabular list: filename, label, uploader, upload timestamp, download action.

- **Upload surface.** Shown for callers with `attachment:write`. A file picker accepts the binary MIME types from the whitelist ([data-model.md §5.13](../data-model.md#513-attachment)); a file outside the whitelist is rejected client-side with a German validation message (`"Dateityp nicht erlaubt"`).
- **No thumbnail pipeline.** `hasThumbnail = false` at init for binary uploads; the server issues a single presigned-PUT descriptor for the original.
- **Per-file controls.** Label dropdown (closed enum, default `Sonstiges`) and a delete affordance. A `Herunterladen` action issues a fetch against the synthetic same-origin URL `/encrypted-storage/<projectId>/<attachmentId>.original`; the Service Worker decrypts the ciphertext as in §8.15.4 and returns the plaintext bytes through the Fetch response. The browser saves the file using the row's `fileName` carried in the SW-set `Content-Disposition`. Bytes never round-trip the application server.
- **Bulk download.** A `Auswahl als ZIP` action appears when the user selects at least one file. Selection exceeding the configured bulk-fetch caps **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)) — maximum file count OR summed plaintext `sizeBytes` — is blocked client-side with a German validation message naming both caps before any request is issued. On submit the action calls `POST /api/projects/:id/attachments/bulk-fetch` ([api.md §14.2.11](../api.md#14211-attachments), [AC-216](../verification.md#1526-attachments)) and receives, per requested attachment, `{ attachmentId, originalUrl, originalDekMaterial, ciphertextSizeBytes, thumbUrl?, thumbDekMaterial?, ciphertextThumbSizeBytes? }`. The browser fetches each ciphertext, AES-GCM-decrypts with the per-file DEK, assembles a streaming zip locally, and triggers a single download of the assembled archive ([AC-223](../verification.md#1526-attachments)). The server re-validates the caps; the mismatch path surfaces the same German message via the mutation error banner ([index.md §8.1.2](index.md#812-authenticated-state)).

### 8.15.6 Soft-Hide

The delete affordance is a soft-hide: the row flips to `status = 'hidden'` and the file moves to the project's Papierkorb (§8.15.10). The Papierkorb is bounded — once a hidden row's age past `hiddenAt` exceeds the configured hide-to-delete window `L` **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)), the row is hard-deleted by the hidden reaper ([data-model.md §6.12](../data-model.md#612-attachment-hidden-reaper)) and the underlying noncurrent versions are reaped by the bucket lifecycle on the same window — both keyed off `L` so the row never outlives recoverability.

- Owner, office: any attachment on the project.
- Worker: own attachments only, within the configured self-delete grace window **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)). Outside that window the delete control is hidden; the server rejects with `403 NOT_PERMITTED` as the authoritative gate ([api.md §14.2.11](../api.md#14211-attachments)).
- Bookkeeper: no delete.

Every soft-hide carries a Yes / No confirmation dialog with a German warning that names the Papierkorb destination, the bounded Aufbewahrungsfrist during which restore (§8.15.10) is possible, and the irreversible final destruction once that window elapses. Hide is forbidden on archived projects; restore remains permitted on archived projects so binaries are recoverable before lifecycle reap (§8.15.10).

### 8.15.7 Restored Rows Without Backing Bytes

Two divergence states render an otherwise-valid `status = 'ready'` row in a degraded placeholder. Both placeholders disable the download action, exclude the row from `bulk-fetch` selection ([AC-216](../verification.md#1526-attachments)), exclude the row from the photo gallery's lightbox, and leave the row untouched in the database — the mismatch is an operational signal, not a schema error. The two states are distinct because the operator remediation differs: object-absent is a storage divergence, envelope-unwrap is a key-state divergence.

**Object absent at storage — `"Datei fehlt"`.** A row whose backing object is absent in storage (possible after a Layer 1 restore whose Layer 3 storage has diverged — see [data-model.md §5.8](../data-model.md#58-export-envelope)) renders with a neutral German label `"Datei fehlt"` and a muted thumbnail placeholder ([AC-224](../verification.md#1526-attachments)).

**Wrapped envelope cannot be unwrapped — `"Schlüssel nicht verfügbar"`.** A row whose `wrappedDek` (or `wrappedThumbDek` for the photo's thumbnail variant) cannot be unwrapped at render time — envelope bytes corrupt, recipient mismatch against the currently-loaded binary identity (e.g. partial key rotation in progress), or the unwrap operation otherwise fails — renders with a neutral German label `"Schlüssel nicht verfügbar"` and a muted placeholder ([AC-244](../verification.md#1526-attachments)). The symptom looks similar to "Datei fehlt" but the bytes on storage are intact; the operator's remediation is to restore the matching binary `age` identity into the VPS tmpfs, not to investigate storage state.

**Detection is lazy.** The server does not probe object storage and does not pre-validate envelope unwrap when answering the list endpoint ([api.md §14.2.11](../api.md#14211-attachments)). The UI learns of either failure mode only when a fetch against the synthetic origin (§8.15.4, §8.15.5) is in flight: the SW issues the `download-url` call (which fails with the unwrap error if the envelope cannot be opened against the loaded identity) and then fetches the presigned URL (which surfaces the storage 404 / NoSuchKey if the object is absent). For photos, the trigger is the thumbnail render at gallery mount; for binaries, the trigger is the user's download click. The row flips to the matching placeholder on the first failure and a subsequent manual attempt repeats the fetch and re-observes the same state — no client-side caching of either verdict.

**Failure-mode signal contract.** The SW signals which divergence it observed by writing `data-sw-error-code` on the failing Response (header) and on the requesting `<img>` / `<iframe>` element (DOM attribute) before rejecting the fetch. The two pinned values are `OBJECT_ABSENT` (storage 404 / NoSuchKey on the presigned-GET fetch) and `DEK_UNWRAP_FAILED` (`download-url` returned the documented per-row unwrap-failure status). The UI's `onError` handler reads the attribute to choose between `"Datei fehlt"` and `"Schlüssel nicht verfügbar"`. The attribute name and the two values are the stable contract; the SW must not invent additional codes without a spec update.

### 8.15.8 Upload Failure and Retry

Per-upload states rendered in the gallery and list next to the affected row:

- **Progress.** A percentage or indeterminate indicator while the POST is in flight.
- **Failure banner.** On any failure (network error, storage 4xx/5xx, complete returning a conflict) the row renders a red banner with the German message from the API error category ([behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)) plus a `Erneut versuchen` action that restarts the flow from init. The row is removed from the UI when the user dismisses the banner; the server's reaper removes the orphan `pending` row on its next sweep.
- **No silent retry.** The UI does not retry uploads on its own — silent retry would hide an intermittent failure class from the user. Retry is always a deliberate user action.

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

The role → capability mapping (which role holds `attachment:read`, `attachment:write`, `attachment:hide`, `attachment:trash`) is defined by the permission matrix in [api.md §14.3](../api.md#143-authorization-rules) — that is the SSOT. Server-side authorization is authoritative ([api.md §14.2.11](../api.md#14211-attachments)); client-side hiding is a UX convenience per [AC-121](../verification.md#1516-management-views).

### 8.15.10 Papierkorb Tab

Per-project trash surface listing rows soft-hidden via §8.15.6. Bounded by the configured hide-to-delete window `L` **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)) — once a hidden row's age past `hiddenAt` exceeds `L`, the row is hard-deleted by the hidden reaper ([data-model.md §6.12](../data-model.md#612-attachment-hidden-reaper)) and the underlying noncurrent versions are reaped by the bucket lifecycle on the same window. After `L`, the row no longer appears in the Papierkorb listing — the listing therefore reflects only restorable items.

- **Visibility.** Tab is shown only to callers with `attachment:trash` (owner / office under the default matrix). The tab badge carries the trash row count. Server-side authorization remains authoritative: a forbidden caller hitting the API directly receives `403 NOT_PERMITTED` ([AC-235](../verification.md#1526-attachments)).
- **Render states.** `loading` while the initial fetch is in flight, `forbidden` (`403`) for defense-in-depth on direct API calls that bypass tab visibility, `error` with a German message and an `Erneut versuchen` action ([behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)), `ready` rendering the list (possibly empty).
- **Empty surface.** A `ready` list with zero rows renders an explicit German label `"Keine gelöschten Dateien"` — distinct from the `loading` placeholder so the user never confuses fetch-in-flight with an empty Papierkorb.
- **Row content.** Filename, label, hidden-since timestamp rendered as a German `Intl.RelativeTimeFormat` string (e.g. `"vor 1 Stunde"`), and a restore action.
- **Restore interaction.** One-click. No confirmation dialog — restore is reversible (a subsequent soft-hide returns the row to the Papierkorb). Server contract pinned by [AC-233](../verification.md#1526-attachments).
- **Archived projects.** Restore is permitted on archived projects — binaries must be recoverable before lifecycle reap consumes the hidden version. Hide remains forbidden on archived projects (read-only previews refuse new mutations); see §8.15.6.
- **Server contract.** List shape, ordering (`hiddenAt DESC`, `id` tiebreaker), and scoping pinned by [AC-235](../verification.md#1526-attachments).

### 8.15.11 Invoice

Per-project invoice block. Surfaces every invoice tied to the project as a list with row-level actions and exposes the entry point to the invoice draft form ([invoices.md §8.16.2](invoices.md#8162-draft-form)). The standalone cross-project list view lives at [invoices.md §8.16](invoices.md#816-invoices-view) — same data, different surface.

- **List.** Paginated-shape but unfiltered table over `GET /api/invoices?projectId=...` ([api.md §14.2.14](../api.md#14214-invoice-operations)). Each row carries `number` (`RE-YYYY-NNNN` / `ST-YYYY-NNNN`, or `—` for drafts), German `status` label per the [invoices.md §8.16.1](invoices.md#8161-list-view) mapping, `issueDate` (DD.MM.YYYY; `—` for drafts), the snapshotted recipient name, and `totals.grossGrandTotal` (EUR, German locale). Default sort matches the standalone view (`issueDate DESC, createdAt DESC, id`).
- **Storno grouping.** A Storno sibling row (`cancellationOf` non-null) renders visually subordinated under its `cancellationOf` original — indented + muted accent + a `"Storno zu RE-YYYY-NNNN"` hint line. The grouping is rendered client-side from the `cancellationOf` reference; the underlying rows are independent in the database.
- **Row actions.**
  - **Draft row** (`status = 'draft'`, `invoice:write`): `Bearbeiten` re-opens the draft form pre-filled with the row; `Ausstellen` issues via `POST /api/invoices/:id/issue` after a confirmation dialog; `Verwerfen` hard-deletes via `DELETE /api/invoices/:id` after a confirmation dialog. The form (§8.16.2 in [invoices.md](invoices.md)) carries only `Speichern` + `Abbrechen` — `Ausstellen` and `Verwerfen` live exclusively on the row.
  - **Issued row** (`status = 'issued'`, `cancellationOf` null): `PDF herunterladen` calls `GET /api/invoices/:id/pdf`; `Stornieren` (`invoice:write` only) opens the cancel dialog (below).
  - **Cancelled original / Storno sibling**: PDF download only. The cancellation atom on the issued row is one-shot — a second Storno on either the cancelled original or the Storno sibling is not offered.
- **`COMPANY_PROFILE_REQUIRED` handling.** When `Ausstellen` returns `422 COMPANY_PROFILE_REQUIRED` (missing required fields on the `company_profile` singleton for the chosen `taxMode`), the block renders a dedicated German banner above the list. The banner names the missing field labels (translated from `details.missingFields` paths — e.g. `address.zip` → `PLZ`, `ustId` → `USt-IdNr.`) and offers a direct link to `/daten` ([daten.md §8.11.4](daten.md#8114-company-profile)) so the owner can complete the profile inline. The draft row stays untouched; the user fixes the profile and retries the row's `Ausstellen` action.
- **`Neue Rechnung` CTA.** Visible to `invoice:write` holders only, and only when the project's `status = 'rechnung_faellig'`. Opens the draft form inline as a modal panel; the new draft inherits the project's customer (server-side recipient pre-fill at create), the project's `plannedEnd` as the performance date, and the company profile's `defaultTaxMode`. Outside `rechnung_faellig`, the CTA is hidden; the list remains visible with whatever invoices the project already carries. An empty list renders the German placeholder `"Noch keine Rechnungen"`.
- **Cancel dialog.** Bespoke dialog (not the shared `ConfirmDialog` because the call requires a free-text `Grund` input). German warning copy per [invoices.md §8.16.3](invoices.md#8163-issued-invoice-viewer) (both rows remain, project status NOT auto-reverted). Reason is required client-side; the server validates again and remains authoritative. On confirm dispatches `POST /api/invoices/:id/cancel` with the reason; on success the original row's badge flips to `Storniert` and the Storno sibling appears in the list.
- **Project-status flip.** The issue path flips `project.status` to `abgerechnet` server-side (AC-287); the block refetches the project so the page header / Kanban column reflect the new state without a manual reload. The cancel path deliberately does NOT auto-revert (AC-290 trailing clause) — a user staring at an `abgerechnet` project with a cancelled invoice sees the gap and acts on it manually.
- **Cross-link to the full invoice view.** A `Alle Rechnungen anzeigen` affordance below the list navigates to `/rechnungen?projectId=<thisProjectId>` ([invoices.md §8.16.1](invoices.md#8161-list-view)). The standalone view reads the query on mount and pre-sets the projectId filter; the active filter renders as a removable chip on the toolbar so the user sees why the list is constrained (clearing strips the query param and refetches the unfiltered set).
- **Worker exclusion.** Workers do not hold `invoice:read` and never see the section. The page renders without it for worker callers.
- **Realtime refresh.** Subscribes to the `invoice_changed` SSE event ([api.md §14.2.13](../api.md#14213-realtime-events)) so a fresh issuance / cancellation from another session updates the block without a manual refresh.

---

_Cross-references: [index.md](../index.md) for scope and assumptions, [data-model.md](../data-model.md) for the Attachment entity, [api.md](../api.md) for the presigned-PUT upload flow, [workflow-views.md §8.4](workflow-views.md#84-project-detail-panel) for the quick-glance overlay, [verification.md](../verification.md) for acceptance criteria._
