# Architecture, Configuration, NFRs and Security

> **This document is the architectural contract** — what must hold for any code in this repository to be considered correct. For the **navigation guide** (tech stack overview, module map with file paths, request lifecycle, "how to extend" recipes), see [ARCHITECTURE.md](../../ARCHITECTURE.md) at the repo root. The two documents serve different readers: this one is for spec audits, the root one is for finding your way around the code.

---

## 11. Architectural Constraints

Constraints imposed from outside the project.

| Constraint                                                                               | Source                                                                                                               | Met by                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modules with a clear separation of concerns; data moves between them over open standards | [kickoff § Done when](../project/kickoff.md#done-when-final-product)                                                 | [ARCHITECTURE.md § Architecture Overview](../../ARCHITECTURE.md#architecture-overview); formats of data leaving the system: [data-model.md](data-model.md)                                                             |
| End-to-end tests are defined and executed on all integrations (CI)                       | [kickoff § Done when](../project/kickoff.md#done-when-final-product)                                                 | [ARCHITECTURE.md § CI/CD Pipeline](../../ARCHITECTURE.md#cicd-pipeline): nightly, not a PR gate ([ADR-0027](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#2026-07-25--e2e-is-not-a-pr-gate)) |
| Deployment is semi-automated, with the operator in the loop; no continuous delivery      | [kickoff § Done when](../project/kickoff.md#done-when-final-product), [§ Not Doing](../project/kickoff.md#not-doing) | [AC-31](verification.md#156-deployment), [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)                                                                                                            |
| Runs on rented hosting; the company has no server hardware                               | [kickoff § Target environment](../project/kickoff.md#target-environment)                                             | [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md)                                                                                                                                 |

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

- Branding — source constants, no env vars. What each one reaches ([AC-743](verification.md#1520-branding)):
  - App name — the header wordmark, the login heading, the document title, the installed app's name, and the title of a push notification that carries none.
  - Short name — the installed app's home-screen label.
  - Footer brand line — the application footer. Not the invoice footer text ([data-model.md §5.17](data-model.md#517-company-profile-entity)).
  - Shell theme color — the browser and installed-app chrome.
  - Shell background color — the installed app's splash.
  - Brand accent — one value per theme, on the surfaces of [AC-114](verification.md#1519-theming), each meeting [AC-748](verification.md#1519-theming) contrast against the surfaces it sits on and the text it carries.
  - Generic mark colors — the header mark while no logo is configured.
  - Logo — optional; the header mark at every width and the invoice issuer block ([AC-746](verification.md#1520-branding)). Used on the invoice only when it names, by an absolute same-origin path, a PNG or JPEG file of at most 2 MB under the served `brand/` directory. A deployment ships its own; this generalized system ships none ([ADR-0001](../adr/0001-generalized-system-with-configurable-customer-specifics.md)).
- Favicon and installed-app icons — files, not values: a deployment replaces them.
- Workflow state configuration — labels, colors, order, count, aging thresholds, collapse tiers ([index.md §3](index.md#3-workflow-states))
- German UI and error strings
- Date and locale display settings
- Password policy — [data-model.md §5.3](data-model.md#53-user-entity)
- Session duration — [data-model.md §5.4](data-model.md#54-session)
- Role set and per-role permission matrix
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
- **Deployment wiring and secrets** — database and object-store endpoints, buckets and credentials, `LISTEN_HOST` (listen address, default loopback; compose sets all interfaces), `PORT`, `DOMAIN`, `NODE_ENV` (unset = production), `SEED`, `ALLOW_INSECURE_HTTP`, VAPID keys, `BOOTSTRAP_ADMIN_*`, the LLM provider key and model id, and the `*_IDENTITY_PATH` mount points for operator-loaded private keys.

A variable's absence here is a claim that no company would need to change it. If one does, the fix is to add the entry — not to treat the catalogue as advisory.

- Invoice Object Lock retention — `INVOICE_OBJECT_LOCK_DAYS`, the per-object Compliance lock (days from write) on every rendered invoice PDF/A-3. Default `3650` in `.env.production.example`: defense in depth against the application's own unreliability, not a retention promise — retention stays with the operating company ([ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md#compliance-boundary)); `0` in `.env.example` writes no lock, so dev binaries stay disposable. Bounds: integer ≥ 0. Independent of the bucket-default retention `R` and the trash window `L` ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)). Behavior: [AC-710](verification.md#1530-invoices). Design: [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md).
- Company default tax mode — `company_profile.defaultTaxMode` ∈ `'standard' | 'reverse_charge'`; pre-fills new invoice drafts with the tenant's most common mode ([data-model.md §5.17](data-model.md#517-company-profile-entity)). Owner-editable at runtime through the company-profile form ([ui/invoices.md §8.16.4](ui/invoices.md#8164-company-profile)); not an env var. Listed here because it is a per-tenant default that the deployment owner sets, not a per-user preference. Default `'standard'` on the pre-seeded singleton.

### 12.3 Configuration Requirements

- Configuration must be represented explicitly, not scattered as literals across the codebase.
- Configuration sources may be static (environment variables, config files), but API and domain boundaries must not assume configuration can only live in source code — the design must permit a move to persisted company settings without restructuring those layers.

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
- HTTPS in the deployed environment: [AC-30](verification.md#156-deployment); the evaluation-mode exception: [§13.6.1](#1361-insecure-mode-behavior).

#### 13.6.1 Insecure-mode behavior

When the application is run in insecure (HTTP-only) evaluation mode:

- Session cookies omit the `Secure` attribute so authentication works over plain HTTP.
- HSTS is not sent.
- The Content Security Policy does not upgrade insecure requests.
- The browser tab title is prefixed to indicate insecure mode.

The warning banner: [AC-766](verification.md#156-deployment). Refusal in production: [AC-765](verification.md#156-deployment).

The activation mechanism (env var, compose override) and CSP wiring details are operational concerns — see [ADR-0013](../adr/0013-http-only-evaluation-mode.md).

### 13.7 Observability

At minimum, the deployed system logs authentication events and API errors to standard output.

### 13.8 Security Checklist for New Endpoints

Every new API endpoint must satisfy:

1. **Authentication**: valid, active session required (see [ADR-0005](../adr/0005-session-management-httponly-cookies.md), [api.md section 14.3](api.md#143-authorization-rules)).
2. **Authorization**: role-based permission check on every protected route.
3. **Input validation**: request schema validation on request body and params; an undefined field is refused ([AC-516](verification.md#1517-data-integrity)). For endpoints accepting composite payloads (e.g., the unified import envelope), per-row semantic validation may live in the service layer.
4. **Error handling**: use application error types, no stack traces or DB field names leaked.
5. **Rate limiting**: configured on authentication endpoints (login, password change) and push-subscription mutations (see §12.2 Rate limit buckets **[C]**). Other mutation endpoints are not rate-limited — at current scale with VPN-only access ([ADR-0008](../adr/0008-vpn-first-network-access.md)), this is a known, accepted limitation.
6. **CSRF protection**: mechanism defined in [ADR-0005](../adr/0005-session-management-httponly-cookies.md).
7. **Password handling**: never log or store plaintext (see [ADR-0006](../adr/0006-password-policy-nist-blocklist.md)).
8. **Ownership derivation on self-scoped surfaces**: on caller-owned resources (e.g., push subscriptions — [AC-654](verification.md#1524-notifications)), the server derives the owning user id from the session; a client-supplied owner id is refused ([AC-516](verification.md#1517-data-integrity)).
