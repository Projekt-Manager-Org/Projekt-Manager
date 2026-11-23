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

### 12.2 Company-Configurable Settings

The `[C]` values. A deployment changes one through the env var or the place its entry names; an entry naming neither is a source constant — a code change and a redeploy.

- Branding — what each value reaches ([AC-743](verification.md#1520-branding)):
  - App name — the header wordmark, the login heading, the document title, the installed app's name, and the title of a push notification that carries none.
  - Short name — the installed app's home-screen label.
  - Footer brand line — the application footer. Not the invoice footer text ([data-model.md §5.17](data-model.md#517-company-profile-entity)).
  - Shell theme color — the browser and installed-app chrome.
  - Shell background color — the installed app's splash.
  - Brand accent — one value per theme, on the surfaces of [AC-114](verification.md#1519-theming), each meeting [AC-748](verification.md#1519-theming) contrast against the surfaces it sits on and the text it carries.
  - Generic mark colors — the header mark while no logo is configured.
  - Logo — optional; the header mark at every width and the invoice issuer block ([AC-746](verification.md#1520-branding)). Used on the invoice only when it names, by an absolute same-origin path, a PNG or JPEG file of at most 2 MB under the served `brand/` directory. A deployment ships its own; this generalized system ships none ([ADR-0001](../adr/0001-generalized-system-with-configurable-customer-specifics.md)).
- Favicon and installed-app icons — files, not values: a deployment replaces them.
- Workflow state configuration — labels, colors, order, count, aging thresholds, collapse tiers ([index.md §3](index.md#3-workflow-states)).
- German UI and error strings.
- Date and locale display settings.
- Password policy — [data-model.md §5.3](data-model.md#53-user-entity).
- Session duration — [data-model.md §5.4](data-model.md#54-session).
- Role set and per-role permission matrix — [index.md §4.2](index.md#42-roles), [api.md §14.3](api.md#143-authorization-rules).
- Restore confirmation phrase — typed to confirm an import that replaces business data; matched case-sensitively, ignoring surrounding whitespace ([AC-592](verification.md#1514-data-exchange)).
- Backup and drill schedule — the times backups and drills start ([AC-616](verification.md#1522-backup-and-recovery)).
- Backup freshness thresholds — full days of age of the last backup and of the last drill beyond which the backup badge turns amber and red ([ui/index.md §8.1.2](ui/index.md#812-authenticated-state)). Defaults: backup amber 2 / red 4, drill amber 14 / red 30.
- Backup public recipient — the operator's `age` public recipient every backup is encrypted to ([AC-167](verification.md#1522-backup-and-recovery), [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)). No default; required in production ([AC-774](verification.md#1522-backup-and-recovery)). Env var: `AGE_RECIPIENT`.
- Audit retention window — default 90 days ([AC-632](verification.md#1523-audit-log)). Env var: `AUDIT_RETENTION_WINDOW_DAYS`.
- Audit entry text — the German text each audit entry shows in the activity feed ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed)) and the Aktivität view ([ui/management.md §8.13](ui/management.md#813-audit-view)).
- Realtime heartbeat — used by [AC-275](verification.md#1528-realtime-events) and [AC-27](verification.md#154-authentication). Default 25 s, from 1 s to 600 s. Env var: `SSE_HEARTBEAT_INTERVAL_MS`.
- Audit page size — entries per page of the activity feed and the Aktivität view ([AC-628](verification.md#1523-audit-log)).
- Rate limits — attempts per client address per minute ([AC-772](verification.md#154-authentication)): sign-in 5 in production, env var `LOGIN_RATE_LIMIT_MAX`; password change 5, source constant.
- Attachment size caps — of an uploaded original, default 1 MB, and of a photo's thumbnail, default 200 KB ([data-model.md §5.13](data-model.md#513-attachment)). Env vars: `ATTACHMENT_PER_FILE_CAP_BYTES`, `ATTACHMENT_THUMB_CAP_BYTES`.
- Bulk-download caps — files and summed size per request, default 20 files and 20 MB ([AC-415](verification.md#1526-attachments)). Env vars: `ATTACHMENT_BULK_MAX_FILES`, `ATTACHMENT_BULK_MAX_BYTES`.
- Takeout staging TTL — default 24 hours ([AC-589](verification.md#1514-data-exchange), [AC-599](verification.md#1514-data-exchange)). Env var: `TAKEOUT_STAGING_TTL_MINUTES`.
- Takeout staging directory — where export and import jobs keep their plaintext archive; disk-backed in production ([AC-773](verification.md#1527-configuration-and-feature-manifest)). Env var: `TAKEOUT_STAGING_DIR`.
- Mobile-warning breakpoint — [AC-606](verification.md#1514-data-exchange). Default 480 CSS px.
- Orphan-reaper TTL — default 15 minutes ([AC-408](verification.md#1526-attachments)). Env var: `ATTACHMENT_ORPHAN_REAPER_TTL_MINUTES`.
- Hidden-reaper TTL — how long the Papierkorb keeps an attachment ([AC-426](verification.md#1526-attachments)); equal to `L`. Default 2 days. Env var: `ATTACHMENT_HIDDEN_REAPER_TTL_MINUTES`.
- Storage capacity declaration — the stored volume the bucket is provisioned for, in GB of 1024³ bytes ([AC-667](verification.md#1533-threshold-monitor), [AC-669](verification.md#1533-threshold-monitor)). No default. Env var: `STORAGE_QUOTA_GB`.
- Threshold-monitor policy — warn band, default 80% of the declared capacity; clear line, default 2 points below it; sweep interval, default 15 minutes; re-notify window, default 24 hours ([§15.33](verification.md#1533-threshold-monitor)).
- Worker self-delete grace — default 15 minutes ([AC-411](verification.md#1526-attachments)). Env var: `ATTACHMENT_WORKER_SELF_DELETE_GRACE_MINUTES`.
- Attachment label names — the German name of each label ([data-model.md §5.13](data-model.md#513-attachment)): `angebot` → `Angebot`, `auftragsbestaetigung` → `Auftragsbestätigung`, `rechnung` → `Rechnung`, `aufmass` → `Aufmaß`, `foto` → `Foto`, `sonstiges` → `Sonstiges`.
- Photo encoding parameters — longest edge and quality of the image and of its thumbnail ([AC-404](verification.md#1526-attachments)).
- Compliance retention `R` and Papierkorb window `L`, in days — set on the bucket by the operator, not by the system; the system refuses to start unless `R ≤ L` ([AC-236](verification.md#1526-attachments), [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- Binary attachment public recipient — the operator's `age` public recipient every attachment key is wrapped for ([AC-400](verification.md#1526-attachments), [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)). Required, no default. Env var: `BINARY_AGE_RECIPIENT`.
- Binary attachment retired recipients — the public recipients of retired binary keypairs, unwrap only ([AC-438](verification.md#1526-attachments), [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md) § Key rotation). Comma-separated, whitespace around entries ignored; an empty or malformed entry fails validation ([AC-231](verification.md#1527-configuration-and-feature-manifest)); a duplicate, or the active recipient, has no effect. Default empty. Env var: `BINARY_AGE_RETIRED_RECIPIENTS`.
- Invoice lock period — days from write ([AC-710](verification.md#1530-invoices), [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md)). An integer ≥ 0; 0 writes no lock. Default 3650 in production, 0 elsewhere. Env var: `INVOICE_OBJECT_LOCK_DAYS`.

**Not `[C]`.** Not company settings: deployment wiring, secrets, run modes and the LLM model; how often a reaper or the bucket-orphan prune runs, and the prune's grace window. A value a company would need to change belongs in the list.

### 12.6 Feature Manifest and Operator Confidence

An optional feature runs only while every value it needs is set:

| Feature                 | Needs                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Push notifications      | `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`                                                    |
| Email extraction        | `OPENROUTER_API_KEY` ([AC-734](verification.md#1518-email-data-intake))                 |
| First-run administrator | `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`                                  |
| Backup                  | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`, `AGE_RECIPIENT` |

Backup is not optional in production ([AC-774](verification.md#1522-backup-and-recovery)). A deploy refuses an invalid configuration ([AC-231](verification.md#1527-configuration-and-feature-manifest)); each start reports which features run ([AC-230](verification.md#1527-configuration-and-feature-manifest)).

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
5. **Rate limiting**: on sign-in and password change ([AC-772](verification.md#154-authentication)). No other endpoint carries a limit the contract defines — at current scale with VPN-only access ([ADR-0008](../adr/0008-vpn-first-network-access.md)), this is a known, accepted limitation.
6. **CSRF protection**: mechanism defined in [ADR-0005](../adr/0005-session-management-httponly-cookies.md).
7. **Password handling**: never log or store plaintext (see [ADR-0006](../adr/0006-password-policy-nist-blocklist.md)).
8. **Ownership derivation on self-scoped surfaces**: on caller-owned resources (e.g., push subscriptions — [AC-654](verification.md#1524-notifications)), the server derives the owning user id from the session; a client-supplied owner id is refused ([AC-516](verification.md#1517-data-integrity)).
