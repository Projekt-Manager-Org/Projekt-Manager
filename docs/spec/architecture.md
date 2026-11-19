# Architecture, Configuration, NFRs and Security

> **This document is the architectural contract** — what must hold for any code in this repository to be considered correct. For the **navigation guide** (tech stack overview, module map with file paths, request lifecycle, "how to extend" recipes), see [ARCHITECTURE.md](../../ARCHITECTURE.md) at the repo root. The two documents serve different readers: this one is for spec audits, the root one is for finding your way around the code.

---

## 11. Architectural Constraints

### 11.1 Mandatory Constraints

- Type-safe language for both client and server code.
- Testing: unit + component + API integration + at least one E2E smoke test.
- All data mutations go through the API. The front end never accesses the database directly.
- Decisions that need context and rationale are recorded in [ADRs](../adr/index.md). [ARCHITECTURE.md](../../ARCHITECTURE.md) is the high-level entry point to the implementation: an overview that links to detail rather than holding it.

### 11.2 Responsibility Boundaries

The system is organized into eight responsibility layers. The split between **Routes**, **Services**, and **Storage** on the server side is load-bearing — routes never reach into the database directly; they delegate to services, which orchestrate repositories and route every domain-entity mutation through the single-write-path helper (see [§11.3](#113-state-layer-behavioral-contract)).

| Layer                         | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config**                    | State definitions, thresholds, colors, company assumptions, role definitions, German strings, validated env. Imported by other layers, imports nothing application-internal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Domain**                    | Pure functions: transition rules, aging calculation, date/session validation, summary computation, types. Never imports from state, API, routes, services, storage, or UI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Storage**                   | Encapsulates all database and object storage operations. Repository modules expose typed query/mutation functions; the object storage client wraps the underlying object-storage SDK. Imported primarily by the Services layer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Services**                  | Server-side business logic. Sits between routes and storage: input validation beyond schema, domain-rule enforcement, multi-step orchestration, single-write-path mutation via the helper that commits domain-state change and `audit_log` row atomically (see [§11.3](#113-state-layer-behavioral-contract)). Imports from domain, storage, config. Never imports from routes or middleware.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Routes**                    | Thin HTTP adapters: request schema validation, cookie handling, authentication and authorization pre-handlers, response formatting. Delegates all business logic to services. Imports from services, middleware, errors, config. Never imports repositories directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **State**                     | Client-side: fetches from and dispatches mutations to the API. Exposes queries for the UI. No direct storage access; no server-side imports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **UI**                        | Presentation only. May import from domain for types. Dispatches actions to the state layer. Never calls the API client directly — only via state. Shared hooks are part of this layer; they wrap store and router primitives so components stay thin. Hooks follow the same import rules as UI components.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Attachment Service Worker** | Client-side, browser-resident worker registered by the SPA. Intercepts requests to a synthetic same-origin URL scheme (`/encrypted-storage/<projectId>/<attachmentId>.<variant>` per [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)), fetches ciphertext from object storage via the presigned GET, fetches the unwrapped DEK from the app's per-attachment DEK surface, decrypts in WebCrypto, and returns plaintext through the Fetch response so UI consumers (`<img src=...>`, `<iframe src=...>`, `<a href=... download>`) keep working unchanged. Same-origin code only — the worker never holds the operator identity (which lives only on the VPS tmpfs) and never communicates with object storage outside the presigned URLs handed to it for the in-flight request. Imports from domain for types only; never imports state, services, storage, or routes. |

**Dependency direction** (no reverse imports):

```
config  ←  domain  ←  storage  ←  services  ←  routes
                   ←  state    ←  ui
                   ←  attachment service worker
```

The domain layer is shared: both the server (services, routes) and the client (state, UI) import domain types and pure functions. This ensures that type definitions, transition rules, and aging calculations exist in a single place.

**Enforcement:** the layering rules above are the contract. They are enforced by review plus automated linter import restriction zones — a PR that imports storage modules from UI code or repository modules from route code fails lint.

**Attachment-bytes boundary.** The app process never reads, decrypts, or proxies attachment ciphertext bytes — only metadata, wrapped DEK envelopes, and the unwrapped DEK during the per-request `download-url` and `bulk-fetch` surfaces ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)) cross the app process. Ciphertext travels exclusively between the browser (via the Attachment Service Worker, see [§11.2](#112-responsibility-boundaries)) and the object-storage provider through presigned URLs. The "no attachment payloads on route handlers" structural-tree invariant is the upload-direction face of the same rule; the download direction is held by the Service Worker contract above and the absence of a server-side decrypt-and-stream-zip path.

### 11.3 State Layer Behavioral Contract

The state layer is a client-side cache delegating to the API.

**State:** the state layer manages the following data domains:

- **Projects** — the full project list (fetched from API), grouped by workflow state for Kanban rendering.
- **Customers** — the full customer list, used in project forms and the customer management view.
- **Users** — the user list (for admin views and worker assignment dropdowns). Only fetched when needed and when the user has `user:read` permission.
- **Auth** — the authenticated user profile (including theme preference) and session state.
- **View state** — active view, active filter (no planned dates, [AC-465](verification.md#151-workflow-board)), selected entity ID for detail views.
- **Mutation tracking** — in-flight flags and error messages per mutation. Confirm-dialog state for transition confirmations.
- **Import state** — the import job: upload progress, restore status, result summary (see [verification.md §15.14](verification.md#1514-data-exchange)).

**Mutations** (per [§11.1](#111-mandatory-constraints)):

- Transition a project forward or backward by one state
- Update a project's planned start/end dates
- Create, update, or soft-delete a project
- Create or update a customer
- Create, update, deactivate, or reactivate a user (admin)
- Reset a user's password (admin); change own password
- Update own preferences (theme preference)
- Export business data / restore from an export archive (see [verification.md §15.14](verification.md#1514-data-exchange))
- Login / logout
- Fetch or refresh project list, customer list, user list
- Set or clear a filter (local only — no API call)
- Switch between views (local only — clears active filter)

**Queries** (derived from locally cached data):

- Projects grouped by workflow state
- Projects filtered by search, status, customer, date range, or composite criteria
- Customers filtered by search
- Summary: count of aged buffer items per state with threshold, count of projects without planned dates
- Current authenticated user and permissions

**Server-side mutation path.** Every domain-entity mutation routes through a single service-layer helper that commits the state change and an `audit_log` row in one database transaction ([data-model.md §5.10](data-model.md#510-audit-log-entity), [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md)). Subscribers — the notification publisher and any future projection — dispatch from the committed audit stream after the transaction commits, so subscriber failure cannot roll back domain state. The property this protects is [AC-623](verification.md#1523-audit-log); how bypass is prevented: [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md#decision).

**Schema-level audit exclusion.** A column may be marked **audit-excluded**: the marker is a property of the column declared at the schema layer (the same place the column itself is defined), not a service-layer convention applied per call site. The audit-payload builder consults this marker when projecting `before` / `after` snapshots into the `audit_log` `payload` and omits any column carrying it. The exact mechanism — column allowlist/denylist consulted by the builder, a column-attribute on the schema definition, a metadata table, etc. — is implementation-defined; what the contract pins is the **property** (a column flagged at the schema layer is unconditionally absent from every audit `payload`) and the **enforcement shape** (a test pinned by an AC asserts the marked column never appears in any audit JSON across the full mutation surface). The wrapped-DEK envelope columns on the attachment row use this mechanism — see [data-model.md §5.13](data-model.md#513-attachment) "Audit exclusion" and [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md). The schema-layer location is load-bearing: a future column rename or a new audited mutation cannot leak the envelopes by forgetting to add a per-call-site filter.

### 11.5 Extensibility Checklist

Structural requirements for the system's documented extension paths. Each row states a contract the codebase must uphold and the failure mode that would close the door.

| Door                                             | Contract                                                                                                                                                                                                                                                                                                                                                                                        | Closed if...                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Adding/removing workflow states                  | States driven by a configuration array, not hardcoded logic                                                                                                                                                                                                                                                                                                                                     | Column count or state names are hardcoded in components                                                               |
| Adding new views (worker, bookkeeper, dashboard) | Views consume the shared state layer independently                                                                                                                                                                                                                                                                                                                                              | Kanban and Calendar are coupled to each other                                                                         |
| Adding fields to Project                         | Interface with optional fields; UI tolerates missing data                                                                                                                                                                                                                                                                                                                                       | Components crash on undefined fields                                                                                  |
| Adding file uploads / attachments                | Object storage module exists at the infrastructure layer ([ARCHITECTURE.md § Attachments Module](../../ARCHITECTURE.md#attachments-module)); Project model accepts optional attachments                                                                                                                                                                                                         | Data layer assumes all project data fits in a single flat object                                                      |
| Adding authentication / roles                    | Authentication and a role-based permission matrix sit behind the API; identity never baked into components                                                                                                                                                                                                                                                                                      | User identity baked into component logic                                                                              |
| Adding notifications                             | Post-commit subscribers attach via the single-write-path helper (§11.3); non-mutation events (`backup.failed`, `disk.threshold_reached`) publish to the same bus bypassing audit; rule-matching is data-driven over a closed, code-defined catalog ([verification.md §15.24](verification.md#1524-notifications), [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md)) | Transitions handled inline in UI event handlers; event classes embedded in handler logic instead of a central catalog |
| Adding a second authentication method            | Auth logic is behind the API; session model is method-agnostic                                                                                                                                                                                                                                                                                                                                  | Auth checks are tied to a specific mechanism (e.g., password hashing logic in route handlers)                         |
| Multi-language                                   | All user-facing strings are centralized in configuration; no inline literals in components                                                                                                                                                                                                                                                                                                      | Inline literals in components; string configuration bypassed                                                          |
| Adding management views for new entities         | Management views follow a uniform pattern (searchable table + CRUD forms) and consume the shared state layer                                                                                                                                                                                                                                                                                    | Entity-specific CRUD logic is wired directly into view components instead of through the state layer and API          |

### 11.6 Deployment Topology

The deployed system consists of four components:

| Component          | Role                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reverse proxy**  | TLS termination, HTTP → HTTPS redirect or non-binding, request forwarding to the application. Production uses automated certificate management — see [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md) and AC-45. The evaluation (HTTP-only) mode substitutes an HTTP-only configuration per [ADR-0013](../adr/0013-http-only-evaluation-mode.md). |
| **Application**    | Serves the front end and exposes the API. Frontend and backend may be a single deployable unit or separate services — this is an ADR decision. The app container listens only on the reverse-proxy-visible network, never on the public interface directly.                                                                                                                             |
| **Database**       | Persistent storage for projects, users, and sessions.                                                                                                                                                                                                                                                                                                                                   |
| **Object storage** | Binary/file storage.                                                                                                                                                                                                                                                                                                                                                                    |

These components may run on the same provider or on separate providers. The spec does not prescribe hosting vendors, managed services, or container strategies — those are ADR decisions. Network topology is further constrained by [ADR-0008](../adr/0008-vpn-first-network-access.md) (VPN-first access) and by the AC-45 HTTPS-or-nothing rule.

The reverse proxy carries an explicit `flush_interval -1` directive on the `/api/events` upstream so the SSE channel is never buffered ([ADR-0025](../adr/0025-realtime-ui-invalidation-via-sse.md)).

Any deployed environment must exercise all four components end-to-end. A topology that omits any of them — e.g. an application-only deploy without the reverse proxy or object storage — does not satisfy the deployment contract.

### 11.7 Continuous Delivery Pipeline

- **CI gate**: runs on every PR and merge-queue run of protected branches, and on a push only when no gated run has published that commit's image set. Pipeline: dependency audit, lint, format check, type check, env-drift check, unit + component + API-integration tests against real database and real object storage, and build. The image is built, scanned and pushed to the container registry in the merge queue, against the exact commit that lands; landing promotes (re-tags) that image rather than rebuilding, falling back to a rebuild only if that commit's image is missing. See [ADR-0011](../adr/0011-build-images-in-ci-distribute-via-ghcr.md). E2E tests are **not** part of this gate.
- **Nightly E2E**: the E2E test framework runs on a nightly schedule against the protected branch, and on manual trigger, with the same database + object storage + seed shape as the CI gate. It is deliberately outside the merge gate — a serial suite of that size taxes every PR and blocks merges on flake unrelated to the change — so the schedule is what bounds how long a regression can hide. A failed run raises a tracked issue and retains its report + traces as an artifact; a scheduled suite whose failures are neither notified nor debuggable decays as silently as no suite at all. AC-37 in [verification.md §15.7](verification.md#157-engineering) documents the topology from the acceptance-criteria side.
- **Deploy:** manual, pull-based. The operator promotes a CI-built image to the hosted environment over VPN. See [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md).
- A failed deployment must not take down the currently running system. The deploy script polls the health endpoint after container swap.
- **Registry retention:** a scheduled sweep bounds how long a built image stays pullable, so the rollback range is finite by design. It must never reap the protected-branch pointer, the rollback window behind it, or the head of an open PR. See [ADR-0011 § Retention](../adr/0011-build-images-in-ci-distribute-via-ghcr.md).
- Environment separation and rollback mechanisms are documented in [docs/ops/manual-deploy.md](../../docs/ops/manual-deploy.md).

---

## 12. Configuration Boundaries

### 12.1 Universal Domain Rules

Rules that apply to all installations:

- Workflow transitions and aging ([index.md §3](index.md#3-workflow-states), [AC-461](verification.md#151-workflow-board))
- Authentication required for protected access
- Authorization enforced server-side on every protected operation

### 12.2 Company-Configurable Settings

The following values are centralized as single-source constants: each has exactly one definition site, so changing it never means hunting call sites. Each corresponds to a `[C]` marker somewhere in this spec.

`[C]` marks a value as deliberately not hardcoded at its use sites. It does **not** by itself promise an operator-facing knob — the catalogue carries two surfaces:

- **Env-var-backed** — settable per deployment without touching source. The entry names the variable (`AGE_RECIPIENT`, `SSE_HEARTBEAT_INTERVAL_MS`, `STORAGE_OBJECT_LOCK_DAYS`, …).
- **Source constant** — one definition site in the codebase; changing it is a code edit plus a redeploy. The entry names no variable.

Entries state which. Promoting a source constant to an env var is a normal change when a deployment actually needs to vary it — it is not a spec change.

- App name, branding, footer brand line — `BRANDING.appName` names the installation across the application surfaces: the header wordmark and login heading, the served document's title, the PWA manifest, and the Service Worker's fallback notification. Rendered-invoice PDF metadata (`Producer` / `Creator`) still carries a literal — tracked, out of AC-363's scope. `BRANDING.shortName` is the installed app's home-screen label, short enough to survive the launcher's truncation. `BRANDING.footerBrandLine` is the application footer's own brand line — not `company_profile.footerText`, which is invoice prose. Source constants, no env vars; [AC-363](verification.md#1519b-app-shell-identity) holds the shell surfaces to one definition site each
- Shell chrome colors — `BRANDING.shell.themeColor` (browser and installed-app chrome) and `BRANDING.shell.backgroundColor` (the splash behind the icon, before first paint). Source constants, no env vars. Independent of the brand accent below: that one is a light/dark pair under a contrast contract, these are single values on surfaces no stylesheet reaches
- Brand accent color — explicit light and dark values (see [§12.5](#125-theming-model))
- Brand logo asset — optional served path, the file living at `public/brand/` (`BRANDING.mark.logo`, source constant, no env var). Set, it replaces the generic mark in the header at every viewport width and is drawn above the issuer block of every rendered invoice; unset, both surfaces fall back to the generic mark. PNG or JPEG only — one asset feeds both surfaces, and the invoice renderer embeds no other format. A deployment ships its asset with its configuration, the same way the other files under `public/` ship; this generalized repo carries none of its own, per [ADR-0001](../adr/0001-generalized-system-with-configurable-customer-specifics.md)
- Favicon and PWA icon set — neither env var nor source constant: the value _is_ the file. Two square SVG marks under `public/` and the PNG set rasterized from them. A deployment replaces the SVGs and regenerates; the procedure lives with the rest of the branding contract in `src/config/brandingConfig.ts`. Distinct from the brand logo above, which is sized for the header strip and the invoice issuer block
- Workflow state configuration — labels, colors, order, count, aging thresholds, collapse tiers ([index.md §3](index.md#3-workflow-states))
- German UI and error strings
- Date and locale display settings
- Password policy — [data-model.md §5.3](data-model.md#53-user-entity)
- Session duration — [data-model.md §5.4](data-model.md#54-session)
- Role set and per-role permission matrix
- Seed default password
- Restore confirmation phrase — typed to confirm an import that replaces business data; matched case-sensitively, ignoring surrounding whitespace ([AC-592](verification.md#1514-data-exchange))
- Backup interval — when backups and drills start ([AC-616](verification.md#1522-backup-and-recovery)). Source constant: `SCHEDULES` in `src/server/backup-runner.ts` (four cron expressions — weekday/weekend backup, weekday/weekend drill). No env var
- Backup freshness thresholds — full days of age of `lastBackupAt` and `lastDrillAt` beyond which the owner-facing badge switches to amber and to red ([ui/index.md §8.1.2](ui/index.md#812-authenticated-state)). Source constant: `BACKUP_THRESHOLDS` in `src/config/backupThresholds.ts`. Defaults, in days: backup amber 2 / red 4, drill amber 14 / red 30. No env var
- Backup public recipient — operator-managed `age` X25519 public recipient string used by the `backup` compose service to encrypt each `pg_dump` artifact and per-table manifest before upload to R2 ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)). No default — the deploy must supply a value; the `backup` service refuses to run without it. Env var: `AGE_RECIPIENT`. The matching private identity is never on the VPS disk; it is loaded into a tmpfs mount on the `backup` service only when the operator wants Tier 2 verification ([AC-175](verification.md#1522-backup-and-recovery)). The matching private key never appears anywhere else and is not a `[C]` value — the recipient string in this catalogue is what couples the deployed `backup` service to the operator's keypair. Parity with `BINARY_AGE_RECIPIENT` below.
- Audit log retention window — rolling age at which `audit_log` entries are removed by the scheduled cleanup (default 90 days; [AC-632](verification.md#1523-audit-log)). Env var: `AUDIT_RETENTION_WINDOW_DAYS`; unset falls back to the build-time default in `src/config/auditRetention.ts`
- Audit activity-feed rendering — mapping from audit entry (`action`, `payload`) ([data-model.md §5.10](data-model.md#510-audit-log-entity)) to the German display string in the activity feed ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed)) and global Aktivität view ([ui/management.md §8.13](ui/management.md#813-audit-view)). Covers each mutation-sourced [`NotificationEventClass`](data-model.md#511-notification-rule) — every such class has an `(action, payload)` projection; system events have no audit row to render ([AC-371](verification.md#1524-notifications)).
- Realtime heartbeat — keepalive interval on realtime event connections; bounds how long an ended session keeps its connections ([AC-275](verification.md#1528-realtime-events)) and, plus 30 seconds, how long an open app takes to show the login screen ([AC-27](verification.md#154-authentication)). Default 25 seconds; bounded 1 s … 600 s. Env var: `SSE_HEARTBEAT_INTERVAL_MS`.
- List page size — default row count for paginated list endpoints (audit) and their management views
- Rate limit buckets — per-session ceilings defined in `getRateLimit()` (`src/server/config/index.ts`); exceeding returns `429 RATE_LIMITED`. Push-subscription mutations (`POST`, `DELETE`) 20/min and password change 5/min are source constants. The login bucket is env-backed — env var `LOGIN_RATE_LIMIT_MAX`; unset falls back to an environment-aware default (5/min under `NODE_ENV=production`, 30/min elsewhere)
- Attachment per-file size cap — maximum `sizeBytes` of a single attachment original (default 1 MB); enforced at init validation, pinned via the presigned PUT's signed `Content-Length`, and re-verified at complete ([data-model.md §5.13](data-model.md#513-attachment)). The derived thumbnail carries its own cap (default 200 KB). Env vars: `ATTACHMENT_PER_FILE_CAP_BYTES`, `ATTACHMENT_THUMB_CAP_BYTES`; unset falls back to the build-time defaults in `src/config/attachmentConfig.ts`
- Attachment bulk-fetch caps — maximum attachment count and summed plaintext byte size per request (default 20 files AND 20 MB); breach rejected with `BULK_LIMIT_EXCEEDED` ([verification.md AC-415](verification.md#1526-attachments)). Env vars: `ATTACHMENT_BULK_MAX_FILES`, `ATTACHMENT_BULK_MAX_BYTES`
- Takeout staging TTL — how long the server keeps an export or import archive after its job ended, and an import upload that makes no progress (default 24 hours; [AC-589](verification.md#1514-data-exchange), [AC-599](verification.md#1514-data-exchange)). Env var: `TAKEOUT_STAGING_TTL_MINUTES` (minutes; default `1440`)
- Takeout staging directory — VPS-local path where the export/import job stages the plaintext archive (env `TAKEOUT_STAGING_DIR`; default under the OS temp dir for zero-config dev/test). **Must resolve to a disk-backed filesystem in production:** the staged archive is the full-account plaintext superset (every business row + every decrypted attachment + each `passwordHash`), so a multi-GB or repeated takeout on a RAM-backed path (the `app` container mounts `/tmp` as tmpfs) exhausts container memory and OOM-kills the VPS. A boot probe refuses to start when `NODE_ENV=production` and the resolved path is on `tmpfs`/`ramfs` (detected via `statfs(2)` magic, not a path heuristic) — fail-closed per the project principle; out of production it warns only. `docker-compose.yml` defaults it to the disk-backed `takeout-staging` named volume.
- Daten-view mobile-warning breakpoint — viewport width (CSS px) below which the Export and Import dialogs render the large-transfer warning (`"… Downloads können sehr groß sein."` / `"… Importe können sehr groß sein."`). Default 480; non-blocking — the user may proceed regardless ([ui/daten.md §8.11.1](ui/daten.md#8111-export), [§8.11.2](ui/daten.md#8112-import))
- Attachment orphan-reaper TTL — age of a `status = 'pending'` attachment row past which the scheduled reaper removes the row and its backing objects (default 15 minutes; [verification.md AC-408](verification.md#1526-attachments)). Env var: `ATTACHMENT_ORPHAN_REAPER_TTL_MINUTES`
- Attachment hidden-reaper TTL — age past `hiddenAt` past which the scheduled reaper hard-deletes the `status = 'hidden'` row (default 2 days; [verification.md AC-426](verification.md#1526-attachments)). Equal to `L` by construction. Env var: `ATTACHMENT_HIDDEN_REAPER_TTL_MINUTES` (minutes; default `2880`)
- Attachment presigned-URL expiry — lifetime of upload (presigned-PUT) and download (presigned-GET) URLs issued by the attachment surface (default 5 minutes)
- Storage capacity declaration — stored-ciphertext volume the deployment's bucket is provisioned for, in power-of-1024 GB. Drives the `disk.threshold_reached` warning ([verification.md §15.33](verification.md#1533-threshold-monitor)). Env var: `STORAGE_QUOTA_GB`, no default — unset disables storage warnings entirely, logged once at startup. Env-backed rather than a source constant because it tracks the provisioned bucket, not policy: a second deployment against a larger bucket must not need a code edit to describe its own capacity
- Threshold-monitor policy — warn band (default 80% of `STORAGE_QUOTA_GB`), clear-band hysteresis margin (default 2 points, so a standing warning clears at 78%), sweep cadence (default 15 minutes), and re-notify cadence while a condition persists (default 1440 minutes = 24 h). Source constant: `THRESHOLD_MONITOR` in `src/config/thresholdMonitor.ts`. No env var — these are policy, parity with `BACKUP_THRESHOLDS`
- Attachment worker self-delete grace — elapsed window since upload during which a worker may delete their own attachment (default 15 minutes; outside the window worker delete is rejected with `403 NOT_PERMITTED`; [verification.md AC-411](verification.md#1526-attachments)). Env var: `ATTACHMENT_WORKER_SELF_DELETE_GRACE_MINUTES`
- Attachment label catalog — the closed enum `AttachmentLabel` ([data-model.md §5.13](data-model.md#513-attachment)) paired with its German display strings: `angebot` → `Angebot`, `auftragsbestaetigung` → `Auftragsbestätigung`, `rechnung` → `Rechnung`, `aufmass` → `Aufmaß`, `foto` → `Foto`, `sonstiges` → `Sonstiges`. Adding a label is a code change plus a migration (parity with the notification-event catalog).
- Attachment upload CTA labels — German copy for the upload affordance on the project detail page ([ui/project-detail.md §8.15.4](ui/project-detail.md#8154-photo-gallery), [§8.15.5](ui/project-detail.md#8155-binary-list)): the camera-capture CTA (`Foto aufnehmen`), the drop-zone text, the explicit-browse labels, and the retry / dismiss actions. Kept alongside the other `German UI and error strings` — listed here because the CTAs are referenced by capability statements elsewhere in the spec.
- Attachment client-encoding parameters — image-longest-edge, image-quality, thumbnail-longest-edge, thumbnail-quality; applied by the browser pipeline before upload ([verification.md AC-404](verification.md#1526-attachments))
- Compliance retention `R` (days) — bucket default retention auto-applied per upload ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)). Sized for the operator-mistake recovery window. Env var: `STORAGE_OBJECT_LOCK_DAYS`. The dev compose stack mirrors the prod B2 setting via the same var.
- Lifecycle hide-to-delete `L` (days) — `daysFromHidingToDeleting` on the bucket lifecycle rule. The Papierkorb trash window: a hidden version is reaped exactly `L` days after the hide marker lands. Env var: `STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS`. **Invariant: `R ≤ L`** — `R > L` is incoherent on its face: lifecycle would attempt to reap noncurrent versions still protected by Object Lock, leaving zombie versions on every reap cycle until `R` elapsed. The boot-time safety probe refuses to start under `R > L` ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- Binary attachment public recipient — operator-managed `age` X25519 public recipient string used by the server to wrap per-blob DEKs into the attachment row's `wrappedDek` / `wrappedThumbDek` envelope ([data-model.md §5.13](data-model.md#513-attachment), [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)). No default — the deploy must supply a value; absence or a malformed value aborts the pre-flight configuration check. Env var: `BINARY_AGE_RECIPIENT`. The matching private identity, with every retired one, forms the binary keyring, operator-loaded into a tmpfs mount on the `app` service (parallel surface to backup; see [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)); the boot probe checks the keyring against these recipients ([verification.md AC-438](verification.md#1526-attachments)). The private keys never appear anywhere else and are not `[C]` values — the recipient strings in this catalogue couple the deployed app to the operator's keypairs.
- Binary attachment retired recipients — the public recipients of retired binary keypairs ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md) § Key rotation), comma-separated, whitespace around entries ignored; unwrap only, never wrapped to. Default empty. A malformed or empty entry aborts the pre-flight configuration check. Listing an entry twice, or listing the active recipient, has no effect. Env var: `BINARY_AGE_RETIRED_RECIPIENTS`.

**Deliberately not `[C]`.** `src/server/config/env.ts` declares variables this catalogue does not list. They are settable, but they are not company settings:

- **Scheduler sweep cadences** — `SESSION_CLEANUP_INTERVAL_MINUTES`, `AUDIT_RETENTION_INTERVAL_MINUTES`, `ATTACHMENT_ORPHAN_REAPER_INTERVAL_MINUTES`, `ATTACHMENT_HIDDEN_REAPER_INTERVAL_MINUTES`. How _often_ a reaper sweeps is operational tuning; the retention window it enforces is the company-facing value, and that one is catalogued.
- **Bucket-orphan prune cadence and grace window** — source constants in `STORAGE_CONFIG`, no env vars, parity with `THRESHOLD_MONITOR`. An orphan is an object no row references: invisible to every company-facing surface, so neither how often it is swept nor how long it must sit first is a company decision. The grace window is a write-settling margin, not a retention window.
- **Deployment wiring and secrets** — database and object-store endpoints, buckets and credentials, `LISTEN_HOST` (listen address, default loopback; compose sets all interfaces), `PORT`, `DOMAIN`, `NODE_ENV`, `SEED`, `ALLOW_INSECURE_HTTP`, VAPID keys, `BOOTSTRAP_ADMIN_*`, the LLM provider key and model id, and the `*_IDENTITY_PATH` mount points for operator-loaded private keys.

A variable's absence here is a claim that no company would need to change it. If one does, the fix is to add the entry — not to treat the catalogue as advisory.

- Invoice Object Lock retention — `INVOICE_OBJECT_LOCK_DAYS`, the per-object Compliance lock (days from write) on every rendered invoice PDF/A-3. Default `3650` in `.env.production.example`: defense in depth against the application's own unreliability, not a retention promise — retention stays with the operating company ([ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md#compliance-boundary)); `0` in `.env.example` writes no lock, so dev binaries stay disposable. Bounds: integer ≥ 0. Independent of the bucket-default retention `R` and the trash window `L` ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)). Behavior: [AC-710](verification.md#1530-invoices). Design: [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md).
- Company default tax mode — `company_profile.defaultTaxMode` ∈ `'standard' | 'reverse_charge'`; pre-fills new invoice drafts with the tenant's most common mode ([data-model.md §5.17](data-model.md#517-company-profile-entity)). Owner-editable at runtime through the company-profile form ([ui/invoices.md §8.16.4](ui/invoices.md#8164-company-profile)); not an env var. Listed here because it is a per-tenant default that the deployment owner sets, not a per-user preference. Default `'standard'` on the pre-seeded singleton.

### 12.3 Configuration Requirements

- Configuration must be represented explicitly, not scattered as literals across the codebase.
- Configuration sources may be static (environment variables, config files), but API and domain boundaries must not assume configuration can only live in source code — the design must permit a move to persisted company settings without restructuring those layers.

### 12.4 User-Configurable Settings

Values controlled per user, independent of the deployment-level configuration in §12.2. Stored on the user record and updated via the self-update API operation.

- Theme preference — `'light' | 'dark' | 'system'`, default `'system'` (see [data-model.md §5.7](data-model.md#57-user-theme-preference))
- Push-mute toggle — boolean, default `false`. When `true`, suppresses push delivery to every subscription owned by the user; activity-feed inclusion is unaffected (see [data-model.md §5.3](data-model.md#53-user-entity), [§5.12](data-model.md#512-push-subscription)).

### 12.5 Theming Model

The visual theme (color scheme) is expressed through a two-layer token system. Components consume only the semantic layer; the primitive layer is an implementation detail.

- **Primitive tokens** — the raw palette, no semantics. Defined once.
- **Semantic tokens** — roles that components reference (surface, text, border, accent, …). Mapped to primitive values.
- **Theme overrides** — a non-default theme (e.g. dark) is a set of semantic-layer overrides scoped by an attribute on the document root. Component stylesheets render different palettes without code changes.
- **Data-driven colors** — state colors from the workflow state configuration remain data-driven and are the single exception to the "no palette values outside the tokens source" rule.
- **Brand accent [C]** — supplied by the branding configuration (§12.2); components consume it via a single semantic token.

### 12.6 Feature Manifest and Operator Confidence

Optional features self-disable when their configuration is incomplete. Without explicit feedback, an operator can complete a deploy and only discover at use time that a feature is silently no-op.

The configuration boundary publishes:

- **A single declared catalog** mapping each feature to the configuration values it requires; the boot manifest's feature list is derived from this catalog.
- **A single read path** — application code reads configuration only through the validated boundary's loader; direct reads from the process environment outside the loader are a narrow, documented exception, not a parallel pattern.
- **A boot-time manifest** — one structured log line per process start enumerating every catalog feature with its state (`enabled` or `disabled`) and a non-empty reason when `disabled`.
- **A pre-flight refusal** — the deploy script validates the loaded configuration against the schema before bringing containers up; a validation failure aborts the deploy and names the offending keys.
- **A schema↔documentation parity check** — the schema's keyspace and the operator-facing example documentation are kept in sync by a CI gate that fails on divergence.

Configuration choices that disable features are the operator's deliberate decisions. Configuration mistakes that silently disable features are bugs. The boundary surfaces both at deploy time and at boot.

---

## 13. Non-Functional Requirements

### 13.1 Usability

- Understandable by non-technical users in a demo context.
- Main actions discoverable without training.
- State type distinction (action/buffer) visually obvious at a glance ([AC-11](verification.md#151-workflow-board)).

### 13.2 Performance

- Initial page load (after login) under 3 seconds on typical broadband.
- API response time for list operations under 500ms for up to 100 projects.
- API response time for mutations under 300ms.
- User actions reflected in the UI within 200ms (optimistic updates permitted; server confirmation may follow).
- The architecture must not preclude scaling to 200+ projects and multiple concurrent users.

### 13.3 Maintainability

- Domain types separated from UI components.
- Warning/aging logic separated from presentation.
- **API contract separated from transport implementation.**
- **Storage operations abstracted behind a module boundary.**
- **Database schema migrations versioned and reproducible.**
- State configuration (labels, colors, thresholds) centralized, not scattered.

### 13.4 Accessibility

Not full compliance, but minimally:

- Sufficient color contrast for state indicators.
- Warning information not conveyed by color alone (text labels accompany colors).
- Keyboard navigation for primary interactions where practical.

### 13.5 Robustness

The UI must tolerate incomplete project data without crashing:

- Missing dates (project appears in Kanban but not calendar).
- Missing address, phone, email (detail panel shows available fields only).
- Missing notes (field simply absent).

**The system must handle failure gracefully:**

- **Network errors during API calls display a user-friendly German message and do not corrupt local state.**
- **Session expiry mid-use redirects to login without data loss** (unsaved changes are inherently impossible — every mutation is sent to the API immediately).
- **The API rejects malformed requests with clear error codes, never with stack traces or internal details.**

### 13.6 Security

- Passwords are hashed using a modern, slow hashing algorithm. Plaintext passwords are never stored or logged.
- Session tokens are cryptographically random and opaque. They carry no user data themselves.
- Secrets for external services (API keys, secret keys) stay on the server; no response or served asset carries them ([ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md)).
- API endpoints validate authentication and authorization on every request. No security-by-obscurity.
- API input is validated and sanitized. No raw user input reaches the database.
- Error messages do not leak internal details (no stack traces, no database field names, no path information).
- HTTPS is required in the deployed environment. The application does not serve over plain HTTP in production. The guarded evaluation mode (see [§13.6.1](#1361-insecure-mode-behavior), [AC-45](verification.md#156-deployment), and [ADR-0013](../adr/0013-http-only-evaluation-mode.md)) is the only documented exception, restricted to non-production environments.

#### 13.6.1 Insecure-mode behavior

When the application is run in insecure (HTTP-only) evaluation mode:

- Session cookies omit the `Secure` attribute so authentication works over plain HTTP.
- HSTS is not sent.
- The Content Security Policy does not upgrade insecure requests.
- The UI shows a non-dismissible warning banner on every page; the browser tab title is prefixed to indicate insecure mode.
- The server refuses to start if insecure mode is active in production (fail-closed).

The activation mechanism (env var, compose override) and CSP wiring details are operational concerns — see [ADR-0013](../adr/0013-http-only-evaluation-mode.md).

### 13.7 Observability

At minimum, the deployed system logs authentication events and API errors to standard output.

### 13.8 Security Checklist for New Endpoints

Every new API endpoint must satisfy:

1. **Authentication**: valid, active session required (see [ADR-0005](../adr/0005-session-management-httponly-cookies.md), [api.md section 14.3](api.md#143-authorization-rules)).
2. **Authorization**: role-based permission check on every protected route.
3. **Input validation**: request schema validation on request body and params (see [api.md section 14.2](api.md#142-operations)). For endpoints accepting composite payloads (e.g., the unified import envelope), per-row semantic validation may live in the service layer per §11.2.
4. **Error handling**: use application error types, no stack traces or DB field names leaked.
5. **Rate limiting**: configured on authentication endpoints (login, password change) and push-subscription mutations (see §12.2 Rate limit buckets **[C]**). Other mutation endpoints are not rate-limited — at current scale with VPN-only access ([ADR-0008](../adr/0008-vpn-first-network-access.md)), this is a known, accepted limitation.
6. **CSRF protection**: mechanism defined in [ADR-0005](../adr/0005-session-management-httponly-cookies.md).
7. **Password handling**: never log or store plaintext (see [ADR-0006](../adr/0006-password-policy-nist-blocklist.md)).
8. **Ownership derivation on self-scoped surfaces**: on caller-owned resources (e.g., push subscriptions — [AC-654](verification.md#1524-notifications)), the server derives the owning user id from the session; a client-supplied owner id is refused ([api.md §14.4.2](api.md#1442-error-principles)).
