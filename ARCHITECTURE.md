# Architecture

Navigation guide to the implementation. Use it to locate modules, understand dependency rules, and find the right file before diving into code. Not a substitute for reading the code itself.

For the full product specification, see [docs/spec/](docs/spec/index.md). `AC-NNN` references throughout point to numbered Acceptance Criteria in [verification.md §15](docs/spec/verification.md#15-acceptance-criteria).

**Length — a standing D-BLSI exception** ([review/conventions-docs-general.md](review/conventions-docs-general.md)). An index is worth reading because one file answers "where does this live?" for the whole tree; splitting it by section puts half the answers behind a link and reintroduces the drift the [§ Module Map](#module-map) gate exists to catch. Depth is what is delegated instead: [docs/spec/](docs/spec/index.md) and [docs/adr/](docs/adr/index.md) carry the reasoning, this file the map.

## Contents

- [Tech Stack](#tech-stack)
- [Architecture Overview](#architecture-overview)
- [Module Map](#module-map)
  - [Directory Detail](#directory-detail)
  - [Directory Notes](#directory-notes)
  - [Configuration Files](#configuration-files)
- [Request Lifecycle](#request-lifecycle)
- [API Surface](#api-surface)
  - [Endpoint Notes](#endpoint-notes)
  - [API Surface Generation](#api-surface-generation)
  - [OpenAPI Document Generation](#openapi-document-generation)
  - [Error-Code Catalogue](#error-code-catalogue)
- [Permission Gating](#permission-gating)
- [How to Extend](#how-to-extend)
  - [Adding a new entity](#adding-a-new-entity-eg-supplier)
  - [Adding a new view](#adding-a-new-view-eg-worker-view)
  - [Adding a new API endpoint](#adding-a-new-api-endpoint)
  - [Adding a new workflow state](#adding-a-new-workflow-state)
  - [Adding a new SSE event](#adding-a-new-sse-event)
  - [Seeding modes](#seeding-modes)
- [Infrastructure](#infrastructure)
  - [Docker Compose (production)](#docker-compose-production)
  - [CI/CD Pipeline](#cicd-pipeline)
- [Attachments Module](#attachments-module)
- [Invoices Module](#invoices-module)
- [Design Decisions (Not ADR-Worthy)](#design-decisions-not-adr-worthy)
- [Links](#links)

---

## Tech Stack

| Technology    | Version       | Purpose                                                          | Docs                                                                |
| ------------- | ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| TypeScript    | 6.0           | Language (strict, shared client+server)                          | [typescriptlang.org](https://www.typescriptlang.org/)               |
| React         | 19            | UI rendering                                                     | [react.dev](https://react.dev/)                                     |
| Vite          | 8             | Dev server, bundler, HMR                                         | [vite.dev](https://vite.dev/)                                       |
| Zustand       | 5             | Client-side state management                                     | [zustand](https://github.com/pmndrs/zustand)                        |
| React Router  | 8             | Client-side routing                                              | [reactrouter.com](https://reactrouter.com/)                         |
| Fastify       | 5             | HTTP server and API framework                                    | [fastify.dev](https://fastify.dev/)                                 |
| Drizzle ORM   | 0.45          | Type-safe SQL, schema, migrations                                | [orm.drizzle.team](https://orm.drizzle.team/)                       |
| PostgreSQL    | 17            | Relational database                                              | [postgresql.org](https://www.postgresql.org/)                       |
| Backblaze B2  | S3-compatible | Object/file storage (prod) — versioning + Compliance Object Lock | [backblaze.com/b2](https://www.backblaze.com/b2/cloud-storage.html) |
| MinIO         | S3-compatible | Object/file storage (dev mirror)                                 | [min.io](https://min.io/)                                           |
| Cloudflare R2 | S3-compatible | Encrypted DB-backup destination (Layer 2)                        | [r2 docs](https://developers.cloudflare.com/r2/)                    |
| Caddy         | 2             | Reverse proxy, automatic HTTPS                                   | [caddyserver.com](https://caddyserver.com/)                         |
| Vitest        | 4             | Unit and component tests                                         | [vitest.dev](https://vitest.dev/)                                   |
| Playwright    | 1.60          | End-to-end tests                                                 | [playwright.dev](https://playwright.dev/)                           |
| lychee        | 0.24          | Markdown link + anchor resolution in CI                          | [lychee](https://github.com/lycheeverse/lychee)                     |

Stack decisions are recorded in ADRs: [ADR-0002](docs/adr/0002-tech-stack-typescript-react-vite-zustand.md) (frontend), [ADR-0003](docs/adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md) (infra), [ADR-0004](docs/adr/0004-backend-stack-fastify-drizzle-node-postgres.md) (backend).

---

## Architecture Overview

Seven responsibility layers. Dependency flows left-to-right only, never reversed. The split on the server between **Services** and **Routes** is load-bearing — routes never touch repositories or db/schema directly; they delegate to services. See [spec §11.2](docs/spec/architecture.md#112-responsibility-boundaries) for the authoritative contract.

```
  config  <--  domain  <--  storage  <--  services  <--  routes
                        <--  state   <--  ui

  src/config/         src/domain/    src/server/repositories/   src/server/services/   src/server/routes/
                                     src/server/storage/                               src/server/middleware/
                                                                                       src/state/
                                                                                       src/ui/
```

- **Config** and **Domain** are shared: both server and client import them.
- **Storage**, **Services**, **Routes** run server-side only.
- **State**, **UI** run client-side only.

**Enforcement**: the layer rules are machine-enforced by `no-restricted-imports` zones in [`eslint.config.js`](eslint.config.js). A PR that reaches from `src/ui/**` into `src/server/**`, from `src/server/routes/**` into `src/server/repositories/**`, or from `src/domain/**` into any higher layer fails lint. Type-only imports of `Database` from `src/server/db/connection` are allowed in route files because routes take the connection as a typed parameter.

---

## Module Map

Each `Owns` cell is a one-line summary. Below it, [§ Directory Detail](#directory-detail) carries the file list for the directories where the set of files _is_ the architecture, and [§ Directory Notes](#directory-notes) carries what a filename cannot tell you about the rest.

| Directory                      | Owns                                                                                                                                                   | Must NOT                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `src/config/`                  | Deployment-tunable constants and catalogs. Every `[C]` value is indexed in [§ Configuration Files](#configuration-files).                              | Import anything outside `src/config/`                   |
| `src/domain/`                  | Framework-free types and pure rules: transitions, aging, summaries, dates, envelopes, image pipeline.                                                  | Import from state, API, storage, or UI                  |
| `src/server/config/`           | Env validation (Zod), centralized policy constants (auth, rate limits, storage), VAPID key material.                                                   | Contain business logic or import from layers above      |
| `src/server/db/`               | Drizzle schema, connection, SQL migrations, named constraints (`constraints.ts`).                                                                      | Contain business logic                                  |
| `src/server/services/`         | Business logic orchestration — one service per entity, plus the audit, backup, notification, attachment, key-envelope, invoice and takeout subsystems. | Know about HTTP, Fastify, or request objects            |
| `src/server/services/invoice/` | The EN 16931 e-invoicing core (ADR-0026) — Factur-X builder, PDF/A-3 drawer, payload crypto, XSD validation.                                           | Know about HTTP, Fastify, or request objects            |
| `src/server/repositories/`     | Database queries, one module per entity, plus the role-based read-scope predicates.                                                                    | Know about HTTP or contain business rules               |
| `src/server/storage/`          | S3/MinIO client, presign / upload / download / hide / restore ops, boot-time safety probes.                                                            | Be called outside routes and `start.ts` (client wiring) |
| `src/server/middleware/`       | Cookie parsing, session auth, request decoration.                                                                                                      | Contain route handlers or business logic                |
| `src/server/routes/`           | Route definitions, request validation, response serialization.                                                                                         | Access repositories directly (must go through services) |
| `src/server/sse/`              | In-process SSE bus — typed pub/sub fan-out to subscribed connections.                                                                                  | Know about HTTP, Fastify, or request objects            |
| `src/server/seed/`             | Seed data split per data class, shipped through the public restore contract.                                                                           | Contain app logic; run in production                    |
| `src/server/data/`             | Static data files (e.g. common-passwords list).                                                                                                        | Contain logic or import from other modules              |
| `src/server/` (root files)     | App assembly, entry point, bootstrap, schedulers and reapers, error factories.                                                                         | -                                                       |
| `src/state/`                   | Zustand stores (one per domain slice), barrel re-export, client-side cache.                                                                            | Access the database or import server code               |
| `src/sse/`                     | Browser-side SSE primitive — `onSseEvent` over an `EventSource`.                                                                                       | Contain business logic or import server code            |
| `src/api/`                     | Centralized API client, typed fetch wrappers.                                                                                                          | Contain business logic or UI concerns                   |
| `src/hooks/`                   | Shared React hooks (transitions, routing, permission gating).                                                                                          | Contain API calls directly (must use stores)            |
| `src/pwa/`                     | Web Push client-side plumbing and the service-worker bundle.                                                                                           | Contain business logic; import server code              |
| `src/ui/`                      | React components, grouped by feature area.                                                                                                             | Contain business logic beyond dispatching to state      |
| `src/test/`                    | Shared test setup, API test helpers, and seed fixtures.                                                                                                | Be imported in production code                          |

### Directory Detail

**A subsection here is a coverage contract**: every source file directly inside that directory is named, and `scripts/check-module-map.sh` (AC-350) fails the build on a file it omits or a name whose file is gone. Adding a `#### <dir>` heading is the act of accepting that contract; the document's own structure is the checker's configuration, so no parallel list exists.

The contract binds every file, with nothing held back. The baseline that froze the pre-existing gap while it was burned down (#306) reached zero and is gone, so a new file in a gated directory fails the build until it is named here. Opting a directory out is still allowed, but not silently: the gated set is recorded in `scripts/module-map-gated.txt`, and dropping a subsection fails until that line goes too. Deleting or emptying the record is not a way around that: it is a required input.

A directory earns a subsection when the _set_ of files is itself architecture and a missing one is a missing subsystem. Everywhere else a complete file list would be inventory rather than architecture, and what is worth saying about those directories is in [§ Directory Notes](#directory-notes) below.

#### `src/server/routes/`

- `auth.ts` — login / logout / `me` / change-password. The only module that sets the session cookie; `POST /api/auth/login` and `GET /api/auth/me` both carry the owner-only backup badge, omitting the field rather than faking a value when the status row is unreachable (AC-176). The two session-establishment paths are kept symmetric; the reason is in [api.md §14.2.7](docs/spec/api.md#1427-backup-status).
- `users.ts` — user CRUD, deactivate / reactivate, admin password reset
- `workers.ts` — the assignee pool. Separate from `users.ts` because it is gated by `project:read` rather than admin-only `user:read`, and returns only `{userId, displayName}` so no admin-only field can leak into a filter dropdown.
- `customers.ts` — customer CRUD
- `projects.ts` — project CRUD, forward / backward transitions, date edits, archive, restore and purge; delegates to the three services behind `src/server/services/project.ts`
- `invoices.ts` — per-project draft CRUD plus issue / cancel / PDF download, the bulk export and the year list (ADR-0026). The PDF handler unwraps the row's DEK server-side and returns the plaintext in the response body rather than a presigned GET. `POST /api/invoices/export` is the ZIP takeout: every PDF is decrypted _before_ the first header is written, because once `archiver` starts writing a fault can only be a truncated stream — hence the 5000-invoice cap on both request shapes. Drafts never enter the archive: 422 `DRAFT_NOT_EXPORTABLE` in ids-mode, silently omitted in filter-mode.
- `company-profile.ts` — singleton `GET` + owner-only `PUT`. `POST` and `DELETE` are deliberately unregistered — the row is a DB-enforced singleton. The owner check is inline because the spec allocates no `company_profile:*` permission key.
- `audit.ts` — read-only list + get-by-id, with the three-way 200 / 403 / 404 result; response shaping lives in `AuditService` — by actor kind, not by role — scope in the repository predicates
- `extract.ts` — `POST /api/extract`, LLM email-to-structured-data via OpenRouter (ADR-0016)
- `notification-rules.ts` — CRUD for notification rules (ADR-0023)
- `push-subscriptions.ts` — subscribe/unsubscribe VAPID endpoints
- `push.ts` — VAPID public-key endpoint
- `health.ts` — `GET /api/health`; delegates to the probe in `src/server/health.ts`
- `attachments.ts` — init / complete / delete / list / download-url / `bulk-fetch` under `/api/projects/:id/attachments/…`
- `storage-usage.ts` — `GET /api/projects/:id/storage-usage` and `GET /api/storage-usage` per [api.md §14.2.12](docs/spec/api.md#14212-storage-usage)
- `events.ts` — `GET /api/events` SSE channel per [api.md §14.2.13](docs/spec/api.md#14213-realtime-events) and ADR-0025
- `export-jobs.ts` / `import-jobs.ts` — server-side full-account takeout: `POST /api/export-jobs` / `POST /api/import-jobs` plus status, Range-capable download, and resumable-upload endpoints per [api.md §14.2.4](docs/spec/api.md#1424-unified-data-exchange), ADR-0018/0024

#### `src/server/services/invoice/`

The EN 16931 e-invoicing core (ADR-0026). Gated on its own rather than inherited from `src/server/services/`: coverage reaches direct children only, so a nested directory is invisible until it takes a subsection.

- `facturXmlBuilder.ts` — the embedded `factur-x.xml` (CII, Comfort profile). A hand-rolled serializer, because EN 16931 pins element order; the snapshotted tax mode selects the CategoryCode and the statutory exemption reason, both mapped in `boilerplate.ts`.
- `pdfDrawer.ts` — the human-readable A4 body the XML rides in. Standard-14 fonts only, so the glyph repertoire is WinAnsi and anything outside it normalizes to `?` rather than crashing the encoder. Structurally correct PDF/A-3, not certified: no XMP packet is written.
- `xsdValidator.ts` — validates every render against the canonical Factur-X 1.07.2 schemas under `src/server/services/invoice/xsd/`, inside the issuance transaction. A payload that fails rolls the issuance back instead of reaching storage.
- `payloadCrypto.ts` — AES-256-GCM envelope for the rendered PDF, one single-use DEK per render. Byte-identical on the wire to the browser's `nonce(12) || ct || tag(16)` in `src/domain/clientEncryption.ts`; duplicated rather than shared because this path runs synchronously inside `mutate()`.
- `boilerplate.ts` — every per-tax-mode mapping in one place: the statutory footer paragraph, the EN 16931 CategoryCode (`S` / `E` / `AE`) and the BT-120 exemption reason. The `§ 19 UStG` / `§ 13b UStG` anchors are pinned by AT-116; the German copy around them is not. `standard` mode has no paragraph and no exemption reason — its legal anchor is the VAT breakdown in the layout.

#### `src/server/` (root files)

- `app.ts` — app assembly
- `start.ts` — entry point
- `bootstrap.ts` — first-run admin bootstrap
- `health.ts` — health probe
- `seed.ts` — seed orchestrator, delegates to `src/server/seed/`
- `password.ts` — password hashing; thin `bcryptjs` wrapper. bcrypt's silent 72-UTF-8-byte truncation is fenced off by the ceiling in `src/server/config/password-policy.ts`.
- `staticCache.ts` — the `@fastify/static` registration plus its three Cache-Control tiers: content-hashed `/assets/*` immutable for a year, `index.html` and `sw.js` no-cache so deploys propagate, everything else a day.
- `deploy-preflight-cli.ts` — the binary behind the configuration boundary's deploy checkpoint ([§ Design Decisions](#design-decisions-not-adr-worthy)): a one-shot container on the pulled image that probes env, storage reachability and the upload / copy verbs, so a credential or provider failure aborts the deploy while the previous replica is still running (AC-230/231).
- `periodicSweeper.ts` — the shared factory behind the four retention and reaper schedulers: timer drive, overlap guard, sustained-failure backoff, and a `stop()` that drains the in-flight sweep. Deliberately topology-agnostic — the single-process invariant (ADR-0021) lives on its callers, not here.
- `session-reaper.ts` — periodic session reaper. Predates the factory above and still carries its own copy of that plumbing.
- `audit-retention-scheduler.ts` — audit retention scheduler (ADR-0021)
- `attachment-orphan-reaper-scheduler.ts` — attachment orphan reaper scheduler
- `attachment-hidden-reaper-scheduler.ts` — hidden-attachment reaper scheduler ([data-model.md §6.12](docs/spec/data-model.md#612-attachment-hidden-reaper))
- `takeout-staging-reaper-scheduler.ts` — takeout staging reaper scheduler ([data-model.md §6.15](docs/spec/data-model.md#615-takeout-staging-reaper)). Schedule only; the sweep itself is a service one layer down, listed in [§ Directory Notes](#directory-notes).
- `threshold-monitor-scheduler.ts` — threshold monitor scheduler ([architecture.md §11.15](docs/spec/architecture.md#1115-threshold-monitor)). Schedule only; the evaluator is a service one layer down, listed in [§ Directory Notes](#directory-notes).
- `backup-runner.ts` — Layer 2 backup CLI entry with `schedule` / `run` / `drill` subcommands. `schedule` is the `backup` container's PID 1 and registers the cron jobs via croner, per ADR-0020.
- `errors.ts` — error factories: `notFound()`, `validationError()`, `bulkLimitExceeded()`, etc. return `AppError` instances
- `error-handler.ts` — the global error and 404 handlers that turn those into responses. The 4xx pass-through rule is in [§ Design Decisions](#design-decisions-not-adr-worthy).
- `format-error-chain.ts` — walks `err.cause` so a wrapped driver failure surfaces its real cause and SQLSTATE, instead of drizzle's bare `Failed query: …`. Used by the startup catch and by the process-level handlers, both in `start.ts`.

### Directory Notes

What a filename does not tell you: disambiguation, invariants, and negative space. **No entry here claims to be a complete file list** — for that, read the directory. An entry exists because something about it would otherwise surprise you; a file with nothing surprising about it is deliberately absent.

Every entry is keyed by a directory, and `scripts/check-module-map.sh` resolves the names it cites — with or without a source extension — under that key. So a note cannot outlive the file it describes, and cannot be propped up by a same-named file elsewhere: `events.ts` under `src/server/services/` means that file, not the sibling the entry exists to distinguish it from.

**`src/config/`** — deployment-tunable values are indexed in [§ Configuration Files](#configuration-files) below; that table is the single list. `sseEvents.ts` is not one of them: it is the realtime SSE event catalog, the wire vocabulary shared by `src/server/sse/` and `src/sse/`, and its `SSE_EVENT_NAMES` backs the AC-338 subscriber-coverage guard.

**`src/domain/`** — framework-free types and pure rules. `imagePipeline.ts` is the client-side downscale + WebP thumbnail pass, preserving EXIF via an `@uploadcare/image-shrink` byte-splice. `dataExchange.ts` holds the unified envelope contract (ADR-0018), `attachments.ts` the label catalog + MIME whitelist + delete-gate helper, `auditRowDescription.ts` the action-to-German one-liner derivation.

**`src/server/config/`** — as above, [§ Configuration Files](#configuration-files) is the single list. `vapid.ts` is the exception: VAPID key-material resolver, deriving the public key from the private one and auto-bootstrapping in dev.

**`src/server/services/`** — one service per entity or concern, plus subsystems. What the filenames hide:

- `mutate.ts` — the single write path for audited tables (ADR-0021). Nothing else may write them.
- `events.ts` — the **domain** event bus: process-local pub/sub for audit and notifications. Not the SSE pair `src/server/routes/events.ts` / `src/server/sse/`, which is a different mechanism with a colliding name.
- `KeyEnvelopeService.ts` — DEK envelope wrap/unwrap against the operator-loaded binary `age` identity (ADR-0024). The entire crypto perimeter on B2 ciphertext.
- `backup.ts`, `backup-drill.ts`, `ephemeralPg.ts`, `r2Uploader.ts` — the Layer 2 backup pipeline (ADR-0020), four files that only make sense together.
- `threshold-monitor.ts` — evaluates the backup-badge state and global storage fill on a timer and publishes `backup.failed` / `disk.threshold_reached` ([architecture.md §11.15](docs/spec/architecture.md#1115-threshold-monitor)). It lives here, not in the `backup` container, because the notification publisher binds in the `app` process; a publish from the runner would reach an unbound publisher. Its scheduler is `src/server/threshold-monitor-scheduler.ts`, one layer up.
- `DataExchangeJobService.ts`, `takeout-export-builder.ts`, `takeout-export-runner.ts`, `takeout-import-runner.ts`, `takeout-staging.ts`, `takeout-staging-reaper.ts`, `data-exchange-boot-reaper.ts` — the server-side takeout subsystem (ADR-0018/0024): job lifecycle, archive build, VPS staging and the two reapers that sweep it. Its scheduler is `src/server/takeout-staging-reaper-scheduler.ts`, one layer up.
- The invoice service layer — the `InvoiceService.ts` facade plus four focused services — is listed in [§ Invoices Module](#invoices-module); that section is the single list.
- Bulk download has **no** server-side orchestrator, reaper or scheduler (ADR-0024 § Decision "Bulk download") — the per-file `bulk-fetch` route returns DEK material + presigned GETs and the browser assembles the zip locally via streaming-zip. Absence here is a decision, not a gap.

**`src/server/repositories/`** — one module per entity, project split by concern behind a `project.ts` barrel. Write functions on audited tables accept `MutatingDatabase` (a transaction-only handle — see `src/server/db/connection.ts`) so a caller bypassing `mutate()` fails `tsc`. `scope.ts` holds the role-based read-scope predicates, including the two audit predicates and the attachment predicate (ADR-0019).

**`src/server/storage/`** — `client.ts` carries the `AttachmentStorageClient` surface: `createPresignedPut` (browser uploads; signs Content-Type + Content-Length + Content-MD5 via SigV4 against ciphertext metadata per ADR-0024 — `Content-Type` at the call site is the sentinel `application/octet-stream`, not the plaintext MIME), `createPresignedGet` with optional attachment-disposition filename, plus `headObject` / `getObject` / `putObject` / `listObjects` / `hide` / `copyFromVersion` / `getBucketSafetyConfig`. `safety.ts` runs the boot-time bucket-safety and binary `age`-identity probes.

**`src/server/middleware/`** — `auth.ts` exports `createAuthMiddleware` (cookie-only session validation, applied as a plugin-level `preHandler` on every authenticated route) and `requirePermission` (role→permission check per route).

**`src/server/sse/`** — typed pub/sub fan-out over its own transport-agnostic `SseConnection` interface (`write`, optional `onClose`), one entry per subscribed connection populated by the `/api/events` route handler. Owns the subscriber set, per-subscriber failure isolation, and the post-commit emit primitive consumed by `AttachmentService.completeUpload` / `hide` / `restore` and the `attachment-hidden-reaper`. Spec contract: [architecture.md §11.13](docs/spec/architecture.md#1113-realtime-invalidation-channel), [api.md §14.2.13](docs/spec/api.md#14213-realtime-events), ADR-0025.

**`src/server/seed/`** — `business.ts` assembles the full envelope (users, company_profile, customers, projects, assignments) and ships it through `ImportService.import` in one call, so every seed run exercises the public restore contract for every envelope slot. Only `src/test/api-helpers.ts` retains a direct-DB user insert, for unit-setup speed.

**`src/state/`** — one Zustand store per domain slice, a `store.ts` barrel, the client-side cache, and one `*SseSubscription` module per realtime-invalidated slice. `storageUsageStore` is the odd one: a shared subscription / refresh-trigger fan-in for the Footer badge and the DatenView storage row, owning the fetch lifecycle for `GET /api/storage-usage`.

**`src/sse/`** — `client.ts` exposes `onSseEvent` over an `EventSource` opened against `/api/events`. Auto-reconnect uses the WHATWG default; cookies ride along automatically. Spec contract: [api.md §14.2.13](docs/spec/api.md#14213-realtime-events), ADR-0025.

**`src/pwa/`** — `pushClient.ts` handles subscribe/unsubscribe, VAPID public-key fetch and the permission prompt. The service worker is a separate bundle: `src/sw/index.ts` → `dist/sw.js`, dev-served at `/sw.js` (push event handler → `showNotification`).

**`src/ui/`** — components grouped by feature area: `audit`, `auth`, `calendar`, `common`, `detail`, `extraction`, `kanban`, `layout`, `management`. The one non-obvious split is project detail: `src/ui/detail/ProjectDetailPage.tsx` is the full page at `/projects/:id`, while `ProjectDetailPanel.tsx` stays as the quick-glance overlay on Kanban/Calendar and exposes an `Öffnen` affordance to the page.

### Configuration Files

Maps spec `[C]` markers (values that vary per deployment) to files. For how operator-supplied env vars are validated and what happens when one is missing, see [Design Decisions § Configuration boundary](#design-decisions-not-adr-worthy) below and [spec architecture.md §12](docs/spec/architecture.md#12-configuration-boundaries).

| What                                                                       | File                                   |
| -------------------------------------------------------------------------- | -------------------------------------- |
| App name, branding, footer text, brand accent (light + dark)               | `src/config/brandingConfig.ts`         |
| Color design tokens — primitive palette, semantic tokens, dark overrides   | `src/styles/tokens.css`                |
| Workflow states (labels, colors, order, aging thresholds, collapse tiers)  | `src/config/stateConfig.ts`            |
| German UI and error strings                                                | `src/config/strings.ts`                |
| Date and locale display settings                                           | `src/config/localeConfig.ts`           |
| Insecure-connection detection                                              | `src/config/insecureConnection.ts`     |
| Password policy (min length, max bytes, blocklist)                         | `src/server/config/password-policy.ts` |
| Session duration, rate-limit windows                                       | `src/server/config/index.ts`           |
| Role set and per-role permission matrix                                    | `src/config/permissions.ts`            |
| Per-view nav + route-guard rules (URL ↔ view ↔ access rule)                | `src/config/routes.ts`                 |
| Backup-freshness thresholds (amber/red days for backup and drill)          | `src/config/backupThresholds.ts`       |
| Threshold-monitor policy (storage warn band, hysteresis, sweep, re-notify) | `src/config/thresholdMonitor.ts`       |
| Destructive-restore confirmation phrase                                    | `src/config/dataExchangeConfig.ts`     |
| Theme preference local-storage key                                         | `src/config/themeStorage.ts`           |
| Audit retention window (ADR-0021)                                          | `src/config/auditRetention.ts`         |
| Audit action → German label map                                            | `src/config/auditActionLabels.ts`      |
| Audit list page size                                                       | `src/config/auditPageSize.ts`          |
| Notification event catalog + German labels (ADR-0023)                      | `src/config/notificationEvents.ts`     |
| Push-dispatch latency budget                                               | `src/config/pushDispatch.ts`           |
| Role keys (typed `AccountRoleKey` enum)                                    | `src/config/roleKeys.ts`               |
| Attachment server caps (size, bulk, reaper TTL, worker self-delete grace)  | `src/config/attachmentConfig.ts`       |
| Attachment client pipeline params (resize, quality, thumbnail dimension)   | `src/config/attachmentPipeline.ts`     |
| Realtime SSE heartbeat interval (default 25 s, bounded 1 s–600 s)          | `src/server/config/env.ts`             |
| Seed default password                                                      | `src/test/seedAssumptions.ts`          |

---

## Request Lifecycle

```
Browser (React)
  |  user action triggers Zustand store method
  v
Zustand store
  |  fetch("/api/projects/42/transition", { method: "POST", ... })
  v
Vite dev proxy  (dev: localhost:5173 -> :3000)
Caddy           (prod: HTTPS termination, reverse_proxy -> app:3000)
  v
Fastify
  |  trustProxy = TRUSTED_PROXY_CIDRS -> request.ip
  |  @fastify/cookie parses session cookie
  |  auth middleware validates session via session repository
  |  -> 401 if missing/expired
  v
Route handler (src/server/routes/)
  |  validates request body (Fastify JSON schema)
  |  delegates to service
  v
Service (src/server/services/)
  |  business logic, domain validation
  |  calls repository for data access
  v
Repository (src/server/repositories/) -> Drizzle ORM -> PostgreSQL
  |  query executes, returns rows
  v
Route handler
  |  serializes response as JSON
  v
Fastify -> Caddy/proxy -> Browser
  v
Zustand store
  |  updates local state on success
  v
React re-renders affected components
```

**Client IP attribution.** `request.ip` keys the login rate limiter and the login audit trail, so it must be the client — not Caddy. Fastify believes `X-Forwarded-For` only from the addresses in `TRUSTED_PROXY_CIDRS`, which names the `networks.default` subnet pinned in `docker-compose.yml` (`172.16.0.0/16`); that subnet is pinned precisely so the trust boundary has a fixed address to name, and it is disjoint from the WireGuard client range (ADR-0008). Unset means trust nothing — correct for dev, which bypasses Caddy — and the app refuses to start in production without it, because the silent fallback attributes every request to the proxy and collapses the rate limiter into one global bucket.

> Not a hop count. Fastify 5.12.1 removed the numeric `trustProxy` form (GHSA-3m5p-2c4r-xxw2): a hop count never validated _which_ peer connected.

---

## API Surface

All HTTP endpoints exposed by the Fastify server. Concrete URL structure lives here because [`docs/spec/api.md`](docs/spec/api.md) is intentionally stack-agnostic (operations, inputs, outputs — not URLs).

<!-- GENERATED:api-surface:START — generated from the routes buildApp() registers (src/server/app.ts); do not hand-edit. See § API Surface Generation below (AC-352). -->

| Method                   | Path                                                | Auth    | Access                 | Rate limit    |
| ------------------------ | --------------------------------------------------- | ------- | ---------------------- | ------------- |
| OPTIONS                  | `*`                                                 | none    | —                      | none          |
| GET                      | `/api/health`                                       | none    | —                      | none          |
| POST                     | `/api/auth/login`                                   | none    | —                      | 5 / 1 minute  |
| POST                     | `/api/auth/logout`                                  | session | —                      | none          |
| GET                      | `/api/auth/me`                                      | session | —                      | none          |
| PATCH                    | `/api/auth/me`                                      | session | —                      | none          |
| POST                     | `/api/auth/change-password`                         | session | `auth:change-password` | 5 / 1 minute  |
| GET                      | `/api/projects`                                     | session | `project:read`         | none          |
| POST                     | `/api/projects`                                     | session | `project:create`       | none          |
| GET                      | `/api/projects/:id`                                 | session | `project:read`         | none          |
| POST                     | `/api/projects/:id/transition/forward`              | session | `project:transition`   | none          |
| POST                     | `/api/projects/:id/transition/backward`             | session | `project:transition`   | none          |
| PATCH                    | `/api/projects/:id/dates`                           | session | `project:dates`        | none          |
| PATCH                    | `/api/projects/:id`                                 | session | `project:update`       | none          |
| DELETE                   | `/api/projects/:id`                                 | session | `project:delete`       | none          |
| DELETE                   | `/api/projects/:id/purge`                           | session | `project:purge`        | none          |
| POST                     | `/api/projects/:id/restore`                         | session | `project:delete`       | none          |
| GET                      | `/api/customers`                                    | session | `customer:read`        | none          |
| GET                      | `/api/customers/:id`                                | session | `customer:read`        | none          |
| POST                     | `/api/customers`                                    | session | `customer:write`       | none          |
| PATCH                    | `/api/customers/:id`                                | session | `customer:write`       | none          |
| DELETE                   | `/api/customers/:id`                                | session | `customer:delete`      | none          |
| GET                      | `/api/users`                                        | session | `user:read`            | none          |
| GET                      | `/api/users/:id`                                    | session | `user:read`            | none          |
| POST                     | `/api/users`                                        | session | `user:manage`          | none          |
| PATCH                    | `/api/users/:id`                                    | session | `user:manage`          | none          |
| DELETE                   | `/api/users/:id`                                    | session | `user:delete`          | none          |
| POST                     | `/api/users/:id/deactivate`                         | session | `user:manage`          | none          |
| POST                     | `/api/users/:id/reactivate`                         | session | `user:manage`          | none          |
| POST                     | `/api/users/:id/reset-password`                     | session | `user:manage`          | none          |
| GET                      | `/api/workers`                                      | session | `project:read`         | none          |
| POST                     | `/api/export-jobs`                                  | session | `data:export`          | none          |
| GET                      | `/api/export-jobs`                                  | session | `data:export`          | none          |
| GET                      | `/api/export-jobs/:id`                              | session | `data:export`          | none          |
| GET                      | `/api/export-jobs/:id/download`                     | session | `data:export`          | none          |
| POST                     | `/api/import-jobs`                                  | session | `data:restore`         | none          |
| GET                      | `/api/import-jobs`                                  | session | `data:restore`         | none          |
| GET                      | `/api/import-jobs/:id`                              | session | `data:restore`         | none          |
| HEAD                     | `/api/import-jobs/:id/archive`                      | session | `data:restore`         | none          |
| PATCH                    | `/api/import-jobs/:id/archive`                      | session | `data:restore`         | none          |
| POST                     | `/api/extract`                                      | session | `customer:write`       | none          |
| GET                      | `/api/audit`                                        | session | `audit:read`           | none          |
| GET                      | `/api/audit/:id`                                    | session | `audit:read`           | none          |
| GET                      | `/api/notification-rules`                           | session | `notifications:manage` | none          |
| GET                      | `/api/notification-rules/:id`                       | session | `notifications:manage` | none          |
| POST                     | `/api/notification-rules`                           | session | `notifications:manage` | none          |
| PATCH                    | `/api/notification-rules/:id`                       | session | `notifications:manage` | none          |
| DELETE                   | `/api/notification-rules/:id`                       | session | `notifications:manage` | none          |
| POST                     | `/api/push-subscriptions`                           | session | —                      | 20 / 1 minute |
| DELETE                   | `/api/push-subscriptions`                           | session | —                      | 20 / 1 minute |
| DELETE                   | `/api/push-subscriptions/:id`                       | session | —                      | 20 / 1 minute |
| GET                      | `/api/projects/:id/attachments`                     | session | `attachment:read`      | none          |
| POST                     | `/api/projects/:id/attachments/init`                | session | `attachment:write`     | none          |
| POST                     | `/api/projects/:id/attachments/:attId/complete`     | session | `attachment:write`     | none          |
| DELETE                   | `/api/projects/:id/attachments/:attId`              | session | `attachment:hide`      | none          |
| GET                      | `/api/projects/:id/attachments/trash`               | session | `attachment:trash`     | none          |
| POST                     | `/api/projects/:id/attachments/:attId/restore`      | session | `attachment:trash`     | none          |
| GET                      | `/api/projects/:id/attachments/:attId/download-url` | session | `attachment:read`      | none          |
| POST                     | `/api/projects/:id/attachments/bulk-fetch`          | session | `attachment:read`      | none          |
| GET                      | `/api/projects/:id/storage-usage`                   | session | `project:read`         | none          |
| POST, PUT, PATCH, DELETE | `/api/projects/:id/storage-usage`                   | session | —                      | none          |
| GET                      | `/api/storage-usage`                                | session | `data:export`          | none          |
| POST, PUT, PATCH, DELETE | `/api/storage-usage`                                | session | —                      | none          |
| GET                      | `/api/invoices`                                     | session | —                      | none          |
| GET                      | `/api/invoices/years`                               | session | —                      | none          |
| GET                      | `/api/invoices/:id`                                 | session | —                      | none          |
| POST                     | `/api/invoices`                                     | session | `invoice:write`        | none          |
| PATCH                    | `/api/invoices/:id`                                 | session | `invoice:write`        | none          |
| DELETE                   | `/api/invoices/:id`                                 | session | `invoice:write`        | none          |
| POST                     | `/api/invoices/:id/issue`                           | session | `invoice:write`        | none          |
| POST                     | `/api/invoices/:id/cancel`                          | session | `invoice:write`        | none          |
| GET                      | `/api/invoices/:id/pdf`                             | session | `invoice:read`         | none          |
| POST                     | `/api/invoices/export`                              | session | `invoice:read`         | none          |
| GET                      | `/api/company-profile`                              | session | —                      | none          |
| PUT                      | `/api/company-profile`                              | session | Role: owner            | none          |
| GET                      | `/api/events`                                       | session | —                      | none          |
| POST, PUT, PATCH, DELETE | `/api/events`                                       | session | —                      | none          |
| GET                      | `/api/push/vapid-public-key`                        | none    | —                      | none          |
| POST, PUT, PATCH, DELETE | `/api/push/vapid-public-key`                        | none    | —                      | none          |

<!-- GENERATED:api-surface:END -->

Requests to session-protected endpoints without a valid session return `401 UNAUTHENTICATED` (`"Nicht angemeldet."`); authenticated requests failing the **Access** rule return `403 NOT_PERMITTED` (`"Keine Berechtigung."`). Both gates live in `src/server/middleware/auth.ts` — `requireSession` applies the session check to every route in a plugin, `requirePermission` and `requireRole` gate single routes — and permission keys resolve against the role matrix in `src/config/permissions.ts` (see [spec §14.3](docs/spec/api.md#143-authorization-rules)).

`—` under **Access** means no gate at the route boundary, which is not "open to every role". Several reads narrow rows by the caller's scope instead of rejecting the call (ADR-0019): a worker's `GET /api/invoices` answers `200` with an empty set, because a permission gate there would collapse the out-of-scope and unknown-id arms into one status (AC-298). Where existence is not a secret at the role boundary, an out-of-scope row answers `403` and an unknown id `404` (AC-147, AC-214).

The rows carrying `POST, PUT, PATCH, DELETE` are explicit `405 METHOD_NOT_ALLOWED` guards sending `Allow: GET`; Fastify's default would be `404`, which [verification.md §15.28](docs/spec/verification.md) does not allow. Session gating runs first, so an unauthenticated call to one of the session-gated three gets `401`, not `405`. `OPTIONS *` is `@fastify/cors`'s preflight route — not an endpoint anyone calls directly, but in the table because the table is the app's route set without exceptions.

Rate limits are the production values (`getRateLimit()`, `src/server/config/index.ts`). The login default is environment-aware — 5/min in production, 30/min in dev and test so the Playwright suite's per-context logins are not throttled — and `LOGIN_RATE_LIMIT_MAX` overrides both.

Route definitions live in `src/server/routes/`, and every one of them is registered by `buildApp()` in `src/server/app.ts` — including `/api/health`, whose probe dependencies (`pg.Pool`, `StorageClient`) `start.ts` passes in. A route mounted on the instance `buildApp()` returns would be invisible to both generated artifacts below, so `eslint.config.js` fails the build on one.

**One exception, deliberate and bounded:** in production `start.ts` calls `registerStaticAssets` (`src/server/staticCache.ts`), and `@fastify/static` registers a HEAD+GET pair per built file under `dist/` on the returned instance. Those are the compiled SPA's own assets, not API surface, so neither artifact describes them; the call carries an inline `eslint-disable` naming the reason rather than slipping past a selector that happens not to match it.

### Endpoint Notes

What a route declaration cannot carry and [api.md §14.2](docs/spec/api.md#142-operations) does not already own. An endpoint absent here is described there.

- `GET /api/health` — probes `SELECT 1` and a `HeadBucket` in parallel, returns `{status,checks:{db,storage}}`, `503` on either failure (#48). Built without probe dependencies it reports `degraded` rather than a placebo `200`.
- `POST /api/auth/login` sets the HttpOnly `session` cookie. For role `owner` it and `GET /api/auth/me` both carry `backupStatus`, so the badge is populated on either session-establishment path (AC-170). `PATCH /api/auth/me` is self-scope only — it cannot affect another user.
- `POST /api/projects` and `POST /api/customers` accept a client-supplied id, which is what makes a retried create idempotent (`idempotency.ts`).
- The two `/transition/` endpoints require `expectedStatus`; that is what makes a concurrent double-advance deterministic (AC-94).
- `DELETE /api/projects/:id` archives (soft-delete, ADR-0017); `/purge` hard-deletes an already-archived project and cascades to object storage (AC-218). `DELETE /api/customers/:id` is refused while an active project references the customer, and purges that customer's already-archived projects in the same transaction.
- `GET /api/audit` narrows destructive actions by role — owner unfiltered, office blind to purges, user deletions and role changes (ADR-0021).
- `POST /api/extract` needs `OPENROUTER_API_KEY`; the route registers without it and the call fails (ADR-0016).
- The export and import job sets are asynchronous: create answers `201` with a `pending` row and the client polls. Import streams the archive to `.../archive` in tus-style chunks — `HEAD` for the resume offset, `PATCH` to append — and reaching `Upload-Length` is what fires the restore. The destructive guard (`override` plus a matching confirmation phrase) runs at create time, before a byte is uploaded (AC-329, [api.md §14.2.4](docs/spec/api.md#1424-unified-data-exchange)).
- The attachment endpoints are the client-side-encryption path end to end — § Attachments Module carries the DEK envelope, the two-blob layout and the presigned-URL contract. `download-url` takes `?variant=original|thumbnail`.
- `GET /api/events` is the single SSE channel; consumers refetch the read endpoint matching each event (`src/config/sseEvents.ts`). The session is re-validated every heartbeat and the stream ends on revocation (AC-275, ADR-0025).

### API Surface Generation

The table above is generated from the routes `buildApp()` registers (AC-352) — fourth in the same family as the permissions matrix (AC-343), the nav matrix (AC-349) and the OpenAPI document (AC-351). `scripts/generate-api-surface.ts` builds the app, collects every route through an `onRoute` hook, and renders the five columns between the `GENERATED:api-surface` markers; `--check` fails CI on drift (`npm run check:api-surface`, plus the scenario harness `scripts/__tests__/check-api-surface.test.sh`).

**What it replaced.** "Keep this table in sync" was the previous mechanism, and it produced a table missing 17 of 53 paths — every invoice, notification and push endpoint, both storage-usage reads, the company profile, the worker list, project restore. Drift in the other direction was zero: it named no path that did not exist. Hand-maintenance under-reports; it does not hallucinate. The table is now complete by construction, and the `Purpose` column it used to carry — up to 1003 characters per cell, largely restating [api.md §14.2](docs/spec/api.md#142-operations) — moved to § Endpoint Notes at a tenth the size.

**Access is derived from the enforcement, not restated beside it.** A plugin-level `preHandler` is invisible to `onRoute`, so `requireSession` writes an `auth: 'session'` route-config marker in the same call that installs the hook; absence of that marker is what makes an endpoint public, and there is no list of public endpoints to fall out of date. `requirePermission` and `requireRole` return closures — callable but not readable — so each carries its keys as data (`requiredPermissions`, `requiredRoles`), the same move AC-349 made for `RouteAccess`. The column therefore publishes the rule, not the role set the rule happens to resolve to today.

**One gate combination fails the build rather than publishing.** `requirePermission` and `requireRole` both reject a request carrying no authenticated user, and only `createAuthMiddleware` ever attaches one — so an access gate no session gate reaches is a route that answers 401 to every caller, including one holding the permission. Both generators would publish it as public (`Auth: none` beside a populated `Access` column here; `security: []` in the OpenAPI document), so the guard sits with the introspection both read and exits 2 from either generator.

**Reached means reached first.** Fastify runs a route's `preHandler` array in declaration order, so `[requirePermission(…), authenticate]` carries both gates and is still dead: the access gate runs first and finds no user. The guard therefore compares positions rather than testing presence — and needs no position for `requireSession`'s marker, because that gate is an instance hook, and every instance hook runs before any route-level one. No such route exists in either direction; nothing but this stops the next one. Both generators' calls are pinned by a fault-injection case in their own harness (`$API_SURFACE_INJECT_ORPHAN_GATE`, `$OPENAPI_INJECT_ORPHAN_GATE`, `$OPENAPI_INJECT_MISORDERED_GATE`), so neither call can be deleted while the suites stay green.

**Both generators read the routes through `scripts/lib/route-introspection.ts`** — which gate reaches a route, what rule it enforces, which HEAD routes are Fastify's automatic companions. Two copies agreeing only by comment is the failure mode these generators exist to remove; it applies to the generators themselves.

**HEAD companions are filtered.** Fastify exposes a HEAD route for every GET. Those are dropped by handler identity — same URL, same handler reference — so a HEAD row means a route someone declared deliberately, today only the tus offset probe.

**Prose below the end marker is never overwritten**, the same split the nav matrix draws: coverage and access rules are generated, meaning is hand-written. That is why the generator does not also try to produce § Endpoint Notes.

### OpenAPI Document Generation

`docs/api/openapi.json` is generated from the native Fastify `schema:` blocks the routes already carry — no hand-authored OpenAPI annotations (AC-351). `scripts/generate-openapi.ts` builds the app via `buildApp({ openapi: … })` (the option `@fastify/swagger` registers behind, carrying the document's header), calls `app.swagger()`, and writes the Prettier-formatted result; `--check` mode fails CI on drift (`npm run check:openapi`, plus the scenario harness `scripts/__tests__/check-openapi-doc.test.sh`).

**Coverage is exactly `buildApp()`, and enforced in both directions.** `app.swagger()` reports the routes registered on the instance the generator built, so the API surface is complete only while every API route is registered by the factory — which the `no-restricted-syntax` rule in `eslint.config.js` enforces (see § API Surface), with the static-asset registration as its one stated exception. Registration alone is not sufficient, though: `@fastify/swagger` drops every HEAD route unless it opts in, which silently omitted `HEAD /api/import-jobs/:id/archive` — the tus offset probe, normative in [api.md §14.2.4](docs/spec/api.md#1424-unified-data-exchange) and called by `src/api/client.ts` — for as long as the artifact existed. The generator now fails the build (exit 2) on a registered route the document does not publish, excluding only Fastify's automatic HEAD companions (matched by handler identity, as § API Surface Generation does) and routes carrying `@fastify/swagger`'s own `schema: { hide: true }` opt-out, which `@fastify/cors` sets on its `OPTIONS *` preflight. Both exclusions are structural; neither is a list of names.

A route with no `schema:` block still appears, carrying only what is derived from the route rather than from a schema: `/api/health` publishes `{"get": {"security": []}}`, which says the endpoint exists and needs no session, and nothing more. **26 of the document's 90 operations carry nothing beyond that security requirement** — every registration that declares no `schema:` block, the `405` method guards on `/api/events`, `/api/storage-usage` and `/api/push/vapid-public-key` included. Closing that gap is #282's work; the count is stated here so the gap is visible from the document rather than something a reader has to count.

**Not in `docs/spec/`, deliberately.** The spec is the upstream contract the app must fulfil; this artifact is derived from the code, so it is downstream by construction (A-TRDO). Filing it under `docs/spec/` would point CI at enforcing that an upstream contract matches the implementation — a route schema regressing would silently drag the "spec" along with it. [api.md §14.2](docs/spec/api.md#142-operations) stays normative and hand-authored; `openapi.json` is a machine-readable view of the request surface only, and where the two disagree, api.md wins.

The document targets OpenAPI **3.1.x**, not 3.0.x, for two reasons: 3.0's Draft-4-based Schema Object rejects array-valued `type` (the `type: ['string', 'null']` nullable idiom used throughout the route schemas) and numeric `exclusiveMinimum`, both of which 3.1's JSON Schema 2020-12 Schema Object accepts natively; and 3.1 makes `responses` optional on the Operation Object, which 3.0 required.

That second point is what keeps the artifact honest. No route declares a `response:` schema today, and `@fastify/swagger` fills the gap with a synthetic `200 Default Response` derived from nothing — false for every operation (nine routes return 201, eight return 204, four sites return 405). The generator strips it, so the document is silent about responses rather than wrong about them, and **documents requests only** is literally true. The all-empty `components` block `@fastify/swagger` emits (`{"schemas": {}}`) goes for the same reason — the block the published document does carry holds nothing but the `securitySchemes` entry added below.

**Two things are gated, not one.** `--check` catches _drift_ (generated ≠ committed). On its own that would stay green on a structurally invalid document, because both sides would be equally wrong. So the generator also validates every document it produces against the OpenAPI 3.1 schema (`@seriousme/openapi-schema-validator`) before writing or comparing, and asserts the version it validated as — the validator picks its schema from the document's own `openapi:` field, so a document that silently declared 3.0 would otherwise be checked against 3.0's schema and pass. `$OPENAPI_INJECT_INVALID` is the fault-injection seam that lets the scenario harness prove the gate is wired; without it the gate is unfalsifiable, since a document built from the real routes is always valid.

A linter (`@redocly/cli`) is deliberately **not** the gate. Its remaining findings are style and completeness — `operation-summary`, `operation-operationId` — which are #282's work, not spec conformance. Structural errors are zero, and that is the property enforced here.

**The session requirement is derived, not hand-listed (AC-353).** The generator collects the registered routes through an `onRoute` hook — the same mechanism, and the same after-`buildApp()`-before-`ready()` timing, as § API Surface Generation — and annotates each operation from the gate that reaches its route: `[{ "sessionCookie": [] }]` where `requireSession`'s `auth: 'session'` marker or a route-level `requiresSession` gate applies, `[]` (explicitly "no auth needed") where neither does. So the seven ungated operations publish as public because no gate reaches them, not because an allowlist says so — the argument AC-352 makes for the Auth column, applied to the same data.

Only the scheme itself is hand-written: `sessionCookie`, an `apiKey` in the `session` cookie. No route declaration carries that fact, so nothing can derive it.

Two things this deliberately does not publish. **Permission keys do not ride in the requirement array** — scopes are meaningful only on `oauth2` / `openIdConnect` schemes, so `{"sessionCookie": ["project:read"]}` would be valid syntax asserting nothing; the permission dimension stays in § API Surface until #282 decides how to represent it. And the requirement is never inferred: an operation the generator cannot trace back to a registered route fails the build (exit 2) rather than publishing with no requirement at all, because that direction advertises a protected endpoint as public. Together with the coverage check above, the route set and the operation set are pinned to each other in both directions — and the third door into the same fail-open claim, an access gate on a route no session gate reaches, is closed at the route side (see § API Surface Generation).

`@fastify/swagger` is a **devDependency**, imported lazily inside the `opts.openapi` branch in `src/server/app.ts`. The two facts that decide the import style: esbuild runs with `--packages=external`, so the specifier survives bundling verbatim either way; and the Dockerfile runs `npm prune --omit=dev` after the build, so the package is not in the runtime image. A static top-level import would therefore be evaluated on every production boot against a `node_modules` that no longer contains it — the container would fail to start. Lazily, the specifier is still in `dist/server/start.js` (one occurrence, inside the branch) but is never reached, because nothing in production passes `openapi`. The branch is a build-tooling seam, not dead code (C-DEAD): its caller is the generator, and CI exercises it on every run.

One gap remains, tracked incrementally in #282 (never big-bang): **response/error schemas**. As routes gain real `response:` schemas the generator emits them automatically, and `api.md`'s per-endpoint request/response prose retires one route at a time (strangler); its normative design notes stay hand-written. Adding a `response:` schema is not a documentation-only change — Fastify serializes through `fast-json-stringify` once one is present, so a field the schema omits disappears from the wire.

**Where the code sits.** `scripts/generate-openapi.ts` owns boot, env pinning, drift and I/O. Everything that decides what the document may claim — the strip, the two coverage guards, the security annotation, the validity gate — is decided by `(doc, routes)` alone in `scripts/lib/openapi-document.ts`, callable without booting an app (each mutates the document in place or throws; none is pure). Both guards index operations through one `operationKey`, so the pair cannot come to disagree about what identifies an operation. The `schema: { hide: true }` opt-out is read more strictly there than `@fastify/swagger` reads it — the plugin hides a strict superset — so the divergence fails closed, costing a build break that demands `hide: true` spelled exactly, never a silently shrunken surface.

The document's header — the version it declares, `info`, `servers` — lives in `scripts/generate-openapi.ts` and reaches the factory as `buildApp({ openapi: … })`. `app.ts` only wires it through: what the artifact says about itself is a documentation decision, and `app.ts` ships in the production bundle. `info.version` is a fixed constant there, not `package.json`'s version: the app's release version says nothing about whether the HTTP surface changed, and coupling them would turn every release bump into a red build until someone regenerated the artifact.

`lint-staged` is deliberately **not** extended to run this check on commit. The generator boots the whole Fastify app; that is seconds of latency on every commit touching `src/server/`, against a guard CI already enforces on every push.

### Error-Code Catalogue

The catalogue in [api.md §14.4.1](docs/spec/api.md#1441-error-categories) is published from `ERROR_CODES` (`src/server/errors.ts`) and pinned to it by a test (AC-354): `src/server/__tests__/error-codes.test.ts` parses the block between the `CHECKED:error-codes` markers and fails when the document and the array disagree — including when the markers are absent, which would otherwise pass vacuously.

**Checked, not generated — deliberately.** The four generators above are worth their machinery because their output is _derived_. This block is a _transcription_ of the array, and a test pins it identically at a fraction of the cost; the only thing forgone is auto-fix on a comma list. **The rule: generate a derived artifact, check a transcribed one.** Collapsing the four generators onto one shared skeleton, after which generating becomes cheap enough to stop being a decision, is tracked in #282.

**`ERROR_CODES` is an array, and `ErrorCode` is derived from it** (`(typeof ERROR_CODES)[number]`) rather than declared beside it. A TypeScript union has no runtime form — nothing can read it, publish it, or emit it as an OpenAPI enum. But the reason to derive rather than keep both is that the hand-kept pair had already drifted in both directions at once:

| Code                                       | In the type | On the wire | In the contract                        |
| ------------------------------------------ | ----------- | ----------- | -------------------------------------- |
| `METHOD_NOT_ALLOWED`                       | no          | yes         | required by §14.2, absent from §14.4.1 |
| `DRAFT_NOT_EXPORTABLE`, `EXPORT_TOO_LARGE` | yes         | yes         | absent                                 |

`METHOD_NOT_ALLOWED` is the instructive one: four route sites answered it as a hand-rolled `{ code, message }` object literal, which type-checks against `reply.send(payload: unknown)` no matter what it contains. Those sites now build the response through `methodNotAllowed()`, so the code is a member of the catalogue by construction and the message comes from `STRINGS` in German like every other.

**The `Allow` header travels with the error, not beside it.** RFC 9110 §15.5.6 makes `Allow` mandatory on a 405 and Fastify's router does not populate it for these guards, so status and header were two statements per call site that had to agree by inspection — a fifth guard forgetting the header would have shipped an RFC-non-compliant response, green. The admitted verbs are still the route's knowledge, but the route hands them to `methodNotAllowed(['GET'])` rather than writing the header itself: the returned `AppError` carries them, and the global handler in `error-handler.ts` writes headers and body in the same place. That is the same argument as `ERROR_CODES` itself — one form, not two that agree by convention. `AppError.headers` is general (any status whose contract includes a header), but 405 is its only use today.

What the block is **not**: the per-code prose below the end marker — which category a code specializes, which status it carries, what its `details` payload holds — exists nowhere in the code, so it stays hand-written and unchecked. The block is the set; the prose is the meaning, and only the set is pinned.

**Where the 405 guards actually sit.** Six [api.md §14.2](docs/spec/api.md#142-operations) error-path lists require the response; four endpoint groups (§14.2.8 audit, §14.2.11 attachments, §14.2.14 invoices, §14.2.15 company profile) register no guard and answer `404 ROUTE_NOT_FOUND` today. The spec is the target and the implementation is what moves — the four missing guards are tracked in #282.

One gap this does not close: nothing yet stops a new route from hand-rolling an error body again, the way those four did. The type system cannot see it (`send` takes `unknown`), so the guard would be a lint rule in the shape of the route-registration selector in `eslint.config.js`. Tracked in #282.

---

## Permission Gating

The role-to-permission matrix in `src/config/permissions.ts` is the single source of truth for both layers: server routes import `hasPermission` via `requirePermission(...)` (403 on violation), and UI components import it via the `usePermission('<permission>')` hook in `src/hooks/usePermission.ts` (hide the affordance). Client-side gating is UX, not security — the server check is always authoritative. UI code never hardcodes role names; it asks for a permission. See [spec AC-121](docs/spec/verification.md) for the invariant and [§14.3](docs/spec/api.md#143-authorization-rules) for the server contract.

`requireRole(...)` is the single, spec-sanctioned exception: `PUT /api/company-profile` is owner-only and the spec deliberately declines to mint `company_profile:*` keys for one singleton ([api.md §14.2.15](docs/spec/api.md#14215-company-profile-operations)). It is a route gate like any other, so [§ API Surface](#api-surface) publishes it as `Role: owner` rather than as a blank cell — which is what it looked like while the check lived inside the handler.

The published matrix at [api.md §14.3](docs/spec/api.md#143-authorization-rules) is generated from `ROLE_PERMISSIONS`, not hand-authored (AC-343): `scripts/generate-permissions-doc.ts` renders the table between `GENERATED:permissions-table` markers and reformats via Prettier; `--check` mode fails CI on drift (`npm run check:permissions-doc`). Production-vs-test-only role classification is `IS_TEST_ONLY_ROLE: Record<Role, boolean>` in the same file — exhaustive over `Role` by construction, mirroring `ROLE_CLASSIFICATION` in `src/server/repositories/scope.ts`. `ROLE_KEYS` (`src/config/roleKeys.ts`) and every other consumer of the production-role set (e.g. the user-management route schemas) derive from that classification rather than hand-listing roles.

Per-view navigation and the route guard share a second table in `src/config/routes.ts`. Access is declared as **data**, not a closure: each entry carries a `RouteAccess` rule (`{kind:'role'}` or `{kind:'permission'}`) and `canAccess` is derived from it; landing is an ordered first-match list (`LANDING_ORDER`), so two views cannot both claim a role. The `Header` nav and the `App` route guard both consume this one table, so those two cannot disagree with each other — and the spec's per-role nav matrix ([spec ui/index.md §8.7.1](docs/spec/ui/index.md#871-views)) is generated from it, not hand-authored (AC-349): `scripts/generate-nav-doc.ts` renders the View / Path / Label / Access / Roles / Landing columns between `GENERATED:nav-matrix` markers, `--check` fails CI on drift (`npm run check:nav-doc`). Declaring the rule rather than writing a predicate is what makes that possible — a closure can be evaluated but not read, so a generator could publish only the role set it resolves to, never `invoice:read` itself. Only the derivable columns are generated; the per-view prose below the end marker is spec intent that exists nowhere in the code and stays hand-written.

**Data scoping** is orthogonal to permissions ([ADR-0019](docs/adr/0019-worker-data-scoping-repository-layer-predicate.md)). `project:read` and `customer:read` grant the _capability_ to read; `src/server/repositories/scope.ts` narrows the _extent_ (which rows are visible) with a predicate ANDed into repository queries — currently scoping workers to projects they are assigned to. Services that must bypass scope (e.g., `ExportService`) fail-fast when threaded a scoped caller, so a permission-churn regression cannot silently leak every row.

---

## How to Extend

Common changes and where to look. The dependency direction in [Architecture Overview](#architecture-overview) is the only invariant. Conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).

### Adding a new entity (e.g., Supplier)

**Pattern to copy**: the `Project` entity — read `schema.ts`, `types.ts`, the repo/service/route/store/UI chain for projects.

1. **Schema**: add table in `src/server/db/schema.ts` (same audit-field pattern as `projects`). `npx drizzle-kit generate`. Never edit an existing migration.
2. **Domain types**: add interface in `src/domain/types.ts`. Optional fields stay optional ([spec §13.5](docs/spec/architecture.md#135-robustness)).
3. **Repository**: split by concern (`src/server/repositories/supplier-read.ts`, etc.), barrel re-export. Add a `toSupplier(row)` projection so Drizzle types don't leak upward.
4. **Service**: `src/server/services/SupplierService.ts`. Must not import `fastify` types ([spec §11.2](docs/spec/architecture.md#112-responsibility-boundaries)).
5. **Routes**: `src/server/routes/suppliers.ts`, register in `app.ts`. Routes go through the service, never call repos directly.
6. **API client**: add a `supplierApi` block in `src/api/client.ts` (same shape as `projectApi`).
7. **State**: `src/state/supplierStore.ts` (model on `projectStore.ts`, optimistic updates with rollback).
8. **UI**: components under `src/ui/suppliers/`.
9. **Tests**: domain in `src/domain/__tests__/`, integration in `src/server/__tests__/` (copy `projects-list.test.ts`), component in the feature's own `__tests__/` (e.g. `src/ui/detail/__tests__/`).
10. **Seed**: extend the relevant loader under `src/server/seed/` (`users.ts` for new user records; `business.ts` for customer/project-like entities that should flow through `ImportService`).
11. **Spec**: update `docs/spec/data-model.md`, `docs/spec/api.md §14.2`, `docs/spec/verification.md`.

### Adding a new view (e.g., Worker view)

**Pattern to copy**: `src/ui/kanban/KanbanBoard.tsx`, `src/state/projectStore.ts` (`getProjectsByState`), `src/config/routes.ts` (ROUTES table), `src/domain/types.ts` (`ViewMode` union).

1. Add view name to `ViewMode` in `src/domain/types.ts`.
2. Create component under `src/ui/<view>/`. Reads from `useProjectStore`, filters client-side.
3. Add an entry to `ROUTE_DEFINITIONS` in `src/config/routes.ts` with an `access` rule — `{ kind: 'role', roles: [...] }` or `{ kind: 'permission', permission: ... }`. `canAccess` is derived from it, and `isDefaultFor` from `LANDING_ORDER`; neither is written per entry. If the view is a landing view for some role, add the rule to `LANDING_ORDER` (first match wins). The `Header` nav and the `ProtectedRoute` guard both derive from the entry automatically, and the spec's per-role nav matrix ([spec ui/index.md §8.7.1](docs/spec/ui/index.md#871-views)) regenerates from it — run `npx tsx scripts/generate-nav-doc.ts` and add the row to `ROUTE_TABLE` in `src/config/__tests__/routes.test.ts`, which is the assertion that can disagree.
4. Wire the component into the `VIEW_ELEMENTS` lookup in `src/App.tsx` so `<Routes>` knows what to render for the new key.
5. Tests: copy structure from `src/ui/detail/__tests__/ProjectDetailPage.test.tsx`.

Backend changes are usually not needed — the store exposes the full project list. If the view needs a query the store can't answer, add it to `projectStore.ts` (keeps the cache coherent) rather than a new store.

### Adding a new API endpoint

**Pattern to copy**: `src/server/routes/projects.ts`, `src/server/services/ProjectCrudService.ts`, `docs/spec/api.md §14.2`.

1. **Where**: extend an existing route file if it belongs to that entity/group; create a new one otherwise.
2. **Validation**: Fastify JSON Schema on the route (see `projects.ts`). Don't validate inside the handler.
3. **Auth**: `requireSession(app, db)` once per plugin; `requirePermission('...')` per route. Add new keys to `src/config/permissions.ts` (shared with the client-side `usePermission` hook — see [§ Permission Gating](#permission-gating)). Both gates carry their rule as data, so [§ API Surface](#api-surface) picks the endpoint up on its next generation — there is no table row to add by hand.
4. **Delegate to service**. Never call repos from a route ([spec §11.2](docs/spec/architecture.md#112-responsibility-boundaries)).
5. **Errors**: use factories from `src/server/errors.ts` (`notFound()`, `validationError()`, etc.). Never throw raw `Error`. For endpoints accepting composite payloads, translate DB constraint violations via the service layer: classify with `extractSqlState()` / `extractPgConstraint()` and disambiguate against the named constraints in `src/server/db/constraints.ts` (see `ProjectCrudService.createProjectWithClientId` for the 23505 pattern).
6. **Register** in `src/server/app.ts`.
7. **Tests**: integration in `src/server/__tests__/` using `api-helpers.ts` (`startApp()`, `login()`, `authPost()`/`authGet()`).
8. **Spec**: add operation to `docs/spec/api.md §14.2`, AC in `docs/spec/verification.md`.

### Adding a new workflow state

Most of the Kanban, calendar, and aging rendering is genuinely config-driven. Two specific places still hardcode boundary-state literals and will need updating in addition to the config:

1. Update the state array in `src/config/stateConfig.ts` (name, type, color, aging thresholds, collapse tier).
2. **Boundary-state references**: `src/domain/transitions.ts` uses hardcoded `'anfrage'` and `'erledigt'` literals for "first state" and "terminal state" checks. If the new state is inserted in the middle these are safe; if it replaces the first or last position, update the literals to match. The server-side repository path (`src/server/repositories/project-transitions.ts`) is config-driven via `WORKFLOW_ORDER` and does not need changes.
3. **Database constraints**: `src/server/db/schema.ts` has (a) a `status` column default of `'anfrage'` and (b) a `projects_valid_status` CHECK constraint that hard-codes all nine state literals. Adding, renaming, or removing a state requires regenerating the migration via `npx drizzle-kit generate`, otherwise inserts for the new state will be rejected at the DB layer.
4. **Hardcoded test fixtures**: a couple of tests pin the full state list — grep for the state keys and update as needed.
5. Re-seed the database if existing data must be migrated to a new state (`SEED=force npm run dev`).

This is not a zero-code-change operation. Improving it toward full configurability is tracked in [spec §3](docs/spec/index.md#3-workflow-states).

### Adding a new SSE event

**Pattern to copy**: `INVOICE_CHANGED` — `src/config/sseEvents.ts`, `emitInvoiceChanged` in `src/server/sse/emitters.ts`, `src/state/invoiceSseSubscription.ts`.

1. Add the event constant to `src/config/sseEvents.ts` and to `SSE_EVENT_NAMES` — backs the `SseEventName` union and the AC-338 coverage guard.
2. Add a typed `emitXChanged()` helper in `src/server/sse/emitters.ts`; call it post-commit from the mutation call site, never inside the transaction ([spec §11.13](docs/spec/architecture.md#1113-realtime-invalidation-channel)).
3. Add ≥1 client subscriber under `src/state/` via `onSseEvent` (`src/sse/client.ts`) — an emit-only event fails `src/state/__tests__/sseSubscriberCoverage.test.ts` (AC-338).
4. Wire the subscription into the auth-gated `useEffect` in `src/App.tsx`, alongside the existing SSE subscriptions.
5. **Spec**: add the event to the v1 catalog and emitter list in `docs/spec/architecture.md §11.13` and `docs/spec/api.md §14.2.13`.

### Seeding modes

The seed loader (`src/server/seed.ts`) is controlled by environment:

- **Production** (`NODE_ENV=production`): seeding is skipped entirely — the start-up path in `src/server/start.ts` never calls it.
- **`SEED=false`** (default — see `src/server/config/env.ts` and `docker-compose.yml`): no seeding. Seeds never run without an explicit opt-in.
- **`SEED=true`**: loads seed data if the database is empty; no-ops if data already exists.
- **`SEED=force`**: drops all seed records and reloads from scratch. Use after schema changes or to refresh stale demo dates.

Run via `SEED=true npm run dev` (or `SEED=force` for a hard refresh) or set in `.env`.

---

## Infrastructure

### Docker Compose (production)

Six services defined in `docker-compose.yml`:

| Service        | Image / Build                                               | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`          | `ghcr.io/projekt-manager-org/projekt-manager` (GHCR)        | Fastify server serving API + static frontend. Carries a tmpfs mount for the operator-loaded binary `age` private identity (modeled on the `backup` service's drill-key tmpfs); the boot probe refuses to start if the identity is absent (ADR-0024). New env var `BINARY_AGE_RECIPIENT` carries the matching public recipient and is wired through `.env.production.example` and `secrets.manifest.txt`.                                                                                                                                                                                              |
| `db`           | `postgres:17-alpine`                                        | PostgreSQL with persistent volume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `storage`      | `minio/minio`                                               | S3-compatible object storage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `storage-init` | `minio/mc` (one-shot)                                       | Creates the default bucket on first start, then exits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `backup`       | `ghcr.io/projekt-manager-org/projekt-manager-backup` (GHCR) | Layer 2 encrypted R2 backup + drill service (ADR-0020). In-process croner schedule (`backup-runner.ts` → `schedule` subcommand), `TZ=Europe/Berlin`: backup five times weekdays (09/12/15/18/21) + once weekends (12:00), drill at +2 min offset on each tick. Retention is linear ([ADR-0020 §Retention](docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention)); no rotation step. Runs as the `postgres` system user (UID 70 — Trivy DS-0002 resolved at the architectural layer). Gated behind the `backup` compose profile so local dev does not spin up the loop. |
| `caddy`        | `build: ./docker/caddy` (xcaddy + Cloudflare plugin)        | Reverse proxy, HTTPS via DNS-01 ACME                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The backup image is built by `Dockerfile.backup` and layers `postgresql17` (server + client), `age`, `bash`, and `findmnt` onto `node:22.22.3-alpine` (#199 dropped `dcron`/`tzdata`/`su-exec` when the schedule moved to in-process croner). Its `FROM ghcr.io/.../projekt-manager:${APP_IMAGE_TAG}` stage pulls the just-built app bundle so the backup service runs the exact same `backup-runner.js` the app process imports — no skew between the web-handler and scheduled-tick definitions of `runBackup`.

Local development uses `docker-compose.dev.yml` for database and storage only; app runs via `npm run dev` (Vite + tsx watch). HTTP-only evaluation uses the `docker-compose.http.yml` overlay, which swaps the custom Caddy for stock `caddy:2-alpine` on port 80 (ADR-0013).

### CI/CD Pipeline

One GitHub Actions workflow (`ci.yml`) produces an image; one operator-run script (`scripts/deploy.sh`) promotes it. There is no separate deploy workflow ([ADR-0012](docs/adr/0012-manual-pull-based-deploy-over-wireguard.md)). Three more workflows run outside the merge gate — housekeeping, scheduled scanning and alerting, not image production: `cache-cleanup.yml` deletes GHA caches scoped to a closed PR's merge ref, `security-scheduled.yml` runs a nightly full-tree OSV-Scanner sweep for retroactive CVEs ([ADR-0027](docs/adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md)), and `notify.yml` raises the human signal when either of those goes red.

**CI** (`.github/workflows/ci.yml`) — triggered on push and PR to `main`, plus `merge_group` (currently a no-op — the merge queue is off) and `workflow_dispatch` (operator feature-branch image build, an escape hatch rather than a pipeline stage). Six jobs (`lint`, `check-shard`, `check`, `docker`, `publish`, `promote`) running in parallel where dependencies allow. Failure alerting is deliberately **not** among them — it lives in `notify.yml` (below), because a notifier that is a job of the workflow it monitors shares that workflow's fate:

- **`lint`** (every event) — static-analysis pillar; no DB, no MinIO. Steps in order: lockfile-pin drift sanity check, allowlist schema + self-test, OSV-Scanner (lockfile vulns), Trivy filesystem-secret + IaC scans, compose-reference validation (`docker compose config` across five file/profile combinations, failing on any `${VAR}` without a `:-` default — here rather than in `docker` because `docker` does not run on `push`, so on `promote`'s fallback path, the one case where the merged tree was never validated as a unit, nothing would check those bytes), `npm run lint`, shellcheck, actionlint (workflow syntax), `npm run format:check`, theme-token hygiene, permissions-doc drift check + self-test (AC-343), nav-matrix drift check + self-test (AC-349), OpenAPI doc drift check + self-test (AC-351), route-registration rule self-test (AC-351 — the API-surface-completeness clause rests on one ESLint selector, which fails open on a typo or a widened `ignores:`), `npx tsc --noEmit` (root, then `scripts/`), `bash scripts/check-env-drift.sh` (regression guard that every `env.ts` variable is forwarded via `docker-compose.yml`'s `services.app.environment`; added after `BOOTSTRAP_ADMIN_*` landed in the Zod schema but were forgotten in compose), workflow drift check + self-test (`bash scripts/check-workflow-drift.sh` — `check-shard`'s postgres service container is one decision written twice with `e2e.yml`: Actions has no include mechanism for a service block (composite actions have no `services` key, reusable workflows reuse a whole job). Comments are excluded from the comparison, everything else must match. The `age` install is no longer compared — it is one composite action (`.github/actions/install-age`), shared by `check-shard`, `e2e.yml` and `build-scan-smoke`, and cannot drift — but the check does assert both workflows still **call** it, which deduplication does not guarantee. `e2e.yml` is `workflow_dispatch`-only, so an unsynced edit there would otherwise stay invisible until an operator runs it before a manual deploy), image-ref derivation self-test (`bash scripts/__tests__/image-refs.test.sh` — `scripts/ci/image-refs.sh` decides what every image in the pipeline is called, for `docker` and `promote` alike; its `main` guard is the one rule whose failure mode is publishing over production's pointer rather than a red build, so it gets a scenario table), notify-classification truth table (`bash scripts/__tests__/notify-classify.test.sh` — extracts the `Classify run` step's shell body out of `notify.yml` and runs it against a state/route table with the one API call stubbed. `workflow_run` fires only from the default-branch copy of a file, so `notify.yml` cannot be exercised on a PR branch the way `notify-failure` was; this is the only pre-merge evidence its classification is right, and it fails if the step is edited without the table, or removed), Renovate annotation check + self-test (`node scripts/check-renovate-annotations.mjs` — every `expected_sha` binary pin in `.github/workflows` and `.github/actions/<name>/` must actually be matched by a customManager whose `managerFilePatterns` cover that path. The manager's regex joins the `# renovate:` annotation to `version=` with `\s+`, so an interposed comment drops the pin out of tracking silently; the check reads the regex out of `.github/renovate.json` rather than restating it, and also rejects a datasource that cannot resolve an asset checksum or a version hardcoded twice in one step), `bash scripts/check-audit-mutations.sh` (static architecture check per AC-179 — fails when a raw `INSERT/UPDATE/DELETE` on an audited table lands outside `mutate()` and outside the reviewed allowlist; the `MutatingDatabase` type gate is the primary guarantee, the scan is belt-and-braces for dynamic-SQL drift), doc-path drift check + self-test (AC-347), Module Map coverage check + self-test (AC-350), markdown link check (AC-348), `bash scripts/check-traceability.sh` (S-ACTR — every spec §15 AC has a row in `docs/testing/traceability.md` and vice versa; `[crit]` ACs without a test reference warn but don't fail the build), `npm run build`. The seven documentation guards among those are described under [Design Decisions § Documentation drift guards](#design-decisions-not-adr-worthy).
- **`check-shard`** (every event, matrix `shard: [1, 2]`) — test pillar, sharded across runners to halve wall-clock. Each shard owns its own Postgres service + in-job MinIO container and runs `npm run test -- --shard=N/2` (no `--coverage`: the report had no uploader and no gate reading it, so the instrumentation was pure cost — `npm run test:coverage` stays available locally). Per-fork DB isolation in `src/test/integration-setup.ts` prevents cross-fork collisions; cross-shard collisions are impossible (separate runners = separate services). Playwright is **not** part of the push/PR gate — the on-demand workflow `.github/workflows/e2e.yml` runs it on `workflow_dispatch` only, so CI green on push does not imply E2E green. See [docs/spec/architecture.md §11.7](docs/spec/architecture.md#117-continuous-delivery-pipeline) and [docs/spec/verification.md AC-37](docs/spec/verification.md#157-engineering).
- **`check`** (aggregator) — single required-check name the Ruleset depends on. `needs: check-shard` + `if: !cancelled()` ensures a failing shard surfaces as a failed required check rather than a skipped one (skipped = success in branch protection). Shard-count changes only touch the `matrix.shard:` array; the Ruleset stays untouched.
- **`docker`** (every PR, merge_group, workflow_dispatch) — the pre-merge image gate. Runs the `build-scan-smoke` composite, which builds each image **once** and pushes it straight to GHCR **by digest** (`push-by-digest=true`), then pulls the manifest back to Trivy-scan it (HIGH/CRITICAL) and boot the stack for a runtime smoke — `compose up` against a scratch DB, all four croner registrations, one `node backup-runner.js run` cycle, `load-drill-key` reachability. Catches runtime defects (env-schema drift, `listen_addresses` quoting, ephemeral-pg spawn under the postgres UID) that "does it compile?" misses. Closes with the Tier 1 backup round-trip against the real Postgres binaries (#301). Push-first is what makes the guarantee an identity rather than an argument: what is scanned and smoked _is_ what was published, and the backup image's `FROM` resolves to the app's published digest (`docker-image://<app_repo>@<digest>`) rather than to a separately-exported OCI layout that could — and did — diverge from the pushed bytes. Safety comes from the **naming** boundary, not the push boundary: a digest-only manifest is untagged, so nothing can pull, deploy or promote it until `publish` names it, and a failed scan or smoke simply leaves two unnamed digests behind. Deliberately **not** path-filtered: a filter skips the job on PRs that change image bytes through `src/**`, and a skipped required check counts as met (#355). A fork PR fails here — the push needs a writable token and GitHub hands forks a read-only one — which blocks its merge by design; this repo takes no fork contributions ([ADR-0011](docs/adr/0011-build-images-in-ci-distribute-via-ghcr.md)).
- **`publish`** (non-fork PRs + workflow_dispatch, `needs: [check, lint, docker]`, required status check) — runs the `tag-images` composite, pointing `sha-<pr-tip>` and `<branch-slug>` at the digests `docker` pushed. A registry-side `buildx imagetools create`, not a build. Required not as a fourth image gate but as the ordering constraint: it and auto-merge become eligible at the same instant, so without it `main` advances while the tagging is in flight and `promote`'s guard 3 pays the fallback rebuild. The `needs` list is the safety property: no name resolves to a commit that fails tests, lint, static analysis, an image scan, or the smoke — and because the names land on a digest rather than on a second build's output, the named bytes are the scanned bytes by identity. It used to rebuild and re-scan both images here, which measurably rebuilt rather than re-materialised (run 33424054809: 63s of `npm ci` + `npm run build` inside a 71s "push" whose upload was 5.6s) and therefore published bytes that were never the scanned ones. Fork PRs never reach it: they go red at `docker`, so `needs:` skips this job. The same-repo clause in the `if:` states that boundary where a reader looks for it rather than carrying it. Production images are built in CI, never on the VPS ([ADR-0011](docs/adr/0011-build-images-in-ci-distribute-via-ghcr.md)).
- **`promote`** (push to `main`) — re-tags the `sha-<pr-tip>` image `publish` named on the PR as `main`'s SHA via the same `tag-images` composite (no rebuild, ~30s), after verifying the merge traces to a PR, its tree matches the PR tip, and the image exists on GHCR. Falls back to `build-scan-smoke` then `tag-images` on any guard failure (direct push, `main` advancing between the last green run and the merge, force-push after the last build). Build once, promote on merge — see [ADR-0011](docs/adr/0011-build-images-in-ci-distribute-via-ghcr.md).

**Notify** (`.github/workflows/notify.yml`) — `workflow_run: [CI, Security (scheduled)] / types: [completed]`. GitHub emails a run failure only to the run's **triggering actor**, so a bot-driven failure reaches nobody: Renovate opens the PR, force-pushes it, and — with `platformAutomerge` — merges it, which makes it the actor on the post-merge `push` to `main` as well. Both outcomes are then silent: green merges unattended, red just stalls (#342 sat red for 9 days). Assignment produces a "Participating" notification, delivered regardless of trigger actor or repo watch state.

A `workflow_run` listener rather than jobs inside `ci.yml` for three reasons, all structural: it fires on the completed **run**, so it covers every trigger `ci.yml` has (the in-workflow version only ever saw `pull_request`, leaving a failed `promote` on `main` unreported — worse than the PR case, since that leaves `main`'s image unbuilt); it does not share fate with the workflow it monitors; and it needs no `needs: [lint, check, docker]` mirror of the job graph, which was hand-maintained with no drift guard. It classifies once — `success` → green, `failure`/`timed_out`/`startup_failure` → red, everything else inert (`cancelled` especially: `ci.yml` cancels superseded runs on every force-push, so treating it as red would assign on every rebase and as green would clear a live assignment) — then routes on the run's **originating event**:

- **PR runs** — assign the maintainer on red, clear the assignment on green. Clearing is what makes the signal repeatable: re-assigning an already-assigned user writes no `assigned` event and so raises no notification, meaning without it the mechanism fires once per PR for the PR's whole life (red → fixed → red again → silence). The PR number is resolved from the head SHA via `commits/{sha}/pulls`, filtered to open PRs, **not** from `workflow_run.pull_requests[0]` — that field is undocumented for this event, empty for fork PRs, and live-computed. One path every PR run exercises beats a primary plus a rarely-run fallback.
- **`main` runs** (push and the nightly schedule) — open or update a `ci-red`-labelled issue assigned to the maintainer, closed automatically on the next green run of that workflow. Titled per workflow so a green `CI` cannot close an issue raised by a still-red nightly scan. Routing reads the originating event, never the SHA→PR lookup: the repo squash-merges, so `commits/{sha}/pulls` resolves a `main` commit straight back to its merged PR and would misroute every push-to-main failure.
- **Everything else** — a dispatch run on a feature branch, or a `merge_group` train — is left alone; the operator who triggered it already gets GitHub's own email.

`E2E (manual)` is deliberately **not** monitored: it is flaky, `workflow_dispatch`-only, and outside the merge gate, so wiring it in would manufacture the alert fatigue this mechanism exists to prevent. Known residual gaps, both documented in the workflow header: a run that never queues emits no event at all (only a cron watchdog would catch it — `docs/ops/dep-management.md` § Weekly wrangler is the standing backstop), and `workflow_run` does **not** fire when a monitored workflow fails to start. The second is measured, not assumed — two probes on #349 broke `ci.yml` deliberately (unparseable, then valid YAML with an invalid schema) and neither produced a `Notify` run; the name filter is not the cause, since the workflow entity keeps its registered name. It is left uncovered deliberately rather than worked around, because the case cannot reach `main`: `lint` runs actionlint over `.github/workflows/`, and a PR whose `ci.yml` does not parse reports **no** checks at all, so the required `lint`/`check`/`docker` are never met and it sits blocked.

**Deploy** (`scripts/deploy.sh`) — manual, pull-based, run on the VPS by the operator over WireGuard:

1. Operator is already on the VPS (via WireGuard + sudo); invokes `sudo -u deploy /opt/projekt-manager/scripts/deploy.sh [<ref>]`. Default ref is `origin/main`; pass an explicit SHA for rollback.
2. `git fetch origin`, `git checkout <expected-sha>`, assert `HEAD` landed at the expected SHA (hard-coded guard against a silently failed checkout).
3. Decrypt `/opt/projekt-manager/secrets.env.age` via `age -d`, `source <(...)` with `set -a` so the KEY=VALUE lines reach compose. Plaintext is never written to disk.
4. `APP_IMAGE_TAG=sha-<sha> docker compose --profile backup pull app backup` — fetches both app and backup images from GHCR under the shared SHA tag (no build on the VPS, per ADR-0011). `--profile` is required on pull too, or the backup service is filtered out of the active set.
5. `docker compose --profile backup up -d` — swaps the `app` and `backup` containers to the new images; `db`, `storage`, and `caddy` keep running on their pinned images.
6. Smoke test: `scripts/smoke-app-health.sh` polls `/api/health` from inside the app container for up to 60 s — the same script CI's runtime smoke test and `sync-restore-vps.sh`'s post-restore check use (single source of truth; see the script's header). Failure dumps the last 50 lines of compose logs and exits non-zero, leaving the previously running version in place.

No automatic deploy. Rationale: [ADR-0012](docs/adr/0012-manual-pull-based-deploy-over-wireguard.md). Day-to-day procedure: [docs/ops/manual-deploy.md](docs/ops/manual-deploy.md). Bootstrap (first-run) procedure: [docs/ops/manual-deploy.md#bootstrap-first-run-on-fresh-vps](docs/ops/manual-deploy.md#bootstrap-first-run-on-fresh-vps).

---

## Attachments Module

Spec contract: [docs/spec/data-model.md §5.13](docs/spec/data-model.md#513-attachment) (entity), [docs/spec/api.md §14.2.11](docs/spec/api.md#14211-attachments) (operations), [docs/spec/ui/project-detail.md §8.15](docs/spec/ui/project-detail.md#815-project-detail-page) (UI surface). This section pins the implementation choices that are implementation-specific and therefore live here rather than in the spec.

**Upload entry points (UI).** Two browser surfaces feed the same client pipeline: the drop-zone / file-picker in `src/ui/detail/UploadCta.tsx`, and the floating camera-capture button (`<input type="file" … capture="environment">`) rendered directly in `src/ui/detail/ProjectDetailPage.tsx` so a worker on-site captures a photo without hunting through the form layout.

### Encryption

End-to-end per [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md). Bulk content is encrypted in the browser with AES-256-GCM via WebCrypto; per blob, a fresh nonce is prefixed to the ciphertext and the 16-byte auth tag verifies on decrypt. The 32-byte DEK (data-encryption key) is generated client-side via `crypto.getRandomValues` per attachment, sent to the server in `dekMaterial` at init, and wrapped once with the operator's binary `age` recipient (`KeyEnvelopeService`); the wrapped envelope persists as `wrappedDek` (and, for photos, `wrappedThumbDek`) on the row. The unwrapped DEK is never persisted server-side. B2 sees only ciphertext objects of the sentinel content-type `application/octet-stream`; the row's `mimeType` keeps the plaintext MIME for download `Content-Disposition`. The wrapped-envelope columns are schema-level audit-excluded — declarative on the column rather than enforced per call site, so a future column-rename or new audited mutation cannot leak the envelopes (the AC-pinned test asserts the columns never appear in any audit payload).

### Client image pipeline

`src/domain/imagePipeline.ts` performs all browser-side transformations before the presigned-PUT upload.

- **Supported inputs.** JPEG, PNG, WebP for photos; PDF and DOCX for binaries. HEIC is deliberately **not** supported — the kickoff scope excludes Apple users, and the transcode complexity (libheif decode + EXIF bridge across canvas encode) did not earn its keep against that user base. A HEIC pick is rejected at the `UploadCta` ingress with a German banner that names the supported formats; the server whitelist enforces the same rejection at init as defence in depth.
- **EXIF preservation.** [`@uploadcare/image-shrink`](https://www.npmjs.com/package/@uploadcare/image-shrink) byte-splices the source's APP1/EXIF segment into the re-encoded JPEG via `replaceJpegChunk`, with no IFD parser in the path — GPS EXIF (worker field-capture context) survives the downscale verbatim. The previous library, `browser-image-compression`, parsed the IFD semantically and rejected JPEGs whose Orientation tag was encoded as `LONG` instead of `SHORT` (common on Snapseed-edited Android captures); see issue [#126](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/126).
- **Downscale + re-encode.** Both the original and the WebP thumbnail are resized by longest-edge and re-encoded at the quality targets in `src/config/attachmentPipeline.ts` (the `[C]` catalogue entry "Attachment client-encoding parameters"). The thumbnail is WebP for better compression at thumbnail scale; the original keeps its input format for compatibility with Windows Explorer previews.
- **No offline queue.** The service worker does not intercept attachment uploads — a page reload cancels an in-flight upload cleanly; the server-side orphan reaper removes the `pending` row.

### Server-side orchestration

`src/server/services/AttachmentService.ts` is the single surface that owns the state machine.

- **State machine: `pending → ready ↔ hidden`.** `initUpload` validates the caller-supplied `dekMaterial` / `ciphertextSizeBytes` / `ciphertextContentMd5` per blob, calls `KeyEnvelopeService` to wrap the DEK with the operator's binary `age` recipient, and writes the `pending` row (carrying `wrappedDek` and, for photos, `wrappedThumbDek`) without an audit row — an allowlisted exception; the `attachment:add` row is written later, at `completeUpload`. The presigned-PUT descriptors it returns sign ciphertext metadata (sentinel `application/octet-stream`, `ciphertextSizeBytes`, `ciphertextContentMd5`). `completeUpload` HEADs the objects and asserts ciphertext metadata: `head.size == row.ciphertextSizeBytes` and `head.contentType == 'application/octet-stream'` (per ADR-0024 — the prior plaintext-MIME and prior `startsWith('image/')` thumbnail check are gone). `versionId` / `thumbVersionId` are captured from the HEAD response, the row flips to `ready`, and the `attachment:add` audit row is written through `mutate()` — the authoritative record of the attachment entering the project, with no audit-payload leak of the envelope since `wrappedDek` / `wrappedThumbDek` are schema-level audit-excluded. User-DELETE flips `ready → hidden` via CAS and writes one `attachment:hide` audit row through `mutate()` plus a best-effort delete marker on the versioned bucket; the prior version is the restore source. Restore (`attachment:restore`) flips `hidden → ready` inside `mutate()`, then `copyFromVersion(originalKey, version_id)` (and the thumb counterpart) promotes the prior version back to current. The wrapped-envelope columns are unchanged on restore — the DEK that decrypts the bytes is the same DEK that encrypted them. CAS-loss or `copyFromVersion` failure rolls back both the status flip and the audit row, the user retries.
- **Per-request DEK fetch for download.** `download-url` and `bulk-fetch` unwrap the wrapped envelope per request via `KeyEnvelopeService` (which reads the operator-loaded binary identity from tmpfs) and return the raw `dekMaterial` to the same-origin Service Worker alongside the presigned GET. The unwrapped DEK never leaves the response and is never persisted; downstream auditing of DEK fetches is out of scope (the read is implicit in any `attachment:read`).
- **Bulk fetch.** `createBulkFetch` validates caps (≤20 files, ≤20 MB summed plaintext, all rows at `status='ready'`, all same project) and returns one entry per requested attachment: `{ attachmentId, originalUrl, originalDekMaterial, ciphertextSizeBytes, thumbUrl?, thumbDekMaterial?, ciphertextThumbSizeBytes? }` (two-blob — thumbnails are independent ciphertext objects with their own DEKs). The browser fetches each ciphertext from B2 directly, AES-GCM-decrypts in a `ReadableStream` pipeline, and assembles the zip locally via streaming-zip. No server-side zip is staged; the `bulk-downloads/` prefix and the prior `archiver`-based pipeline are gone.
- **Export-all — server-side job.** The Vollständiger Export action ([docs/spec/ui/daten.md §8.11.1](docs/spec/ui/daten.md#8111-export)) `POST`s `/api/export-jobs`, starting an asynchronous **server-side** build (`export-jobs.ts` → `takeout-export-runner.ts`, [api.md §14.2.4](docs/spec/api.md#1424-unified-data-exchange)). The server decrypts every `status='ready'` attachment and assembles the archive on the VPS: `data.json` (the unified envelope) and `manifest.json` (SHA-256 of every other entry, for offline verification — see [AC-323](docs/spec/verification.md#1514-data-exchange)) at the root, plus every attachment under `attachments/<projektnummer>-<projekt-titel>/<attachment-id>-<dateiname>` (path components sanitised; the `attachment-id` prefix defuses `(projektnummer, dateiname)` collisions). The browser only triggers, polls status, and downloads the finished Range-capable archive via `GET /api/export-jobs/:id/download` — it never assembles the archive or handles plaintext crypto. No thumbnails — plaintext data, not in-app rendering.
- **Import-all is the symmetric mirror — server-side job.** The Vollständiger Import action ([docs/spec/ui/daten.md §8.11.2](docs/spec/ui/daten.md#8112-import)) `POST`s `/api/import-jobs` and uploads the takeout archive to the VPS over a resumable, tus-style chunked `PATCH …/archive` (`import-jobs.ts`; `HEAD` for the resume offset). The **server** validates the envelope, wipes-and-restores the business-data leg in one transaction (override + destructive-confirmation phrase required for a non-empty target, IDs preserved), then re-encrypts and re-uploads every plaintext attachment to B2 — minting a fresh DEK per blob and wrapping it under the importing instance's own `BINARY_AGE_RECIPIENT`. The browser never unzips, hashes, or re-uploads per attachment; the plaintext archive stages only on the VPS, inside the trust radius, per [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md).
- **Orphan reaper.** `src/server/services/attachment-orphan-reaper.ts` removes `status='pending'` rows past their TTL together with their backing objects. Scheduled by `src/server/attachment-orphan-reaper-scheduler.ts` and allowlisted in the architecture check.

### Service Worker decrypt path

A client-installed Service Worker intercepts requests to a synthetic origin so `<img src=…>`, `<iframe src=…>` PDF previews, and `<a href=… download>` keep working unchanged under e2e (per [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md) — the consumer-rewrite alternative was rejected).

- **URL scheme.** `/encrypted-storage/<projectId>/<attachmentId>.<variant>` (variant ∈ `original` | `thumbnail`). The SPA rewrites attachment URLs to this synthetic path; nothing else hits it.
- **Interception flow.** `fetch` event for the synthetic path → call `GET /api/projects/:id/attachments/:attId/download-url?variant=…` → fetch the ciphertext from the returned presigned B2 URL → AES-GCM-decrypt with `dekMaterial` from the same response (nonce is prefixed to the ciphertext) → return a `Response` carrying the plaintext bytes with the row's plaintext `mimeType`. Bulk-fetch uses the same decrypt primitive driven by the per-file payload returned from `bulk-fetch`.
- **Coexistence with the notification SW — resolved: one worker.** The push / `notificationclick` handlers and this e2e-decrypt fetch intercept are merged into a single Service Worker (`src/sw/index.ts`, bundled to `dist/sw.js` and served at `/sw.js`): `install` / `activate` do `skipWaiting` + `clients.claim`, the `fetch` listener handles only the `/encrypted-storage/*` synthetic origin, and `push` / `notificationclick` are registered alongside. ADR-0024 § Confidence had flagged the sibling-vs-merged split as an open spike item; the merged worker is the chosen resolution.

### Boot probe — binary `age` identity

`assertBinaryAgeIdentityLoaded()` runs at startup parallel to `assertStorageBucketSafe()` and refuses to boot if the binary `age` private identity is not present at the configured tmpfs path that the server reads from. Operator-absence (post-reboot, no paste) ⇒ application down — same character as the bucket-safety probe and the ADR-0022 capability self-test, intentional alignment between operational truth ("identity loaded?") and user-facing truth ("can I see attachments?") per [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md). Degraded "uploads-yes-downloads-no" or plaintext-fallback modes are explicitly rejected.

### Storage client surface

`src/server/storage/client.ts` exports an `AttachmentStorageClient` type that narrows the general `StorageClient` to the operations the attachment module uses: `createPresignedPut`, `createPresignedGet` (with optional attachment-disposition filename so the browser saves by `fileName`), `headObject`, `getObject`, `putObject`, `listObjects`, `hide`, `copyFromVersion`, `getBucketSafetyConfig`. The narrower type lets the orphan reaper fail at compile time against a mock that skips a required operation. Per ADR-0022 the destructive surface is a deliberate non-feature — `hide` writes a delete marker, `copyFromVersion` is the restore primitive; an architecture test (`storage-architecture.test.ts`) refuses any `DeleteObjectCommand` carrying a `VersionId` anywhere in `src/`.

**Upload protocol — presigned PUT, not POST policy.** `createPresignedPut` issues a SigV4-signed URL whose canonical request includes `Content-Type` (the sentinel `application/octet-stream` per [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md), not the plaintext MIME), `Content-Length`, and `Content-MD5` — all signed against the **ciphertext's** metadata. The descriptor returned to the browser carries `{ url, headers, expiresAt }` and the browser PUTs the encrypted blob with those headers verbatim. The S3 POST-policy form (`@aws-sdk/s3-presigned-post`) is deliberately not used because B2's S3-compatible API lists "Browser-based uploads to pre-signed URLs using POST" as unsupported — `POST /<bucket>` returns 501 NotImplemented with no CORS headers and surfaces in the browser as a misleading "no Access-Control-Allow-Origin". Presigned PUT is the cross-provider lowest common denominator (AWS, B2, R2, MinIO, Wasabi) and `Content-MD5` is mandated by the [S3 PutObject spec under Object Lock retention](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html), enforced identically by AWS, B2, MinIO, and Wasabi; bucket-default Compliance retention (ADR-0022) attaches Object Lock parameters to every PUT, so every upload falls under that mandate (`bede7fc` established the same constraint on the sync path). The signed MD5 also lets the provider reject bodies that do not match (`BadDigest`); MD5 is not collision-resistant, so the binding is "any bytes hashing to the signed MD5", not "exact bytes" — under the current single-actor flow (same client computes MD5, calls init, PUTs bytes) the distinction is academic.

### Internal vs public storage endpoint

`createStorageClient({ endpoint, publicEndpoint })` takes two URLs. `endpoint` is the host the app's process talks to over HTTP for every call that actually puts bytes on the wire — `putObject`, `getObject`, `headObject`, `listObjects`, `hide`, `copyFromVersion`, `ping`. `publicEndpoint` is the browser-reachable host used ONLY when signing URLs that the app returns to the client: `createPresignedPut` (init upload), `createPresignedGet` (download / `bulk-fetch` per-file pickup), `getSignedUrl`. The two concerns split cleanly because the presigning helpers compute the URL locally — no network call — so pointing their SDK client at a host that resolves only from outside the container does not break. The signing client also sets `requestChecksumCalculation: 'WHEN_REQUIRED'` to suppress the AWS SDK's automatic CRC32 middleware: with the default `WHEN_SUPPORTED`, the SDK precomputes `x-amz-checksum-crc32` over an empty body at signing time and binds it into the signed query string, which would then mismatch against any non-empty browser upload (the integrity guarantee is provided by the signed `Content-MD5` header instead).

Why this exists: the storage endpoint serves both the app server (puts/heads/lists) and the browser (presigned-URL uploads/downloads). For prod (B2) the same public endpoint serves both roles, so `STORAGE_PUBLIC_ENDPOINT` is left unset and signing falls back to `STORAGE_ENDPOINT`. For dev (in-compose MinIO) the two diverge: the app reaches `http://storage:9000` (compose-internal), but the browser must hit `http://localhost:9000` (host-published) — `STORAGE_PUBLIC_ENDPOINT` carries the latter. A startup guard — `assertStoragePublicEndpointInProduction()` in `src/server/config/env.ts` — refuses to boot in production when `STORAGE_ENDPOINT` looks internal (no-dot hostname, non-IP) and `STORAGE_PUBLIC_ENDPOINT` is unset, catching the regression mode where presigned URLs reach the browser pointing at a host it cannot resolve. CORS lives at the storage layer (B2 bucket CORS rule in prod; `MINIO_API_CORS_ALLOW_ORIGIN` in dev). See [docs/ops/object-storage-provisioning.md](docs/ops/object-storage-provisioning.md).

### Bucket safety probe + capability self-test

`assertStorageBucketSafe()` in `src/server/storage/safety.ts` runs once at startup (before reapers schedule) and refuses to boot on:

- **Bucket-shape drift** — versioning off, Object Lock not Compliance with positive default-retention days, lifecycle missing or carrying any rule beyond the canonical `NoncurrentVersionExpiration + ExpiredObjectDeleteMarker` shape (e.g., `Expiration.Days` would auto-hide live data; transitions move storage class), or `R > L` (lifecycle reap blocked by Object Lock retention for `R-L` days — zombie versions every cycle). See [ADR-0022](docs/adr/0022-binary-storage-b2-compliance-object-lock.md).
- **Credential-capability drift** — the running app credential MUST be unable to destroy versions. The capability self-test calls `probeDeleteVersionCapability()` on the storage client, which issues a `DeleteObjectCommand` with a sentinel non-existent `VersionId` against a sentinel key. AccessDenied is the only acceptable outcome (the capability layer refused the call before any object resolution). 2xx success means the credential CAN destroy versions — catastrophic dev/prod drift; refuse to boot. NoSuchVersion / NoSuchKey / network errors are also fail-closed (provider checked existence first, leaks no perms info, so we cannot trust the split).

The complementary positive-cap check — that the credential CAN copy under default Compliance retention — runs at deploy time (`probe-copyobj` in `src/server/deploy-preflight-cli.ts`), not boot time, because it requires a server-side mutation. The B2-specific failure mode is a key missing `writeFileRetentions` (= `s3:PutObjectRetention`): B2 silently hangs `CopyObject` for ~5 minutes per attempt before returning 503; the SDK retries 3× before the user-facing restore call times out at ~17 minutes. The deploy probe binds a short-leash SDK client (25-second per-call timeout, `maxAttempts: 1`) so the same misconfiguration surfaces inside the preflight container, not at first user-clicked Wiederherstellen. See the App key table in [docs/ops/object-storage-provisioning.md](docs/ops/object-storage-provisioning.md) for the cap rationale and the bounded-escalation analysis.

Both halves of the validator are pure functions over structured snapshots; the IO methods on the storage client just shape SDK output. Each fail-path is unit-tested without mocking the S3 SDK. Spec contract: [docs/spec/architecture.md §11.4](docs/spec/architecture.md#114-object-storage-module), [AC-236](docs/spec/verification.md#1526-attachments) (shape probe), [AC-237](docs/spec/verification.md#1526-attachments) (capability self-test). See [docs/ops/object-storage-provisioning.md](docs/ops/object-storage-provisioning.md).

### Architecture detector — no `DeleteObjectCommand` with `VersionId`

[AC-238](docs/spec/verification.md#1526-attachments) is enforced by an AST-based detector in `src/server/__tests__/storage-architecture-detector.ts` and the test wrapping it (`storage-architecture.test.ts`). The detector flags `DeleteObjectCommand` and `DeleteObjectsCommand` constructors anywhere in `src/` that carry a `VersionId` (directly, via a variable-bound argument, nested in `Delete.Objects[*]` for batch deletes, or inside an opaque non-resolvable argument — fail-closed). Aliased imports, namespace imports, and intra-file rebindings are all caught. The single allowlisted site is `probeDeleteVersionCapability` in `src/server/storage/client.ts` — the call the capability self-test MUST make to validate the split. The allowlist is keyed on `{ file, functionName }`; renaming or moving the function requires updating the allowlist in the same commit (the test enforces no other file may declare a function with the allowlisted name).

### Storage usage — trigger-maintained side table

Spec contract: [docs/spec/data-model.md §5.14](docs/spec/data-model.md#514-project-storage-usage) (entity), [docs/spec/api.md §14.2.12](docs/spec/api.md#14212-storage-usage) (read endpoints), [AC-263](docs/spec/verification.md#1526-attachments) through [AC-267](docs/spec/verification.md#1526-attachments). The four-bucket per-project view is realized as a side table maintained by two PL/pgSQL triggers — the canonical Postgres pattern for maintained aggregates over an authoritative source-of-truth table.

- **Side table over columns-on-`projects`.** A new table `project_storage_usage` is keyed by `project_id` with `FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE`. Columns: `space_ready_bytes`, `space_hidden_bytes`, `ciphertext_ready_bytes`, `ciphertext_hidden_bytes` — all `bigint NOT NULL DEFAULT 0`. The columns ride a separate table — not on `projects` — because `projects` is audited and trigger-maintained derived state on an audited table muddies the audit-invariant boundary ([data-model.md §5.10](docs/spec/data-model.md#510-audit-log-entity), [AC-179](docs/spec/verification.md#1523-audit-log)). Isolating derived state in a non-audited side table keeps the single-write-path helper's invariant intact: every audited mutation produces exactly one `audit_log` row, and the storage-usage row is touched by triggers — invisible to that contract.
- **Trigger 1 — `projects_storage_usage_init` (`AFTER INSERT ON projects FOR EACH ROW`).** Inserts a `project_storage_usage` row keyed on `NEW.id` with all four counters at zero. Guarantees every project has its usage row from creation; the attachment trigger (below) only ever issues `UPDATE`, never has to upsert.
- **Trigger 2 — `attachments_storage_usage_delta` (`AFTER INSERT OR UPDATE OR DELETE ON attachments FOR EACH ROW`).** Computes the four-counter delta from `OLD` and `NEW` — `pending` rows contribute zero on every axis; `ready` and `hidden` rows contribute `sizeBytes + COALESCE(thumb_size_bytes, 0)` on the plaintext axis and `ciphertextSizeBytes + COALESCE(ciphertext_thumb_size_bytes, 0)` on the ciphertext axis to the bucket matching their status. The four deltas are applied via a single `UPDATE project_storage_usage SET ... WHERE project_id = ?` so partial application is impossible. The transition matrix this resolves to is documented in the spec ([AC-263](docs/spec/verification.md#1526-attachments)).
- **Cascade short-circuit at the top of the delta trigger.** The first statement is `IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN NULL; END IF;`. The branch skips the `UPDATE project_storage_usage` during a project cascade-delete: the side-table row is itself being cascade-removed via the FK, so the update is wasted work and would target a row that no longer exists in the same transaction. The guard is narrowed to `TG_OP = 'DELETE'` so any future nested non-DELETE trigger context still updates the counter — drift on a missed nested update is recoverable via reconciliation, but silent corruption on a nested update we tried to skip is not. `pg_trigger_depth() > 1` is the cascade signal: a top-level user-DELETE on `attachments` runs at depth 1 (no skip); a `DELETE` propagated from `projects` cascade runs at depth 2 (skip).
- **Concurrency posture.** Concurrent attachment writes against the **same** project serialize on the row-level lock taken by the side-table `UPDATE`; different projects do not contend. Read-modify-write inside one `UPDATE` is atomic by Postgres semantics. For the projected concurrency profile this is irrelevant; the lock is the right shape under any concurrency. Bulk operations on the same project (a multi-row `UPDATE` flipping many attachments to `hidden`) serialize through the same lock — flagged here as a future-optimization candidate (statement-level trigger with transition tables) if observable cost ever emerges.
- **TRUNCATE bypasses per-row triggers.** Postgres fires `FOR EACH ROW` triggers on row-by-row mutations only; `TRUNCATE` skips them. The import-override path in `ImportService` runs `TRUNCATE TABLE attachments, project_workers, projects, customers RESTART IDENTITY CASCADE` and is structurally safe under the side-table design: the FK `ON DELETE CASCADE` propagates the truncate to `project_storage_usage`, wiping it in lockstep with `attachments`. Subsequent re-INSERTs into `projects` re-fire the init trigger, and re-INSERTs into `attachments` re-fire the delta trigger — totals end correct. A future direct `TRUNCATE attachments` (no cascade up to `projects`) would NOT clear `project_storage_usage` and would leave totals stale against an empty attachments table — foreseeable footgun, called out so the regeneration path stays observable.
- **Baseline-tail convention.** Both trigger DDL blocks (one `CREATE FUNCTION` + `CREATE TRIGGER` per trigger, two pairs total) are appended to `src/server/db/migrations/0000_baseline.sql` after the schema body Drizzle generates, alongside the existing `meta_backup_status` seed `INSERT` and the hand-edited `CREATE EXTENSION` for `pg_trgm`. The hand-edited tail is convention rather than infrastructure — `npx drizzle-kit generate` overwrites the schema body but does NOT preserve content past the body; a contributor who regenerates the baseline must reapply the trigger DDL alongside the seed `INSERT` and the extension. The convention is documented here so the regeneration path is unambiguous; missing it is the regression class to watch for. (No incremental migration is added — under the current drop-and-recreate baseline policy, schema edits collapse into the same `0000_baseline.sql`.)
- **Read endpoints.** The per-project endpoint is an O(1) `SELECT` keyed by `project_id`; the global endpoint is a `SUM` over `project_storage_usage`, a small table by construction (one row per project). No cache layer; no `Cache-Control` directive. Reads are already cheap, and a stale cache serves no purpose under the maintained-aggregate pattern.
- **Reconciliation safety net — out of scope here, tracked at #172.** The trigger-maintained invariant is the runtime contract; a reconciliation job that periodically compares the side-table totals against `SUM(sizeBytes + COALESCE(thumb_size_bytes, 0)) GROUP BY (project_id, status)` over `attachments` (and the ciphertext analog) is the safety net for any drift the trigger fails to catch (operator-applied direct SQL, cross-version trigger bug, etc.). Tracked at issue #172 alongside the bucket-side reconciliation that complements the orphan sweeper at #169. This section pins the maintained-aggregate side that makes the reads constant-time.

### Realtime invalidation channel

Spec contract: [docs/spec/architecture.md §11.13](docs/spec/architecture.md#1113-realtime-invalidation-channel), [docs/spec/api.md §14.2.13](docs/spec/api.md#14213-realtime-events), [docs/spec/verification.md §15.28](docs/spec/verification.md#1528-realtime-events), [ADR-0025](docs/adr/0025-realtime-ui-invalidation-via-sse.md). The channel is the cross-session refresh path the storage-usage UI relies on and the foundation for any future SSE-pushed invalidation in v1+.

- **Bus.** `src/server/sse/` owns an in-process subscriber set — one entry per subscribed `SseConnection` (a transport-agnostic writer, not a Fastify `reply`), populated by the `/api/events` route handler. The route handler registers a teardown that removes the subscriber on connection close, error, or process shutdown. Unsubscribe is idempotent. Per-subscriber writer failure (closed socket, slow consumer) is caught, logged, and removes the offending subscriber without affecting siblings.
- **Catalog.** Six events — `storage_usage_changed`, `attachment_changed`, `project_changed`, `invoice_changed`, `audit_changed`, `data_exchange_job_changed`. Names and the `SseEventName` union are defined in `src/config/sseEvents.ts` (code SSOT; `SSE_EVENT_NAMES` also backs the AC-338 subscriber-coverage guard). Per-event emitter lists are pinned in [architecture.md §11.13](docs/spec/architecture.md#1113-realtime-invalidation-channel) (spec SSOT) — not restated here.
- **Emitters (this module).** `src/server/sse/emitters.ts` exposes one typed `emitXChanged()` helper per catalog event; service-layer call sites invoke the matching helper post-commit. Emission is post-commit by construction — a transaction abort emits nothing.
- **Client primitive.** `src/sse/client.ts` opens a browser-native `EventSource` against `/api/events` and exposes `onSseEvent` for typed subscriptions. Reconnect uses the implementation-defined reconnection time mandated by the WHATWG SSE spec (overridable via the server's `retry:` field, not used here); no `Last-Event-ID` replay (events are invalidation hints, not a log).
- **Store fan-in.** `src/state/storageUsageStore.ts` is the single owner of the storage-usage fetch lifecycle for the Footer badge ([docs/spec/ui/index.md §8.1.2](docs/spec/ui/index.md#812-authenticated-state)) and the DatenView row ([docs/spec/ui/daten.md §8.11.3](docs/spec/ui/daten.md#8113-speichernutzung)). It subscribes to `storage_usage_changed` and triggers a refetch of `GET /api/storage-usage`; mount, `visibilitychange → visible`, and post-mutation hooks share the same refresh path.
- **Reverse proxy.** Caddy auto-flushes `Content-Type: text/event-stream`; an explicit `flush_interval -1` directive on the `/api/events` upstream is the defensive belt-and-suspenders so the buffering posture is obvious in the config. Configured at `Caddyfile` (TLS) and `Caddyfile.http` (HTTP-only overlay, ADR-0013), both at the repo root.
- **Heartbeat.** `:` keepalive comment line at the configurable heartbeat interval **[C]** (default 25 s, bounded 1 s … 600 s, env `SSE_HEARTBEAT_INTERVAL_MS`); independent per connection, not coordinated across the subscriber set. Each tick also re-validates the session (`AuthService.isSessionValid`) and ends the stream on revocation — security detail in [§11.13](docs/spec/architecture.md#1113-realtime-invalidation-channel).

---

## Invoices Module

Spec contract: [docs/spec/data-model.md §5.15–§5.17](docs/spec/data-model.md#515-invoice-entity) (entities), [docs/spec/api.md §14.2.14–§14.2.15](docs/spec/api.md#14214-invoice-operations) (operations), [docs/spec/ui/invoices.md §8.16](docs/spec/ui/invoices.md#816-invoices-view) + [project-detail.md §8.15.11](docs/spec/ui/project-detail.md#81511-invoice) + [daten.md §8.11.4](docs/spec/ui/daten.md#8114-company-profile) (UI), [ADR-0026](docs/adr/0026-invoices-immutability-and-zugferd.md). This section pins implementation choices that fall under §14 / §14a UStG and GoBD compliance.

### Immutable snapshot at issuance

`InvoiceIssueService.issue` opens a single transaction that allocates the number, freezes the content, flips the project, renders the PDF/A-3, writes the binary descriptor, and emits the audit row + `invoice_changed` SSE frame. The wire shape sealed on issuance — `issuer` (copied from `company_profile`), `recipient` (copied from the project's customer), `lines`, `taxMode`, `profile`, `totals`, `performanceDate` — is then immutable for GoBD. Subsequent PATCH attempts return `INVOICE_FROZEN` and DELETE on issued is refused at the service layer; beneath both, a Postgres `BEFORE UPDATE` trigger (`invoices_enforce_immutability` in `src/server/db/migrations/0000_baseline.sql`) is the persistence-layer backstop — it rejects every column change on an `issued` row except the `status → cancelled` flip and its `updated_at` / `updated_by` bump, so even a raw SQL write that bypasses the route and service layers cannot mutate a frozen invoice. The spec keeps the mechanism abstract ([AC-294](docs/spec/verification.md#1530-invoices) — trigger, constraint, or invariant); the trigger is the concrete choice today. Cancellation produces a Stornorechnung as a sibling row (`cancellationOf` points to the original) — the original stays untouched. A correction is a fresh draft → issue cycle, never an edit.

### Gapless year-scoped sequence

`invoice_sequence` carries one row per `(year, kind)` (`kind ∈ 'invoice' | 'storno'`). Allocation is a single `INSERT … ON CONFLICT (year, kind) DO UPDATE SET next_value = next_value + 1 RETURNING next_value` against the matching row — Postgres takes a row-exclusive lock equivalent to `SELECT FOR UPDATE`, allocated atomically inside the issuance transaction. The single statement collapses the first-of-year case (INSERT) and the steady-state case (DO UPDATE) into one race-free path. The lock holds until commit, so a rollback returns the value to the sequence — the canonical Postgres gapless-counter pattern. Postgres `SERIAL` / `IDENTITY` are incompatible by design (they advance on rollback). The `RE-YYYY-NNNN` / `ST-YYYY-NNNN` format is pinned by a DB `CHECK` constraint so a wire-shape bug cannot insert a malformed number even via raw SQL. The year segment is the JS-side wall-clock UTC year (`new Date().getUTCFullYear()`) captured at the start of the issuance atom; a year-end issuance does not reuse the prior year's counter even if the row sits over the boundary.

### Service split

`src/server/services/InvoiceService.ts` is the route-facing facade; four focused services own the issuance/cancellation moving parts (read-only bulk export lives separately in `InvoiceExportService.ts` — see the `archiver` row under [Dep lifecycle health](#dep-lifecycle-health-as-of-2026-05-15)):

- **`InvoiceIssueService`** — draft CRUD + the issue transaction (sequence allocation, content freeze, project status flip to `abgerechnet`, render via `InvoiceRenderer`, binary write via `InvoiceBinaryService`, audit + SSE).
- **`InvoiceCancelService`** — Storno-sibling creation, audit + SSE. Does NOT auto-revert project state ([AC-290](docs/spec/verification.md#1530-invoices) trailing clause): a user staring at an `abgerechnet` project with a cancelled invoice sees the gap and acts on it manually.
- **`InvoiceBinaryService`** — wraps the binary-descriptor flow for the rendered PDF/A-3. Sits on top of the same `BinaryDescriptorService` the attachment module uses, with the company-tax retention applied per `INVOICE_OBJECT_LOCK_DAYS`. Unlike attachments, the descriptor is server-rendered (no client encrypt path): the PDF/A-3 is constructed server-side, then PUT to B2 under the same E2E-encryption envelope ([ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md)) so the storage layer sees only ciphertext.
- **`InvoiceRenderer`** — orchestrates the PDF/A-3 + `factur-x.xml` build (see below). Returns the bytes; the binary service owns persistence.

### ZUGFeRD EN 16931 renderer

`src/server/services/InvoiceRenderer.ts` drives a Node-native pipeline (no headless browser, no external service):

- **PDF/A-3 base.** `src/server/services/invoice/pdfDrawer.ts` lays out the visible invoice using `@cantoo/pdf-lib` (maintained fork of the dormant upstream `pdf-lib`) — German typography, EUR/DE numerics, address block, per-line table, totals breakdown, tax-mode boilerplate (Kleinunternehmer §19 or Reverse-Charge §13b text where applicable), IBAN footer when set on the profile. Output is conformance level PDF/A-3 (no JavaScript, no external resources, embedded fonts, XMP metadata, color profile).
- **Embedded `factur-x.xml`.** `src/server/services/invoice/facturXmlBuilder.ts` emits the EN 16931 Comfort profile XML from the snapshotted invoice fields. `src/server/services/invoice/xsdValidator.ts` validates the payload against the canonical EN 16931 schemas at `src/server/services/invoice/xsd/` before embed; a validation failure throws and the surrounding issuance transaction rolls back (no non-conformant binary on B2). Industry shape: Mustangproject, akretion factur-x, SAP / Datev all XSD-validate at render time. The XML is then attached to the PDF as a Factur-X-compliant file attachment (relationship `Alternative`, AFRelationship metadata on the embedded file spec).
- **Profile column.** `invoices.profile` snapshots the renderer profile (`zugferd-en16931` today) so the UI's PDF download affordance can label itself appropriately (`ZUGFeRD herunterladen` vs the generic `PDF herunterladen`). A future XRECHNUNG renderer drops in as a sibling builder keyed off the same column.
- **Boilerplate.** `src/server/services/invoice/boilerplate.ts` carries the German tax-mode legal text — `kleinunternehmer` (§19 UStG: "Gemäß §19 UStG wird keine Umsatzsteuer berechnet."), `reverse_charge` (§13b UStG reverse-charge notice). Single source of truth so a §-text revision is one file.

### Object Lock retention — env-driven

`INVOICE_OBJECT_LOCK_DAYS` is the retention envelope `assertStorageBucketSafe()` enforces against the bucket-level default-retention for the configured invoices bucket. Prod: 3650 (10 years per §147 AO). Dev: 0 (no retention, drop on `force` reseed). The bucket-shape probe verifies the configured retention is **≥** the env value at boot — a configured shorter retention than the env requires fails closed. Per [AC-296](docs/spec/verification.md#1530-invoices), the bucket may legitimately carry a longer retention than the env (e.g. tightened compliance horizon) without failing the probe — the env names the minimum, not the equality.

### Tax modes (per-invoice, snapshotted)

`taxMode ∈ 'standard' | 'kleinunternehmer' | 'reverse_charge'` is snapshotted onto each invoice at draft creation (defaulted from `company_profile.defaultTaxMode`); editable on the draft, frozen at issuance. The mode drives both the totals computation (no per-line tax for kleinunternehmer + reverse_charge; per-rate breakdown for standard) and the renderer boilerplate. `company_profile.ustId` is structurally optional; the issue gate refuses when the snapshotted mode is `standard` or `reverse_charge` and the profile's `ustId` is empty (`COMPANY_PROFILE_REQUIRED`). The UI's company-profile form mirrors the validation as a UX affordance ([docs/spec/ui/daten.md §8.11.4](docs/spec/ui/daten.md#8114-company-profile)); the server is authoritative.

### `company_profile` singleton

One row per deployment, pinned by `UNIQUE(singleton) + CHECK(singleton = true)`. Owner-only mutation through `PUT /api/company-profile`; every authenticated role may read so the values invoices will snapshot are visible (office / worker / bookkeeper see a read-only summary on the Daten view). No dedicated `company_profile:*` permission key — the route-layer role check is the gate (mutations restricted to `owner`). Logo upload is not yet wired client-side — the schema's `logoBinaryDescriptorId` column is present but the orphan (non-project) binary-descriptor pipeline is a follow-up; the form sends `null` until that lands.

### Realtime + repository scope

`invoice_changed` SSE frames emit post-commit from the issue / cancel / draft-CRUD paths through `src/server/sse/emitters.ts`. The browser-side store fan-in mirrors the storage-usage pattern: `src/state/invoiceStore.ts` owns per-project cache; `src/state/invoiceListStore.ts` owns the cross-project `/rechnungen` view; both refresh on `invoice_changed` via `src/state/invoiceSseSubscription.ts` (the auth-gated `useEffect` in `src/App.tsx` is the only entry point). Worker callers are excluded structurally via the repository scope predicate ([ADR-0019](docs/adr/0019-worker-data-scoping-repository-layer-predicate.md)) — no `invoice:read` permission gate on the list / get routes (a worker probe returns `200 + []` for list, `404` for single-row, never `403` — matches the spec contract that worker exclusion is invisible).

### Dep lifecycle health (as of 2026-05-15)

[ADR-0026](docs/adr/0026-invoices-immutability-and-zugferd.md) delegates its lib choice here. Per [ADR-0027](docs/adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md), this table is the canonical source for the invoice rendering pipeline's deps.

| Dep                  | Last release                                                                               | License         | Maintainership                  | Notes                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ | --------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cantoo/pdf-lib`    | 2.6.5 (2026-03-20)                                                                         | MIT             | active maintainer               | Maintained fork of upstream `pdf-lib` (last upstream publish 2021-11-06). Adopted per audit [#187](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/187) to replace the dormant upstream. [deps.dev](https://deps.dev/npm/%40cantoo%2Fpdf-lib) |
| `xmllint-wasm`       | 5.2.0 (2026-03-24)                                                                         | MIT             | `noppa/xmllint-wasm`, active    | Pure-WASM XSD validator. Replaces unmaintained `libxmljs2` ([#192](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/192) / PR #194). Drops the only native binding from the project's dep graph. [deps.dev](https://deps.dev/npm/xmllint-wasm) |
| `archiver`           | 8.0.0 (per [#187](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/187) bump) | MIT             | active                          | Server-side ZIP for bookkeeper bulk-export. [deps.dev](https://deps.dev/npm/archiver)                                                                                                                                                                       |
| EN 16931 XSD schemas | Bundled from `akretion/factur-x@d7fa1e7`                                                   | EU/CEN standard | Versioned at the standards body | Standards-track artifact (not a runtime dep); refreshed when the standard publishes a new version.                                                                                                                                                          |

---

## Design Decisions (Not ADR-Worthy)

- **Export format**: JSON only. Unified envelope shape defined in [docs/spec/data-model.md §5.8](docs/spec/data-model.md#58-export-envelope).
- **Project number format**: configurable `[C]`, enforced only for uniqueness.
- **Customer duplicates on create**: the single-create form offers to edit existing. Unified import preserves IDs and wipes-then-restores (see [ADR-0018](docs/adr/0018-data-persistence-and-recovery-layered-strategy.md)) — no merge semantics.
- **Project site address vs customer billing address**: `customers.address` is the Rechnungsadresse and `projects.siteAddress` is the Baustellen-/Leistungsadresse — two columns on two tables, the standard ERP/CRM split (SAP, Odoo, Stripe, Lexware/sevDesk). Null `siteAddress` means "site is at the customer's billing address" (see [docs/spec/data-model.md §5.1](docs/spec/data-model.md#51-project-entity)). A normalized `addresses` table with a kind enum was rejected — no concrete need for multiple billing addresses per customer.
- **Bulk transitions**: not supported. Users transition individually.
- **Client-side routing**: declarative mode — `<BrowserRouter>` in `src/main.tsx` wrapping `<Routes>` in `src/App.tsx`. Data-router / framework mode (`createBrowserRouter`, loaders, actions, RSC) is not used, so v8's middleware, trailing-slash and pass-through-request semantics do not apply. `src/config/routes.ts` is the single route table — URL ↔ view key, declarative access rule, per-role landing; `Header` nav and the `App` guard both derive from it. **Import everything from the `react-router` root.** `react-router/dom` holds only `RouterProvider` / `HydratedRouter`, for RSC and framework-mode SSR; the upstream v8 changelog wrongly implies `BrowserRouter` lives there too.
- **Escape-to-dismiss**: one rule, two primitives, no hand-rolled `keydown`. Any surface that closes on Esc registers on the shared LIFO `src/hooks/escapeStack.ts` so only the topmost surface dismisses. Full modal dialogs (focus trap + scroll lock + focus restore) use `src/ui/common/useDialogA11y.ts`; everything else — side panels, popovers, lightboxes, the worker filter — uses the lightweight `src/hooks/useEscapeKey.ts`. Components do **not** attach their own `document`/`window` `keydown` listeners (the cause of the "two overlays both close on one Esc" class of bug). Accessibility (focus trapping, `aria-modal`, screen-reader semantics) is deliberately _not_ a goal here — the convergence is purely about consistent, stack-correct dismissal.
- **Menu close on outside click**: shared `src/ui/common/MenuBackdrop.tsx` primitive — invisible fixed-inset overlay rendered as a sibling before the open dropdown. The browser hit-tests the backdrop first, so a single click closes the menu without also activating the element underneath. Replaces the document-level `mousedown` listener pattern (cause of issue #130).
- **Global error handler — 4xx pass-through.** The Fastify error handler in `src/server/error-handler.ts` (installed by `app.ts`) honors `error.statusCode` whenever it is in the 4xx range, mapping the error to an `AppError` that preserves the original statusCode and surfaces a stable machine-readable code (`VALIDATION_ERROR` for transport-layer rejections at 400/413/415, `ROUTE_NOT_FOUND` for 404 from `setNotFoundHandler`). 5xx FastifyErrors and any error without a statusCode collapse to `SERVER_ERROR`. The mapping helper (`mapFastify4xx` in `src/server/errors.ts`) is the only place that consumes Fastify's `code`/`statusCode` shape — adding a new transport-layer rejection class is a one-file change there. Pins [AC-247](docs/spec/verification.md#157-engineering) / [api.md §14.4.2](docs/spec/api.md#1442-error-principles).
- **DB pool + process error supervision.** Every `pg.Pool` gets the canonical 'error' listener via `attachPoolErrorHandler` in `src/server/db/connection.ts`; `src/server/start.ts` also registers `uncaughtException` and `unhandledRejection` handlers that emit a single structured log line and exit non-zero. Pool listeners are required by node-postgres — idle clients emit 'error' when their backend is terminated externally (`scripts/ops/sync-restore-vps.sh` runs `pg_terminate_backend` before restoring the DB), and without a listener the process crashes. The container restart then wipes the tmpfs binary identity per [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md). Process-level handlers are the Node.js production baseline for anything that escapes module-level handling.
- **Documentation drift guards.** Seven checks in the `lint` job, each failing the build rather than warning. Three _generate_ a published artifact from the code that owns it and fail on drift: the role-permission matrix (AC-343, `scripts/generate-permissions-doc.ts`), the per-role nav matrix (AC-349, `scripts/generate-nav-doc.ts`), and the OpenAPI document (AC-351, `scripts/generate-openapi.ts` — see [§ OpenAPI Document Generation](#openapi-document-generation) for what it does beyond drift). Four _verify_ without generating, because the prose they protect is not derivable: every repository path cited in a code span resolves (AC-347, `scripts/check-doc-paths.sh`); the Module Map and the tree agree in both directions for any directory with a `#### <dir>` subsection (AC-350, `scripts/check-module-map.sh`, with the gated set recorded in `scripts/module-map-gated.txt`); every relative link and `#anchor` resolves (AC-348, `lychee`); every spec §15 AC has a row in `docs/testing/traceability.md` and vice versa (S-ACTR, `scripts/check-traceability.sh` — a `[crit]` AC with no test reference warns without failing). Note what generation buys and what it does not: a generated table agrees with its source by construction, so the binding assertion stays hand-written — `ROUTE_TABLE` in `src/config/__tests__/routes.test.ts` for the nav matrix.
- **Link checking uses `lychee`, not a script or an npm plugin.** Config in `lychee.toml`, shared by the CI step (`lycheeverse/lychee-action`, SHA-pinned, `lycheeVersion` Renovate-tracked) and `npm run check:links`, so a local run and CI cannot diverge. The two requirements #289 established the hard way are the two that are easy to get wrong, and both are stock behaviour: GitHub's heading-slug algorithm (`"A & B"` → `a--b`, duplicate `-1` suffixes included) and inline HTML anchors (ADR-0020's `<a id="retention">`, cited ten times across eight documents — a heading-only checker reports every one of them broken). Rolling our own means owning GitHub's slugger forever. The cost is a Rust binary in a Node repo: `scripts/check-links.sh` prefers a native `lychee` and falls back to the pinned container image, so the only hard prerequisite is a container runtime. `remark-validate-links` would have stayed inside the npm toolchain, but its anchor sources are mdast node properties (`hProperties.id`, `hProperties.name`, `data.id`) rather than raw HTML — the inline-anchor requirement is what decided it. `offline = true` — external and `mailto:` targets are never resolved, so a third-party host cannot fail the build.
- **Configuration boundary** (see [docs/spec/architecture.md §12.6](docs/spec/architecture.md#126-feature-manifest-and-operator-confidence) / spec ACs 228–231): operator-supplied config flows through three checkpoints — a CI gate diffing the Zod schema (`src/server/config/env.ts`) against `.env.production.example` ∪ `secrets.manifest.txt` (`scripts/check-env-drift.sh`); a deploy pre-flight invoking `validateEnvAggregated()` against the loaded `.env` before `docker compose up` (`scripts/deploy.sh` → `src/server/deploy-preflight-cli.ts`); and a boot-time feature manifest log line (`event = 'config-feature-manifest'`) emitted by `start.ts` reporting every feature in `src/server/config/features.ts:FEATURE_CATALOG` as `enabled` or `disabled (reason)`. The catalog is single-source-of-truth for feature ↔ required-vars; `featureStatus(env, feature)` is the only path for "is this feature wired?". The boot path uses `validateEnvRuntime()` (schema + dev-default credential guard); the aggregated form runs every cross-field guard in one pass so a misconfigured deploy reports every offending key in one error and iterates once, not N times.

---

## Links

| Resource                        | Location                                           |
| ------------------------------- | -------------------------------------------------- |
| Product specification           | [docs/spec/](docs/spec/index.md)                   |
| Architecture Decision Records   | [docs/adr/](docs/adr/index.md)                     |
| Contributing guide and workflow | [CONTRIBUTING.md](CONTRIBUTING.md)                 |
| Data persistence and recovery   | [DATA.md](DATA.md)                                 |
| Vision and kickoff              | [docs/project/kickoff.md](docs/project/kickoff.md) |
