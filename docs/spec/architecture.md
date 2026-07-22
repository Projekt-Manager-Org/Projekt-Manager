# Architecture, Configuration, NFRs and Security

> **This document is the architectural contract** — what must hold for any code in this repository to be considered correct. For the **navigation guide** (tech stack overview, module map with file paths, request lifecycle, "how to extend" recipes), see [ARCHITECTURE.md](../../ARCHITECTURE.md) at the repo root. The two documents serve different readers: this one is for spec audits, the root one is for finding your way around the code.

---

## 11. Architectural Constraints

### 11.1 Mandatory Constraints

- Type-safe language for both client and server code.
- Testing: unit + component + API integration + at least one E2E smoke test.
- All data mutations go through the API. The front end never accesses the database directly.
- Decisions that need context and rationale are recorded in [ADRs](../adr/index.md). All important implementation choices are visible in [ARCHITECTURE.md](../../ARCHITECTURE.md).

### 11.2 Responsibility Boundaries

The system is organized into eight responsibility layers. The split between **Routes**, **Services**, and **Storage** on the server side is load-bearing — routes never reach into the database directly; they delegate to services, which orchestrate repositories and route every domain-entity mutation through the single-write-path helper (see [§11.3](#113-state-layer-behavioral-contract)).

| Layer                         | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config**                    | State definitions, thresholds, colors, company assumptions, role definitions, German strings, validated env. Imported by other layers, imports nothing application-internal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Domain**                    | Pure functions: transition rules, aging calculation, date/session validation, summary computation, types. Never imports from state, API, routes, services, storage, or UI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Storage**                   | Encapsulates all database and object storage operations. Repository modules expose typed query/mutation functions; the object storage client wraps the underlying object-storage SDK. Imported primarily by the Services layer. Exception: authentication middleware reads the session repository directly — architecturally this is part of the route auth hook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
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

**Attachment-bytes boundary.** The app process never reads, decrypts, or proxies attachment ciphertext bytes — only metadata, wrapped DEK envelopes, and the unwrapped DEK during the per-request `download-url` and `bulk-fetch` surfaces ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)) cross the app process. Ciphertext travels exclusively between the browser (via the Attachment Service Worker, see [§11.2](#112-responsibility-boundaries)) and the object-storage provider through presigned URLs. The "no attachment payloads on route handlers" structural-tree invariant (see [verification.md AC-221](verification.md#1526-attachments)) is the upload-direction face of the same rule; the download direction is held by the Service Worker contract above and the absence of a server-side decrypt-and-stream-zip path.

### 11.3 State Layer Behavioral Contract

The state layer is a client-side cache delegating to the API.

**State:** the state layer manages the following data domains:

- **Projects** — the full project list (fetched from API), grouped by workflow state for Kanban rendering.
- **Customers** — the full customer list, used in project forms and the customer management view.
- **Users** — the user list (for admin views and worker assignment dropdowns). Only fetched when needed and when the user has `user:read` permission.
- **Auth** — the authenticated user profile (including theme preference) and session state.
- **View state** — active view, active filter (by workflow state, aged-buffer subset, or custom criteria), selected entity ID for detail views.
- **Mutation tracking** — in-flight flags and error messages per mutation. Confirm-dialog state for transition confirmations.
- **Import state** — parsed envelope, dry-run preview, submission progress, result summary (see [api.md §14.2.4](api.md#1424-unified-data-exchange)).

**Mutations** (per [§11.1](#111-mandatory-constraints)):

- Transition a project forward or backward by one state
- Update a project's planned start/end dates
- Create, update, or soft-delete a project
- Create or update a customer
- Create, update, deactivate, or reactivate a user (admin)
- Reset a user's password (admin); change own password
- Update own preferences (theme preference)
- Export business data / restore from an export envelope (see [api.md §14.2.4](api.md#1424-unified-data-exchange))
- Login / logout
- Fetch or refresh project list, customer list, user list
- Set or clear a filter (local only — no API call)
- Switch between views (local only — clears active filter)

**Queries** (derived from locally cached data):

- Projects grouped by workflow state
- Projects filtered by search, status, customer, date range, or composite criteria
- Customers filtered by search
- Summary: count of projects per action state, count of aged buffer items per state with threshold, count of projects without planned dates
- Current authenticated user and permissions

**Server-side mutation path.** Every domain-entity mutation routes through a single service-layer helper that commits the state change and an `audit_log` row in one database transaction ([data-model.md §5.10](data-model.md#510-audit-log-entity), [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md)). Subscribers — the notification publisher and any future projection — dispatch from the committed audit stream after the transaction commits, so subscriber failure cannot roll back domain state. Bypass is prevented at PR time by a CI-enforced architecture check ([AC-179](verification.md#1523-audit-log)) that rejects raw inserts, updates, or deletes on audited tables outside the helper. Allowlisted paths: migrations, the unified restore path ([api.md §14.2.4](api.md#1424-unified-data-exchange)), business-data seed loaders, and the retention cleanup ([data-model.md §6.10](data-model.md#610-audit-log-retention)). Each allowlist line is a reviewed PR.

**Schema-level audit exclusion.** A column may be marked **audit-excluded**: the marker is a property of the column declared at the schema layer (the same place the column itself is defined), not a service-layer convention applied per call site. The audit-payload builder consults this marker when projecting `before` / `after` snapshots into the `audit_log` `payload` and omits any column carrying it. The exact mechanism — column allowlist/denylist consulted by the builder, a column-attribute on the schema definition, a metadata table, etc. — is implementation-defined; what the contract pins is the **property** (a column flagged at the schema layer is unconditionally absent from every audit `payload`) and the **enforcement shape** (a test pinned by an AC asserts the marked column never appears in any audit JSON across the full mutation surface). The wrapped-DEK envelope columns on the attachment row use this mechanism — see [data-model.md §5.13](data-model.md#513-attachment) "Audit exclusion" and [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md). The schema-layer location is load-bearing: a future column rename or a new audited mutation cannot leak the envelopes by forgetting to add a per-call-site filter.

### 11.4 Object Storage Module

The object storage module encapsulates all binary/file storage operations. It is wired as an infrastructure module and exercised in test and deployed environments against real object storage.

Capabilities at minimum:

- Upload (key, data, content type) → stored reference
- Download (key) → data stream
- Hide (key) → writes a delete marker on the versioned bucket; the prior version is preserved until lifecycle reap
- Copy-from-version (key, sourceVersionId) → restore primitive; promotes a noncurrent version back to current and returns the freshly-issued current-version id
- Get signed/temporary access URL (key, expiry) → URL

**Ciphertext-bytes invariant ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).** Stored objects carry plaintext-opaque bytes and a fixed sentinel `Content-Type` of `application/octet-stream`. The presigned PUT signs ciphertext metadata — the ciphertext's `Content-Length`, the `application/octet-stream` sentinel, and the ciphertext's `Content-MD5` — so a client deviation from the agreed bytes is rejected at the storage layer, not just at complete-time. The complete()-side HEAD asserts the same ciphertext metadata: `head.size == row.ciphertextSizeBytes` (and `ciphertextThumbSizeBytes` when a thumbnail was requested) AND `head.contentType == 'application/octet-stream'`. The row's `mimeType` ([data-model.md §5.13](data-model.md#513-attachment)) is the **plaintext** MIME and is used only on the SW-served plaintext response's `Content-Disposition` header — it is never signed into the PUT and never asserted at HEAD. The bucket-shape probe and capability self-test below are unchanged: they operate on bucket-level configuration, not on byte semantics.

**Capability-split invariant ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).** The storage module's running credential cannot destroy versions. Destruction is a provider-side lifecycle action only — the app key holds write/read/list capabilities but lacks `deleteFiles` (B2) / `s3:DeleteObjectVersion` (MinIO/AWS). A CI architecture check ([verification.md AC-238](verification.md#1526-attachments)) refuses any `DeleteObjectCommand` / `DeleteObjectsCommand` carrying a `VersionId` in the codebase, except at the unique boot-probe site (`probeDeleteVersionCapability` in the storage client) which is allowlisted by an AST-based detector keyed on `{ file, functionName }`.

**Boot-time safety probes.** The module runs three refuse-to-serve checks at app start, before any reaper schedules:

- **Bucket-safety probe** — asserts versioning is enabled, Object Lock is in Compliance mode with positive default-retention `R` days, and the lifecycle is exactly one rule applying `daysFromHidingToDeleting = L` with no other lifecycle rules. The validator is a pure function over a structured snapshot, so the fail/warn matrix is unit-tested without mocking the SDK.
- **Capability self-test** — issues a `DeleteObjectCommand` with a sentinel non-existent VersionId against a sentinel key and asserts the response is `AccessDenied`. Any other outcome (success, `NoSuchVersion`, network timeout, unexpected error) fails the boot fail-closed: the credential cannot be trusted, so the app refuses to serve.
- **Binary-identity probe ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md))** — asserts the operator-loaded binary `age` private identity is present in the tmpfs mount the app reads from and that its derived recipient matches the configured `BINARY_AGE_RECIPIENT` ([§12.2](#122-company-configurable-settings)). Failure is fail-closed: the app refuses to serve. A degraded mode ("uploads-yes-downloads-no", "fall back to plaintext") is rejected — it would create a misleading-state defect class ([ADR-0014](../adr/0014-ac-tier-system-critical-vs-design.md)).

**Operator-loaded binary identity ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).** The binary `age` private identity is operator-loaded into a tmpfs mount on the `app` service via a helper script ([secrets.manifest.txt](../../secrets.manifest.txt) and the operator runbook). The mount is a tmpfs invariant — a persisted identity on disk would defeat the threat model, so the helper refuses to write if the destination is not tmpfs. The pasted material is round-tripped through `age-keygen -y` and the derived public recipient is compared against `BINARY_AGE_RECIPIENT` ([§12.2](#122-company-configurable-settings)); a mismatch is rejected before any wrap takes place. This surface is parallel to the backup operator-load described in [§11.10 "Encryption surface"](#1110-full-state-backup-layer-2), with one substantive difference in failure mode: a missed binary paste keeps the app down (the boot probe above refuses to start the `app` service), whereas a missed backup paste only stales Tier 2 drills (the `backup` service still runs unattended Tier 1). After a VPS reboot the operator pastes both identities; loader order does not matter and the two surfaces are independent. The binary identity and the backup identity are independent keypairs with independent rotation cadence and independent blast radius.

**Re-upload semantic — UUID-keyed.** Object keys are server-issued and unique per attachment row: `{projectId}/{attachmentId}.{orig|thumb}`. The standard upload path mints a fresh attachment id at `init`. The full-account import **job** ([api.md §14.2.4](api.md#1424-unified-data-exchange)) is the documented exception: re-creating each attachment row server-side, it preserves the source envelope's id, so a re-upload onto the same key is observed when the importing bucket already carries prior bytes. The override-import path hides those keys before the re-upload (issue #169 follow-up) so the prior version is demoted to noncurrent through an explicit delete marker rather than implicit version overwrite — the lifecycle reap stays deterministic. The audit chain is paired 1:1 to the row's lifetime. Content-addressed keys were rejected because they couple key schema to bytes and complicate restore semantics (a copy of a hidden version produces a new current version with the same hash, which collides with the content-addressed scheme).

### 11.5 Extensibility Checklist

Structural requirements for the system's documented extension paths. Each row states a contract the codebase must uphold and the failure mode that would close the door.

| Door                                             | Contract                                                                                                                                                                                                                                                                                                                                  | Closed if...                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Adding/removing workflow states                  | States driven by a configuration array, not hardcoded logic                                                                                                                                                                                                                                                                               | Column count or state names are hardcoded in components                                                               |
| Adding new views (worker, bookkeeper, dashboard) | Views consume the shared state layer independently                                                                                                                                                                                                                                                                                        | Kanban and Calendar are coupled to each other                                                                         |
| Adding fields to Project                         | Interface with optional fields; UI tolerates missing data                                                                                                                                                                                                                                                                                 | Components crash on undefined fields                                                                                  |
| Adding file uploads / attachments                | Object storage module exists at the infrastructure layer (§11.4); Project model accepts optional attachments                                                                                                                                                                                                                              | Data layer assumes all project data fits in a single flat object                                                      |
| Adding authentication / roles                    | Authentication and a role-based permission matrix sit behind the API; identity never baked into components                                                                                                                                                                                                                                | User identity baked into component logic                                                                              |
| Adding notifications                             | Post-commit subscribers attach via the single-write-path helper (§11.3); non-mutation events (`backup.failed`, `disk.threshold_reached`) publish to the same bus bypassing audit; rule-matching is data-driven over a closed, code-defined catalog (§11.11, [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md)) | Transitions handled inline in UI event handlers; event classes embedded in handler logic instead of a central catalog |
| Adding a second authentication method            | Auth logic is behind the API; session model is method-agnostic                                                                                                                                                                                                                                                                            | Auth checks are tied to a specific mechanism (e.g., password hashing logic in route handlers)                         |
| Multi-language                                   | All user-facing strings are centralized in configuration; no inline literals in components                                                                                                                                                                                                                                                | Inline literals in components; string configuration bypassed                                                          |
| Adding management views for new entities         | Management views follow a uniform pattern (searchable table + CRUD forms) and consume the shared state layer                                                                                                                                                                                                                              | Entity-specific CRUD logic is wired directly into view components instead of through the state layer and API          |

### 11.6 Deployment Topology

The deployed system consists of four components:

| Component          | Role                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reverse proxy**  | TLS termination, HTTP → HTTPS redirect or non-binding, request forwarding to the application. Production uses automated certificate management — see [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md) and AC-45. The evaluation (HTTP-only) mode substitutes an HTTP-only configuration per [ADR-0013](../adr/0013-http-only-evaluation-mode.md). |
| **Application**    | Serves the front end and exposes the API. Frontend and backend may be a single deployable unit or separate services — this is an ADR decision. The app container listens only on the reverse-proxy-visible network, never on the public interface directly.                                                                                                                             |
| **Database**       | Persistent storage for projects, users, and sessions.                                                                                                                                                                                                                                                                                                                                   |
| **Object storage** | Binary/file storage.                                                                                                                                                                                                                                                                                                                                                                    |

These components may run on the same provider or on separate providers. The spec does not prescribe hosting vendors, managed services, or container strategies — those are ADR decisions. Network topology is further constrained by [ADR-0008](../adr/0008-vpn-first-network-access.md) (VPN-first access) and by the AC-45 HTTPS-or-nothing rule.

The reverse proxy carries an explicit `flush_interval -1` directive on the `/api/events` upstream so the SSE channel is never buffered ([§11.13](#1113-realtime-invalidation-channel), [api.md §14.2.13](api.md#14213-realtime-events), [ADR-0025](../adr/0025-realtime-ui-invalidation-via-sse.md)).

Any deployed environment must exercise all four components end-to-end. A topology that omits any of them — e.g. an application-only deploy without the reverse proxy or object storage — does not satisfy the deployment contract.

### 11.7 Continuous Delivery Pipeline

- **CI gate**: runs on every push and PR to protected branches. Pipeline: dependency audit, lint, format check, type check, env-drift check, unit + component + API-integration tests against real database and real object storage, and build. The image is built and pushed to the container registry on demand ahead of merge; merging to the protected branch promotes (re-tags) that already-built image rather than rebuilding, falling back to a rebuild only if the promotion's integrity guards fail. E2E tests are **not** part of this gate.
- **On-demand E2E gate**: the E2E test framework runs on manual trigger, with the same database + object storage + seed shape as the CI gate. Intended to be run before a manual deploy. AC-37 in [verification.md §15.7](verification.md#157-engineering) documents the topology from the acceptance-criteria side.
- **Deploy:** manual, pull-based. The operator promotes a CI-built image to the hosted environment over VPN. See [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md).
- A failed deployment must not take down the currently running system. The deploy script polls the health endpoint after container swap.
- Environment separation and rollback mechanisms are documented in [docs/ops/manual-deploy.md](../../docs/ops/manual-deploy.md).

### 11.8 External Integrations

Integrations with external services (e.g., LLM APIs) follow a server-side proxy pattern:

- The external-service credential lives in server-side environment configuration and is never exposed to the browser.
- The browser calls a local API route; the server forwards the request to the external service and relays a sanitized response.
- Upstream failures are mapped to the API's error categories (see [api.md §14.4.1](api.md#1441-error-categories)); internal details (service name, upstream status codes, stack traces) do not leak to the client.
- The Content Security Policy (see [§13.6](#136-security)) is kept tight (`connectSrc: 'self'`) — the proxy pattern is what enables this.

The first integration of this shape is the LLM-based email data extractor (see [ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md), [api.md §14.2.6](api.md#1426-data-extraction), [ui/email-intake.md §8.12](ui/email-intake.md#812-email-data-intake)).

### 11.9 Data persistence and recovery

Persistence and recovery are handled in three independent layers, each scoped to a different class of data. See [ADR-0018](../adr/0018-data-persistence-and-recovery-layered-strategy.md) for the rationale and tradeoffs; the table below is a summary only.

| Layer                  | Captures                                                                  | Trigger                                       | Restore                                                                                                   | Verification                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Business data**      | Customers, projects, project-worker assignments (including archived rows) | Human via UI, `data:export` permission        | Unified restore endpoint ([api.md §14.2.4](api.md#1424-unified-data-exchange)), `data:restore` permission | CI roundtrip: seed → export → wipe → import → export → byte-compare on the **text-row slice** (see AC-141). Binary roundtrip rides the full-account job path (AC-328), out of scope for the text-leg compare. |
| **Full DB state**      | Everything in PostgreSQL                                                  | Scheduled job in the `backup` compose service | `pg_restore` from the decrypted backup artifact                                                           | Tier 1 verify-on-create every run; Tier 2 verify-on-cycle when the operator key is loaded ([§11.10](#1110-full-state-backup-layer-2))                                                                         |
| **Binary attachments** | Uploaded files                                                            | Continuous, storage-provider-owned            | Provider restore mechanics                                                                                | Provider durability SLA + documented deployment requirements                                                                                                                                                  |

The layers are complementary, not substitutes — app-level export is not disaster recovery, `pg_dump` is not portable, and binary durability is a storage-provider property. The binary layer's implementation surface is the object storage module ([§11.4](#114-object-storage-module)).

### 11.10 Full-state backup (Layer 2)

The Layer 2 implementation of [§11.9](#119-data-persistence-and-recovery) is a dedicated `backup` compose service that runs on a configurable interval and writes, per run, three artifacts to an off-site object store — the encrypted dump, the encrypted manifest sidecar, and the unencrypted status mirror object — plus upserts a single row in the application database. Rationale, alternatives, consequences, provider choice, tool choice, and key-layout convention live in [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md).

**Topology.**

- The `backup` compose service is scheduled by an in-process `croner` registered by `src/server/backup-runner.ts`'s `schedule` subcommand; the compose file is the source of truth ([ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)). The backup interval is a **[C]** value — the `SCHEDULES` source constant in `src/server/backup-runner.ts`, not an env var ([§12.2](#122-company-configurable-settings)).
- Each run produces the backup artifact (a full-state database dump, encrypted) and its manifest sidecar (per-table row count and deterministic content checksum, encrypted). The manifest checksum is computed as specified in [ADR-0020 §Decision](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#decision).
- Retention is linear (provider-enforced bucket lock + lifecycle rule, canonical values at [ADR-0020 §Retention](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention)). No in-container rotation, no weekly/monthly promotion, no object versioning. Scope rationale in the same section.

**Encryption surface.**

- Dumps and manifests are encrypted with an asymmetric recipient. The public recipient key ships in container env; the private identity must never be present on the VPS outside a tmpfs mount ([§13.6](#136-security)).
- For Tier 2 drills, the operator loads the private identity into tmpfs via a helper script; the identity is lost on reboot and never persists to disk.
- This is one of two operator-loaded `age` identities the deploy carries — the parallel surface for binary attachment e2e encryption is in [§11.4](#114-object-storage-module) (Operator-loaded binary identity). The two identities are independent keypairs with independent rotation, custody, and failure modes; coupling them would double the blast radius for a fixed operator-burden saving ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).

**Verification (dual tier).**

- **Tier 1 — verify-on-create** runs every backup, unattended. The freshly produced plaintext dump is restored into an ephemeral database instance, container-internal (not a sibling service), the manifest is recomputed, and it is compared to the source manifest. A mismatch fails the run: no upload, and the status surface reports failure.
- **Tier 2 — verify-on-cycle** runs every backup when the operator's identity is present in tmpfs. The just-uploaded encrypted dump is downloaded, decrypted, restored into the ephemeral database instance, and its manifest is compared. When the key is absent, the drill is skipped with a distinct log line; freshness surfaces via the status row rather than as a failure.

**Status surface (dual-write).**

- Primary: the `meta_backup_status` row ([data-model.md §5.9](data-model.md#59-backup-status-entity)), read by the backend on the authenticated admin landing view.
- Mirror: an unencrypted status mirror object in the off-site object store carrying the same fields, readable without the application. This exists so backup health is inspectable during a database outage (operator inspects directly; no application surface required).
- On the authenticated admin landing view, the badge is visible only to callers with role `owner`. The badge surface scales by severity — green is a bare dot with a tooltip; amber, red, and unknown render the full pill with label. Amber and red thresholds are configurable **[C]** (see [§12.2](#122-company-configurable-settings)).
- When the status source is unreachable, the rendering surface MUST display a neutral "status unknown" state — silent absence is a misleading-state defect class ([ADR-0014](../adr/0014-ac-tier-system-critical-vs-design.md)).

### 11.11 Notification Publisher and Dispatch

Process-local projection over two feeds: the post-commit `audit_log` stream (mutation events) and the in-process domain-event bus (non-mutation system events — `backup.failed`, `disk.threshold_reached`). Rationale: [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md) (publisher-over-audit), [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md) (catalog and rule shape).

**Event classification.** The publisher maps audit rows to `NotificationEventClass` ([data-model.md §5.11](data-model.md#511-notification-rule)) via `(entityType, action)` — and `after.status` for transitions. Rows outside the catalog are ignored; this is where the closed catalog is enforced at runtime alongside admin-write validation. Bus events carry their `NotificationEventClass` directly.

**Rule resolution.** For each classified event, the publisher reads enabled rules for the matching `eventClass`, filters by `stateFilter`, and unions recipients across each matching rule's three additive `recipientSpec` parts, deduplicated by `UserAccount.id`. Missing or `active = false` users are dropped; zero live recipients is a no-op.

**Channel selection.** The activity feed always receives the event (`audit_log` for mutations; bus events write a companion feed row so the Aktivität view stays uniform). Push is attempted for each resolved recipient whose `UserAccount.pushMuted` is `false`. Permanent-error responses remove the corresponding subscription ([data-model.md §5.12](data-model.md#512-push-subscription)).

**Failure isolation.** Handlers run post-commit; a throwing handler does not roll back the mutation ([AC-183](verification.md#1523-audit-log)). Per-recipient push failures do not block remaining recipients.

**Push transport.** The real dispatcher wraps the `web-push` npm package and is selected at app composition when VAPID credentials are configured; otherwise a no-op dispatcher is installed with a startup warning. The VAPID public key is derived from the private half at startup and served to the client via an unauthenticated endpoint ([api.md §14.2.10](api.md#14210-push-subscription)); the private key never leaves the server.

### 11.12 Audit Ancestor Link

Each `audit_log` row carries an optional `(ancestorEntityType, ancestorEntityId, ancestorEntityLabel)` triple alongside its own `(entityType, entityId, entityLabel)`. The triple exists so a per-parent activity feed (project detail) can pull every row scoped to that parent in one indexed predicate — without JSON-path probes or bespoke `projectScope` carve-outs — and so a cross-project activity feed (the dock + the global Aktivität view) can render the parent project's name on every child-entity row without a runtime JOIN against `projects`. All three columns are populated atomically with the audit row by the `mutate()` helper. The DB CHECK `audit_log_ancestor_pair` enforces both-or-neither on the `(type, id)` pair; `ancestorEntityLabel` is unconstrained at the DB level (no separate CHECK) but the service layer always populates it whenever the pair is populated — projects always carry a `displayName`-derived label, so a non-null pair without a label would indicate a programmer error, not a legitimate domain state.

**Write-time convention.**

- `entityType = 'project'` rows self-ancestor: `ancestor = ('project', entityId, projectLabel)` — `ancestorEntityLabel` duplicates the row's own `entityLabel` so the cross-project feed reads uniformly across a project's own lifecycle and its nested entities.
- Nested entities (`entityType = 'project_worker'`, `entityType = 'attachment'`, `entityType = 'invoice'`) set `ancestor = ('project', projectId, projectLabel)` — the id and label of the owning project are already in scope at every service call site (the service has just read or written the project row).
- Top-level entities (`entityType = 'customer'`, `entityType = 'user'`, `entityType = 'company_profile'`, `entityType = 'data_import'`) leave the ancestor triple NULL.
- New nested entity types extend the convention by setting their parent ancestor at the service layer; no schema change is required.

**Read path.** The compound index `audit_log_ancestor_idx` on `(ancestor_entity_type, ancestor_entity_id, created_at DESC, id DESC)` serves the project-detail query shape — filter by ancestor pair, order by `createdAt DESC, id DESC` (the list endpoint's tiebreaker from [api.md §14.2.8](api.md#1428-audit-log)). The index key mirrors the ORDER BY so a page is served entirely from the index.

**CHECK closure.** `audit_log_ancestor_type_valid` pins `ancestorEntityType` to the same closed `AuditEntityType` set as `entityType`, keeping the two columns in lock-step when a new entity type lands.

### 11.13 Realtime Invalidation Channel

In-process bus that fans out typed invalidation events to subscribed SSE connections so cross-session UI surfaces refetch the read endpoints they already consume. Architectural rationale: [ADR-0025](../adr/0025-realtime-ui-invalidation-via-sse.md) (decision and shape). Same architectural shape as [§11.11](#1111-notification-publisher-and-dispatch)'s in-process publisher per [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md), with a distinct subscriber set: SSE connections rather than notification channels. Wire contract is in [api.md §14.2.13](api.md#14213-realtime-events).

**Bus.** A process-local module owns a set of subscribers (one per live `/api/events` connection). `emit(event)` iterates the set and writes the SSE frame to each connection. Single Node process, single tenant — no cross-process fan-out is required for v1.

**Subscription lifecycle.** A subscriber is added when the request handler accepts a `/api/events` connection ([api.md §14.2.13](api.md#14213-realtime-events)) and the response stream is opened. The handler registers a teardown that removes the subscriber on connection close, error, or process shutdown. Unsubscribe is idempotent — a teardown firing twice (e.g. error followed by close) is a no-op on the second call.

**Emission — post-commit, from mutation call sites.** Events are emitted in-process, after the surrounding transaction commits, never inside it (parity with [§11.11](#1111-notification-publisher-and-dispatch)). v1 emitters of `storage_usage_changed`:

- `AttachmentService.completeUpload` (`pending → ready`)
- `AttachmentService.hide` (`ready → hidden`)
- `AttachmentService.restore` (`hidden → ready`)
- `attachment-hidden-reaper` ([data-model.md §6.12](data-model.md#612-attachment-hidden-reaper)) — `hidden` row delete
- `ProjectCrudService.purgeProject` ([api.md §14.2.2](api.md#1422-projects), AC-155) — FK cascade removes every `attachment` row on the purged project
- `CustomerService.deleteCustomer` ([api.md §14.2.5](api.md#1425-customer-management), AC-91) — atomic purge of every archived project under the customer; the cascade removes their attachments alongside
- the full-account **import job** ([api.md §14.2.4](api.md#1424-unified-data-exchange)) — its server-side restore replaces the attachment set wholesale (override wipe + per-attachment re-encrypt → PUT → insert)

The first three AttachmentService paths cover every byte-moving mutation reachable through the attachment-level API surface; the hidden reaper covers the one scheduled byte-moving path; the two cascade emitters cover the remaining byte-moving paths reachable through the project- and customer-level destructive APIs (cascade-driven attachment removal that the per-row delete trigger short-circuits at depth>1, [data-model.md §5.14](data-model.md#514-project-storage-usage)). Together they emit on every transition that changes a counter in [data-model.md §5.14](data-model.md#514-project-storage-usage). The orphan reaper ([data-model.md §6.11](data-model.md#611-attachment-orphan-reaper)) deletes only `pending` rows, which contribute zero to every counter — no event is emitted. The cascade emitters skip emission when the cascade removes no byte-bearing rows (purged project carried no attachments or only `pending` rows; customer had no archived projects, or all archived projects were empty) — pending rows do not move counters, so a wasted broadcast would refetch identical totals for every observer. The full-account import job emits one coarse `storage_usage_changed` after its restore transaction commits — the attachment set changed wholesale — never one frame per restored attachment. New emitters land alongside new event names without new infra.

v1 emitters of `project_changed`:

- `ProjectCrudService.createProject` ([api.md §14.2.2](api.md#1422-projects), AC-59) — new row visible to every project list / detail consumer.
- `ProjectCrudService.updateProject` ([api.md §14.2.2](api.md#1422-projects), AC-60) — covers every field-update path on the row (`title`, `customerId`, `estimatedValue`, `notes`) and the assigned-worker join (`assignedWorkerIds`). Emission is on every successful return — including the assigned-worker-only path that mutates `project_workers` without writing the `projects` row, because the join is part of the project list / detail read surface.
- `ProjectCrudService.deleteProject` ([api.md §14.2.2](api.md#1422-projects), AC-61) — soft-delete (archive); flips `deleted` and changes the rows surfaced under `includeArchived`.
- `ProjectCrudService.restoreProject` ([api.md §14.2.2](api.md#1422-projects)) — un-archive; inverse of the soft-delete above.
- `ProjectCrudService.purgeProject` ([api.md §14.2.2](api.md#1422-projects), AC-155) — hard delete of an already-archived row; observable through the `includeArchived` list dropping the row.
- `ProjectTransitionService.transitionForward` ([api.md §14.2.2](api.md#1422-projects), AC-5) — `+1` workflow-state transition.
- `ProjectTransitionService.transitionBackward` ([api.md §14.2.2](api.md#1422-projects), AC-6) — `-1` workflow-state transition.
- `ProjectDatesService.updateDates` ([api.md §14.2.2](api.md#1422-projects), AC-7) — planned start / end edit.
- `CustomerService.deleteCustomer` ([api.md §14.2.5](api.md#1425-customer-management), AC-91) — customer-delete cascade, when at least one archived project exists under the customer (the cascade removes those project rows alongside the customer). When the customer has zero archived projects, no event is emitted — the project rows visible to subscribers do not change.
- `ImportService.import` (non-dry-run, [api.md §14.2.4](api.md#1424-unified-data-exchange)) — both branches write project rows inside one transaction: the override branch TRUNCATEs and re-inserts the full Layer 1 set (`users`, `company_profile`, `customers`, `projects`, `project_workers`, `invoice_sequence`, `invoices`, `attachments`) into a non-empty target; the empty-target branch inserts into empty tables (the seed-equivalent path). Exactly one `project_changed` is emitted post-commit per successful import — the project corpus is being established or replaced; one coarse signal is sufficient for every consumer to refetch. The `dryRun` path is read-only and emits nothing.

The `ProjectCrudService.purgeProject` and `CustomerService.deleteCustomer` paths are the same call sites that emit `storage_usage_changed` when the cascade carries byte-bearing attachment rows; both events are emitted independently from the same post-commit phase. `ProjectCrudService.purgeProject` always emits `project_changed` (the project row is being deleted) but only emits `storage_usage_changed` when the cascade carried byte-bearing rows. `CustomerService.deleteCustomer` emits `project_changed` whenever any archived project is purged in the cascade and emits `storage_usage_changed` only when those archived projects carried byte-bearing rows; the two gates are independent.

Coverage rationale: `project_changed` fires on every consumer-observable mutation reachable through the service layer — `projects` row writes ([data-model.md §5.1](data-model.md#51-project-entity)), `project_workers` join writes via `updateProject` (the join is part of the project read surface), and the bulk-restore path (`ImportService.import` override). The signal covers every change visible on the project list, the per-project detail, the Kanban board, and the Calendar bars. Out-of-band SQL writes do not emit (same v1 limitation as `storage_usage_changed`, see "Known v1 limitation" below).

**Emitter of `audit_changed`.** The notification publisher's post-commit `onAuditCommitted` hook ([§11.11](#1111-notification-publisher-and-dispatch), [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md)) broadcasts one `audit_changed` per committed `audit_log` row, after the originating mutation's transaction commits. Because every audited domain mutation routes through the single-write-path helper ([api.md §14.2.8](api.md#1428-audit-log)), this one coarse signal covers every activity-feed surface without a per-call-site emitter — a transaction that rolls back writes no audit row and so emits nothing. Consumers (the project-detail activity feed, the global Aktivität view, and the activity dock — [ui/index.md §8.1.2](ui/index.md#812-authenticated-state)) refetch [api.md §14.2.8](api.md#1428-audit-log). The wire payload stays contentless (`{ "type": "audit_changed" }`); audit content rides only the `audit:read`-gated read endpoint, never the broadcast (see **Broadcast posture** below).

**Emitter of `data_exchange_job_changed`.** The `DataExchangeJobService` mutators ([data-model.md §5.18](data-model.md#518-data-exchange-job-entity)) emit one frame post-write on every lifecycle transition (`create` / `markRunning` / `markReady` / `markFailed`) and on a throttled subset of `updateProgress` calls (≈1/s or per-N files — lifecycle transitions always emit; progress is the only throttled class, so a thousand-file job does not produce a thousand frames). The job runner owns the throttle, not a per-call-site hook. The frame is invalidation-only; the Daten-view export / import dialog refetches the active job over [api.md §14.2.4](api.md#1424-unified-data-exchange). This is the one emitter not tied to a single wrapping transaction — a job is a sequence of small autocommitted row updates — but it keeps the post-write discipline (emit after the update resolves, never mid-update).

**Failure isolation.** A throwing subscriber writer (closed socket, slow consumer) does not affect other subscribers — the bus catches per-subscriber failures, logs structured operational output, and removes the failing subscriber. Same posture as [§11.11](#1111-notification-publisher-and-dispatch)'s post-commit handlers; an emission failure never rolls back the originating mutation, which has already committed.

**Heartbeat.** Each connection writes a `:` keepalive comment line at the configurable heartbeat interval **[C]** ([§12.2](#122-company-configurable-settings); default 25 seconds, bounded 1 s … 600 s) to defeat reverse-proxy and browser idle disconnects. Independent per connection; not coordinated across the subscriber set.

**Mid-stream session re-validation.** The authentication preHandler runs once at connect time, so a held stream must not outlive the session that authorized it ([CWE-613](https://cwe.mitre.org/data/definitions/613.html)). Each heartbeat tick re-runs `AuthService.isSessionValid(token)` against the cookie token; a missing row, expired row, or inactive user ends the response and removes the subscriber. Detection bound: one heartbeat interval post-revocation. DB cost: one `findSession` query per connection per heartbeat — independent of broadcast rate, matching the cadence the timer already runs at. Transient DB errors during re-validation skip the tick rather than disconnecting; the next tick retries. Covers all four session-invalidation paths uniformly: natural expiry, logout (`AuthService.logout`), admin lockout (`UserService.deactivateUser`'s `users.active = false` + session cascade), and the periodic reaper.

**Broadcast posture.** Events fan out to every connected authenticated session. Authorization happens at the consumer endpoints the client refetches, not at the event — the role-leakage tradeoff is recorded in [ADR-0025 §Consequences](../adr/0025-realtime-ui-invalidation-via-sse.md#consequences) and accepted under the project's threat model.

**Reverse-proxy posture.** Caddy auto-flushes responses with `Content-Type: text/event-stream`; an explicit `flush_interval -1` directive on the `/api/events` upstream is the defensive belt-and-suspenders ([§11.6](#116-deployment-topology), [api.md §14.2.13](api.md#14213-realtime-events)). Misconfigure and SSE buffers until the connection closes.

**Known v1 limitation.** Out-of-band SQL writes (admin shell, future migrations, direct trigger-driven mutations not routed through the service layer) do not emit. The PostgreSQL `LISTEN`/`NOTIFY` upgrade path is recorded in [ADR-0025](../adr/0025-realtime-ui-invalidation-via-sse.md) — when the gap becomes load-bearing, triggers `NOTIFY` and the Node process holds a persistent `LISTEN` connection that fans out to the same SSE subscribers.

**Verification.** Bus failure isolation, per-emitter delivery (`audit_changed` by [AC-320](verification.md#1528-realtime-events)), channel shape, heartbeat, and reconnect are pinned by [§15.28](verification.md#1528-realtime-events); the activity dock's live behavior, gating, and responsive posture by [§15.32](verification.md#1532-activity-dock).

### 11.14 Invoice Domain

The transaction shape and supporting topology for the invoice domain ([data-model.md §5.15](data-model.md#515-invoice-entity), [data-model.md §5.16](data-model.md#516-invoice-sequence-entity), [data-model.md §5.17](data-model.md#517-company-profile-entity)). Architectural rationale — immutable snapshot, gapless sequence, ZUGFeRD EN 16931 profile, env-driven Object Lock retention, Stornorechnung as a sibling row — is pinned by [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md).

**Issuance transaction.** A single DB transaction wraps every step of the `draft → issued` transition:

1. Atomic `INSERT … ON CONFLICT (year, kind) DO UPDATE … RETURNING next_value` on `invoice_sequence` `(year, 'invoice')` — single statement covers both first-of-year and steady-state; Postgres takes a row-exclusive lock for the duration of the transaction (equivalent to `SELECT FOR UPDATE`).
2. Format the resulting `Invoice.number` as `RE-YYYY-NNNN`.
3. Snapshot `issuer` from the live `company_profile` row, `recipient` from the live `customers` row (looked up via `project.customerId`); freeze `lines`, `taxMode`, `profile` from the draft's current values; compute `totals` server-side from `lines` + `taxMode`.
4. Render the PDF/A-3 with embedded `factur-x.xml` (ZUGFeRD EN 16931 Comfort profile) — the render happens inside the transaction so a render failure rolls back the sequence allocation.
5. Write the rendered bytes through the binary descriptor pipeline ([§11.4](#114-object-storage-module)) using the e2e envelope ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)). The descriptor write is part of the same transaction; Object Lock retention is applied per `INVOICE_OBJECT_LOCK_DAYS` ([§12.2](#122-company-configurable-settings)).
6. Flip `Invoice.status` to `'issued'`, persist the snapshotted fields, persist `renderedPdfBinaryDescriptorId`.
7. Update the parent `Project.status` to `abgerechnet` via the standard transition path; the transition's audit row is co-committed in the same transaction.
8. Write the `audit_log` row through the single-write-path helper ([§11.3](#113-state-layer-behavioral-contract)) with `entityType = 'invoice'`, `action = 'invoice:issue'`, ancestor `('project', projectId)`.
9. Commit.
10. Post-commit, emit the `invoice_changed` and `project_changed` SSE events ([§11.13](#1113-realtime-invalidation-channel)) — the project status changed, so both consumer surfaces (invoice list, project list / kanban) invalidate.

A failure at any step rolls back the entire transaction: the sequence increment never persists (gapless guarantee — [§6.13](data-model.md#613-gapless-sequence-allocation)), no binary is left orphaned (the descriptor write rolls back), the project status stays at `rechnung_faellig`, and the draft remains editable.

**Stornorechnung issuance transaction.** Cancellation of an issued invoice runs its own single transaction:

1. Atomic `INSERT … ON CONFLICT (year, kind) DO UPDATE … RETURNING next_value` on `invoice_sequence` `(year, 'storno')`.
2. Format `ST-YYYY-NNNN`.
3. Insert a new `Invoice` row carrying `cancellationOf = <original.id>`, `issuer` / `recipient` / `taxMode` / `profile` / `performanceDate` snapshotted from the original, `lines` with sign-flipped `unitPrice` and `lineTotal`, totals re-derived from the negated lines, `cancellationReason` from the cancel call body, `status = 'issued'` (Storno rows are born issued).
4. Render the PDF/A-3 with embedded `factur-x.xml` for the Storno using the same toolchain; write bytes through the binary pipeline.
5. Flip the original row's `status` to `'cancelled'`; the original row's other fields are unchanged (it stays frozen per [§6.14](data-model.md#614-immutability-of-issued-invoices)).
6. Write two `audit_log` rows through `mutate()` — one `invoice:cancel` on the original, one `invoice:issue` on the Storno — both inside the same transaction. Project status is **not** auto-modified (the operator decides what to do with the now-orphan `abgerechnet` state via the UI — [ui/invoices.md §8.16](ui/invoices.md#816-invoices-view)).
7. Commit.
8. Post-commit, emit `invoice_changed`.

**Render shape (ZUGFeRD EN 16931 Comfort).** A single PDF/A-3 file with the EN 16931 XML payload embedded as `factur-x.xml`. The PDF is human-readable; the XML is machine-readable. The Comfort profile is the EN 16931-conformant tier of ZUGFeRD — sufficient for §14a UStG and what B2B receivers expect. v1 `Invoice.profile` always evaluates to `'zugferd-en16931'`; the field exists so a future XRECHNUNG profile lands without schema churn (renderer dispatch by `profile`, [ADR-0026 §E-invoice format](../adr/0026-invoices-immutability-and-zugferd.md#e-invoice-format)). The render is server-side; the toolchain choice is implementation-defined (`ARCHITECTURE.md § Invoices Module`).

**Tax-mode boilerplate.** Each `taxMode` value renders with the legally-mandated boilerplate in German:

- `standard` — per-line VAT columns (19% / 7%), full tax breakdown in the totals block.
- `kleinunternehmer` — no VAT columns; mandatory boilerplate `"Gemäß § 19 UStG wird keine Umsatzsteuer berechnet"` (or the configured equivalent).
- `reverse_charge` — no VAT on lines; mandatory boilerplate `"Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG"`.

Exact German strings live in the German UI and error strings catalogue (`[C]` — [§12.2](#122-company-configurable-settings)).

**Object Lock retention.** The rendered PDF/A-3 carries env-driven retention via `INVOICE_OBJECT_LOCK_DAYS` ([§12.2](#122-company-configurable-settings) `[C]`). The boot-time bucket-safety probe ([§11.4](#114-object-storage-module)) is extended to assert that the invoice retention envelope covers the env value (bucket retention ≥ env) — under-retention refuses to start the `app` service (parity with the attachment retention envelope, fail-closed posture per project principle); over-retention is accepted.

**Worker exclusion.** The worker role holds no invoice permission and is excluded from invoice rows by absence of a `project_worker` scope path — the repository-predicate pattern ([ADR-0019](../adr/0019-worker-data-scoping-repository-layer-predicate.md)) returns the empty set for the worker role without a route-level carve-out.

**Verification.** State-machine, transaction shape, sequence gaplessness, tax-mode rendering, Storno mechanics, Object Lock enforcement, and worker exclusion are pinned by [§15.30](verification.md#1530-invoices). Company-profile invariants are pinned by [§15.31](verification.md#1531-company-profile).

---

## 12. Configuration Boundaries

### 12.1 Universal Domain Rules

Rules that apply to all installations:

- Adjacent-only forward/backward transitions
- Terminal state concept (no transitions out of the final state)
- Aging calculation semantics (days since `statusChangedAt`, compared against a threshold)
- Authentication required for protected access
- Authorization enforced server-side on every protected operation

### 12.2 Company-Configurable Settings

The following values are centralized as single-source constants: each has exactly one definition site, so changing it never means hunting call sites. Each corresponds to a `[C]` marker somewhere in this spec.

`[C]` marks a value as deliberately not hardcoded at its use sites. It does **not** by itself promise an operator-facing knob — the catalogue carries two surfaces:

- **Env-var-backed** — settable per deployment without touching source. The entry names the variable (`AGE_RECIPIENT`, `SSE_HEARTBEAT_INTERVAL_MS`, `STORAGE_OBJECT_LOCK_DAYS`, …).
- **Source constant** — one definition site in the codebase; changing it is a code edit plus a redeploy. The entry names no variable.

Entries state which. Promoting a source constant to an env var is a normal change when a deployment actually needs to vary it — it is not a spec change.

- App name, branding, footer text
- Brand accent color — explicit light and dark values (see [§12.5](#125-theming-model))
- Workflow state configuration — labels, colors, order, count, aging thresholds, collapse tiers
- German UI and error strings
- Date and locale display settings
- Project numbering format — year + sequential (see [data-model.md §5.1](data-model.md#51-project-entity))
- Password policy — minimum length, maximum byte length, blocklist
- Session duration
- Role set and per-role permission matrix
- Seed default password
- Restore confirmation phrase — typed by the caller to confirm an override-restore into a non-empty database (see [api.md §14.2.4](api.md#1424-unified-data-exchange))
- Layer 2 backup interval — cadence of the `backup` compose service ([§11.10](#1110-full-state-backup-layer-2)). Source constant: `SCHEDULES` in `src/server/backup-runner.ts` (four cron expressions — weekday/weekend backup, weekday/weekend drill). No env var
- Layer 2 freshness thresholds — age of `lastBackupAt` and `lastDrillAt` at which the owner-facing badge switches to amber and to red ([§11.10](#1110-full-state-backup-layer-2)). Source constant: `BACKUP_THRESHOLDS` in `src/config/backupThresholds.ts`. Defaults, in days: backup amber 2 / red 4, drill amber 14 / red 30. No env var
- Layer 2 backup public recipient — operator-managed `age` X25519 public recipient string used by the `backup` compose service to encrypt each `pg_dump` artifact and per-table manifest before upload to R2 ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)). No default — the deploy must supply a value; the `backup` service refuses to run without it. Env var: `AGE_RECIPIENT`. The matching private identity stays on the operator workstation and is loaded into a tmpfs mount on the `backup` service only when the operator wants Tier 2 verification (see [§11.10 "Encryption surface"](#1110-full-state-backup-layer-2)). The matching private key never appears anywhere else and is not a `[C]` value — the recipient string in this catalogue is what couples the deployed `backup` service to the operator's keypair. Parity with `BINARY_AGE_RECIPIENT` below.
- Audit log retention window — rolling age at which `audit_log` entries are removed by the scheduled cleanup (default 90 days; see [data-model.md §6.10](data-model.md#610-audit-log-retention)). Env var: `AUDIT_RETENTION_WINDOW_DAYS`; unset falls back to the build-time default in `src/config/auditRetention.ts`
- Audit activity-feed rendering — mapping from audit entry (`action`, `payload`) ([data-model.md §5.10](data-model.md#510-audit-log-entity)) to the German display string in the activity feed ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed)) and global Aktivität view ([ui/management.md §8.13](ui/management.md#813-audit-view)). Covers each [`NotificationEventClass`](data-model.md#511-notification-rule) — every catalog event has an `(action, payload)` projection.
- Realtime invalidation heartbeat — interval of `:` keepalive comment lines on `/api/events` ([§11.13](#1113-realtime-invalidation-channel), [api.md §14.2.13](api.md#14213-realtime-events)). Default 25 seconds; bounded 1 s … 600 s. Env var: `SSE_HEARTBEAT_INTERVAL_MS`.
- List page size — default row count for paginated list endpoints (projects, customers, users, audit) and their management views
- Rate limit buckets — per-session ceilings defined in `getRateLimit()` (`src/server/config/index.ts`); exceeding returns `429 RATE_LIMITED`. Push-subscription mutations (`POST`, `DELETE`) 20/min and password change 5/min are source constants ([api.md §14.2.10](api.md#14210-push-subscription)). The login bucket is env-backed — env var `LOGIN_RATE_LIMIT_MAX`; unset falls back to an environment-aware default (5/min under `NODE_ENV=production`, 30/min elsewhere)
- Attachment per-file size cap — maximum `sizeBytes` of a single attachment original (default 1 MB); enforced at init validation, pinned via the presigned PUT's signed `Content-Length`, and re-verified at complete ([data-model.md §5.13](data-model.md#513-attachment), [api.md §14.2.11](api.md#14211-attachments)). The derived thumbnail carries its own cap (default 200 KB). Env vars: `ATTACHMENT_PER_FILE_CAP_BYTES`, `ATTACHMENT_THUMB_CAP_BYTES`; unset falls back to the build-time defaults in `src/config/attachmentConfig.ts`
- Attachment bulk-fetch caps — maximum attachment count and summed plaintext byte size per request (default 20 files AND 20 MB); breach rejected with `BULK_LIMIT_EXCEEDED` ([api.md §14.2.11](api.md#14211-attachments), [verification.md AC-216](verification.md#1526-attachments)). Env vars: `ATTACHMENT_BULK_MAX_FILES`, `ATTACHMENT_BULK_MAX_BYTES`
- Takeout staging TTL — age past which the scheduled reaper sweeps a staged full-account archive (a `ready` export's downloadable artifact, or an abandoned / terminal import upload) from the VPS-local staging path (default 24 hours; [api.md §14.2.4](api.md#1424-unified-data-exchange) — Jobs — staging + reaper, [data-model.md §5.18](data-model.md#518-data-exchange-job-entity), [verification.md AC-334](verification.md#1514-data-exchange)). Env var: `TAKEOUT_STAGING_TTL_MINUTES` (minutes; default `1440`)
- Takeout staging directory — VPS-local path where the export/import job stages the plaintext archive (env `TAKEOUT_STAGING_DIR`; default under the OS temp dir for zero-config dev/test). **Must resolve to a disk-backed filesystem in production:** the staged archive is the full-account plaintext superset (every business row + every decrypted attachment + each `passwordHash`), so a multi-GB or repeated takeout on a RAM-backed path (the `app` container mounts `/tmp` as tmpfs) exhausts container memory and OOM-kills the VPS. A boot probe refuses to start when `NODE_ENV=production` and the resolved path is on `tmpfs`/`ramfs` (detected via `statfs(2)` magic, not a path heuristic) — fail-closed per the project principle; out of production it warns only. `docker-compose.yml` defaults it to the disk-backed `takeout-staging` named volume.
- Daten-view mobile-warning breakpoint — viewport width (CSS px) below which the Export and Import dialogs render the large-transfer warning (`"… Downloads können sehr groß sein."` / `"… Importe können sehr groß sein."`). Default 480; non-blocking — the user may proceed regardless ([ui/daten.md §8.11.1](ui/daten.md#8111-export), [§8.11.2](ui/daten.md#8112-import))
- Attachment orphan-reaper TTL — age of a `status = 'pending'` attachment row past which the scheduled reaper removes the row and its backing objects (default 15 minutes; [data-model.md §6.11](data-model.md#611-attachment-orphan-reaper)). Env var: `ATTACHMENT_ORPHAN_REAPER_TTL_MINUTES`
- Attachment hidden-reaper TTL — age past `hiddenAt` past which the scheduled reaper hard-deletes the `status = 'hidden'` row (default 2 days; [data-model.md §6.12](data-model.md#612-attachment-hidden-reaper)). Equal to `L` by construction. Env var: `ATTACHMENT_HIDDEN_REAPER_TTL_MINUTES` (minutes; default `2880`)
- Attachment presigned-URL expiry — lifetime of upload (presigned-PUT) and download (presigned-GET) URLs issued by the attachment surface (default 5 minutes; [api.md §14.2.11](api.md#14211-attachments))
- Attachment worker self-delete grace — elapsed window since upload during which a worker may delete their own attachment (default 15 minutes; outside the window worker delete is rejected with `403 NOT_PERMITTED`; [verification.md AC-215](verification.md#1526-attachments)). Env var: `ATTACHMENT_WORKER_SELF_DELETE_GRACE_MINUTES`
- Attachment label catalog — the closed enum `AttachmentLabel` ([data-model.md §5.13](data-model.md#513-attachment)) paired with its German display strings: `angebot` → `Angebot`, `auftragsbestaetigung` → `Auftragsbestätigung`, `rechnung` → `Rechnung`, `aufmass` → `Aufmaß`, `foto` → `Foto`, `sonstiges` → `Sonstiges`. Adding a label is a code change plus a migration (parity with the notification-event catalog).
- Attachment upload CTA labels — German copy for the upload affordance on the project detail page ([ui/project-detail.md §8.15.4](ui/project-detail.md#8154-photo-gallery), [§8.15.5](ui/project-detail.md#8155-binary-list)): the camera-capture CTA (`Foto aufnehmen`), the drop-zone text, the explicit-browse labels, and the retry / dismiss actions. Kept alongside the other `German UI and error strings` — listed here because the CTAs are referenced by capability statements elsewhere in the spec.
- Attachment client-encoding parameters — image-longest-edge, image-quality, thumbnail-longest-edge, thumbnail-quality; applied by the browser pipeline before upload ([ui/project-detail.md §8.15.4](ui/project-detail.md#8154-photo-gallery))
- Compliance retention `R` (days) — bucket default retention auto-applied per upload ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)). Sized for the operator-mistake recovery window. Env var: `STORAGE_OBJECT_LOCK_DAYS`. The dev compose stack mirrors the prod B2 setting via the same var.
- Lifecycle hide-to-delete `L` (days) — `daysFromHidingToDeleting` on the bucket lifecycle rule. The Papierkorb trash window: a hidden version is reaped exactly `L` days after the hide marker lands. Env var: `STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS`. **Invariant: `R ≤ L`** — `R > L` is incoherent on its face: lifecycle would attempt to reap noncurrent versions still protected by Object Lock, leaving zombie versions on every reap cycle until `R` elapsed. The boot-time safety probe refuses to start under `R > L` ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- Binary attachment public recipient — operator-managed `age` X25519 public recipient string used by the server to wrap per-blob DEKs into the attachment row's `wrappedDek` / `wrappedThumbDek` envelope ([data-model.md §5.13](data-model.md#513-attachment), [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)). No default — the deploy must supply a value; absence aborts the pre-flight configuration check. Env var: `BINARY_AGE_RECIPIENT`. The matching private identity is operator-loaded into a tmpfs mount on the `app` service (parallel surface to backup; see [§11.4](#114-object-storage-module) "Operator-loaded binary identity") and the boot probe ([§11.4](#114-object-storage-module) "Boot-time safety probes") refuses to start when the loaded identity's derived recipient does not match this value. The matching private key never appears anywhere else and is not a `[C]` value — the recipient string in this catalogue is what couples the deployed app to the operator's keypair.

**Deliberately not `[C]`.** `src/server/config/env.ts` declares variables this catalogue does not list. They are settable, but they are not company settings:

- **Scheduler sweep cadences** — `SESSION_CLEANUP_INTERVAL_MINUTES`, `AUDIT_RETENTION_INTERVAL_MINUTES`, `ATTACHMENT_ORPHAN_REAPER_INTERVAL_MINUTES`, `ATTACHMENT_HIDDEN_REAPER_INTERVAL_MINUTES`. How _often_ a reaper sweeps is operational tuning; the retention window it enforces is the company-facing value, and that one is catalogued.
- **Deployment wiring and secrets** — database and object-store endpoints, buckets and credentials, `PORT`, `DOMAIN`, `NODE_ENV`, `SEED`, `ALLOW_INSECURE_HTTP`, VAPID keys, `BOOTSTRAP_ADMIN_*`, the LLM provider key and model id, and the `*_IDENTITY_PATH` mount points for operator-loaded private keys.

A variable's absence here is a claim that no company would need to change it. If one does, the fix is to add the entry — not to treat the catalogue as advisory.

- Invoice Object Lock retention — `INVOICE_OBJECT_LOCK_DAYS`, the bucket default retention (days) applied to every rendered invoice PDF/A-3 binary descriptor. Default `3650` in `.env.production.example` (10 years per §147 AO); `0` in `.env.example` so dev deployments can clean binaries freely. Bounds: integer ≥ 0. The boot-time bucket-safety probe ([§11.4](#114-object-storage-module)) refuses to start when the deployed bucket retention envelope is below this value (under-retention is the data-integrity failure; over-retention is accepted). `0` disables the assertion entirely. Independent of `STORAGE_OBJECT_LOCK_DAYS` (attachment retention) — invoices have a separate legal retention horizon. See [§11.14](#1114-invoice-domain), [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md).
- Company default tax mode — `company_profile.defaultTaxMode` ∈ `'standard' | 'kleinunternehmer' | 'reverse_charge'`; pre-fills new invoice drafts with the tenant's most common mode ([data-model.md §5.17](data-model.md#517-company-profile-entity)). Owner-editable at runtime through the Daten view's company-profile form ([ui/daten.md §8.11.4](ui/daten.md#8114-company-profile)); not an env var. Listed here because it is a per-tenant default that the deployment owner sets, not a per-user preference. Default `'standard'` on the pre-seeded singleton.

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
- State type distinction (action/buffer) visually obvious at a glance.

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
5. **Rate limiting**: configured on authentication endpoints (login, password change) and push-subscription mutations (see [api.md §14.2.10](api.md#14210-push-subscription) and §12.2 Rate limit buckets **[C]**). Other mutation endpoints are not rate-limited — at current scale with VPN-only access ([ADR-0008](../adr/0008-vpn-first-network-access.md)), this is a known, accepted limitation.
6. **CSRF protection**: mechanism defined in [ADR-0005](../adr/0005-session-management-httponly-cookies.md).
7. **Password handling**: never log or store plaintext (see [ADR-0006](../adr/0006-password-policy-nist-blocklist.md)).
8. **Ownership derivation on self-scoped surfaces**: on caller-owned resources (e.g., push subscriptions — [api.md §14.2.10](api.md#14210-push-subscription)), the server derives the owning user id from the session; a client-supplied owner id is ignored.
