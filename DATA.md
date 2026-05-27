# Data — Persistence and Recovery

Bird's-eye map of how data survives in this system. This file is a navigation aid; all procedures, schemas, and rationale live in the files linked below.

The kickoff commits to automated DB backup ([kickoff line 72](docs/project/kickoff.md#L72)) but declares "a backup concept and system beyond that" out of scope ([kickoff line 80](docs/project/kickoff.md#L80)). The design here is framed accordingly — **mitigation of an unreliable project, not long-term archaeology.** If a data-integrity problem slips past the retention window undetected, recovery is out of scope.

---

## Three layers

Each class of data has different size, portability, and durability properties, so each gets its own tool and its own verification story. The layers are **complementary, not substitutes** — see [ADR-0018](docs/adr/0018-data-persistence-and-recovery-layered-strategy.md) for why.

| Layer                      | Captures                                                                          | Trigger                    | Off-site                                                                       | Status  |
| -------------------------- | --------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------ | ------- |
| **1 — Business data**      | Users, company profile, customers, projects, assignments, invoices, archived rows | Manual UI export / restore | No (file download)                                                             | Shipped |
| **2 — Full DB state**      | Everything in PostgreSQL (the Layer 1 set plus sessions, audit log, schema)       | Scheduled, automatic       | Yes (encrypted with `age`, R2)                                                 | Shipped |
| **3 — Binary attachments** | Uploaded files (photos, Aufmaß, PDFs, DOCX)                                       | Continuous (presigned PUT) | Provider-owned (B2 versioning + Object Lock), e2e per-blob (`age`-wrapped DEK) | Shipped |

---

## Layer 1 — Business data (portability, not DR)

Human-triggered full-account export/import via the **Daten** view, run as a **server-side asynchronous job** — `data.json` (the unified text envelope) plus every `status='ready'` attachment as a plaintext zip entry, with a `manifest.json` carrying per-entry SHA-256 for offline verification. Restore-only semantics (empty target → proceed; non-empty → refuse unless confirmed with the destructive phrase). IDs preserved; the business-data leg is a single transaction. The server builds the export archive (decrypt → assemble) and processes the import archive (validate → restore → re-encrypt each attachment to B2); the browser triggers, polls, and uploads/downloads over a resumable channel but never handles bulk plaintext crypto. The plaintext archive stages only on the VPS, inside the trust radius — never on B2, per [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md).

- **Rationale and scope:** [ADR-0018](docs/adr/0018-data-persistence-and-recovery-layered-strategy.md) (text + envelope), [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md) (full-account takeout — server-side attachment re-encryption)
- **API contract:** [spec api.md §14.2.4 — Unified Data Exchange](docs/spec/api.md#1424-unified-data-exchange)
- **UI:** [spec ui/daten.md — Daten view](docs/spec/ui/daten.md#811-daten-view)
- **Envelope shape:** [spec data-model.md §5.8](docs/spec/data-model.md#58-export-envelope)
- **Code:** `src/server/services/{ExportService,ImportService}.ts` (business-data leg, reused by the jobs), `DataExchangeJobService` + the server-side export/import job runners (archive build / restore + re-encrypt). The former browser orchestrators `src/ui/management/{exportAllAsZip,importAllFromZip}.ts` retire with the rewire.

Sessions are excluded by design (per-instance auth state, not portable). Users (including `passwordHash`) ride verbatim in the envelope so a fresh-install restore reproduces the operator's user set without an out-of-band password-reset pass; rationale and threat-model in [ADR-0018](docs/adr/0018-data-persistence-and-recovery-layered-strategy.md). First-install user creation when no envelope is present is handled by admin bootstrap ([ADR-0010](docs/adr/0010-first-run-admin-bootstrap.md)).

Layer 1 is portability, not cross-trust-boundary transport — the envelope is plaintext. Moving the file across hosts means encrypting it first; ADR-0020's age recipient is the obvious choice.

---

## Layer 2 — Full DB state (the DR anchor)

Scheduled encrypted `pg_dump` → R2. Every run is verified on-create (Tier 1); whenever the operator's decryption key is loaded on the VPS, every run is also verified on-cycle (Tier 2). A freshness badge on the login screen and the owner's landing view surfaces failure loudly.

- **Design rationale:** [ADR-0020](docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)
- **Contract:** [spec architecture.md §11.10](docs/spec/architecture.md#1110-full-state-backup-layer-2), [verification.md §15.22](docs/spec/verification.md#1522-backup-and-recovery)
- **Operator procedures:** [docs/ops/backup/](docs/ops/backup/overview.md) — setup, recovery, drills, troubleshooting
- **Code:** `src/server/services/{backup,backup-drill,ephemeralPg,r2Uploader}.ts`; shell wrappers in `scripts/backup/`

**Retention is linear, not GFS.** No weekly/monthly promotion. Canonical values and scope rationale: [ADR-0020 §Retention](docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention).

---

## Layer 3 — Binary attachments (provider-enforced durability + e2e)

Uploaded files live on Backblaze B2. The app key cannot destroy versions; "deletion" surfaced to users is a hide on the versioned bucket, real destruction is a provider-side lifecycle action only. A finite-window Compliance Object Lock backstop catches operator-side mistakes during the first `R` days of every version. Boot-time bucket-shape, capability self-tests, and binary-identity probe refuse to start on drift.

- **Design rationale:** [ADR-0022](docs/adr/0022-binary-storage-b2-compliance-object-lock.md) (durability), [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md) (confidentiality)
- **Contract:** [spec data-model.md §5.13](docs/spec/data-model.md#513-attachment), [api.md §14.2.11](docs/spec/api.md#14211-attachments), [verification.md §15.26](docs/spec/verification.md#1526-attachments)
- **Operator procedure:** [docs/ops/object-storage-provisioning.md](docs/ops/object-storage-provisioning.md) — B2 bucket setup, capability-restricted app key, dev-MinIO parity; [docs/ops/binary-key/](docs/ops/binary-key/) — binary `age` identity provisioning, paste, and drill
- **Code:** `src/server/services/AttachmentService.ts`, `src/server/services/KeyEnvelopeService.ts`, `src/server/storage/{client,safety}.ts`, `src/server/services/attachment-orphan-reaper.ts`

**End-to-end encryption (shipped).** Per blob, the browser generates a fresh 32-byte AES-256-GCM data-encryption key via `crypto.getRandomValues`, encrypts the bytes locally (nonce-prefixed ciphertext, 16-byte auth tag), and sends the DEK material to the server at init. The server wraps the DEK with the operator's binary `age` public recipient and persists the wrapped envelope as `wrappedDek` (and, for photos, `wrappedThumbDek`) on the attachment row; the unwrapped DEK is never persisted. The matching private identity lives only in tmpfs on the VPS, pasted by the operator after every reboot — same operational pattern as the Layer 2 backup identity (ADR-0020), independent keypair, independent `BINARY_AGE_RECIPIENT`. A same-origin Service Worker intercepts attachment URLs at a synthetic origin (`/encrypted-storage/<projectId>/<attachmentId>.<variant>`), fetches ciphertext from B2 via a presigned GET plus the per-request unwrapped DEK from the server, and serves plaintext bytes back to `<img>`, `<iframe>`, and download consumers transparently. B2 sees only ciphertext; SSE-B2 is **not** an uplift — its keys are provider-held and do not close the same threat surface. The wrapped-envelope columns are schema-level audit-excluded. See [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md).

**Custody and recovery — binary `age` identity.** The binary private identity must be replicated to **at least two off-system locations** (e.g., owner workstation + sealed paper copy in a safe), independent of the backup identity. A monthly operator-side decrypt drill — download a sample ciphertext, decrypt with the off-system identity, verify against a known plaintext checksum — mirrors ADR-0020's Tier 2 cadence and proves the off-system custody copy still works. Loss of the binary identity is **unrecoverable customer deliverables** — worse blast radius than backup-key loss, since binaries are work-product (Aufmaß, photos, signed offers), not recovery artifacts.

---

## Operator entry points

| I need to…                              | Start here                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Understand the concept                  | This file                                                                                                                                               |
| Bring Layer 2 up on a fresh VPS         | [ops/backup/setup.md](docs/ops/backup/setup.md)                                                                                                         |
| Restore the DB from an encrypted backup | [ops/backup/recovery.md](docs/ops/backup/recovery.md)                                                                                                   |
| Run the monthly verification drill      | [ops/backup/drills.md](docs/ops/backup/drills.md)                                                                                                       |
| Diagnose a broken backup service        | [ops/backup/troubleshooting.md](docs/ops/backup/troubleshooting.md)                                                                                     |
| See the full Layer 2 design             | [ADR-0020](docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)                                                                   |
| Provision the Layer 3 B2 bucket + key   | [ops/object-storage-provisioning.md](docs/ops/object-storage-provisioning.md)                                                                           |
| Provision the Layer 3 binary key        | [ops/binary-key/](docs/ops/binary-key/)                                                                                                                 |
| See the full Layer 3 design             | [ADR-0022](docs/adr/0022-binary-storage-b2-compliance-object-lock.md) (durability), [ADR-0024](docs/adr/0024-binary-attachment-e2e-encryption.md) (e2e) |
| Export all data (text + attachments)    | UI → Daten view                                                                                                                                         |

---

## Related top-level docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — code navigation guide; Links table points back here.
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow, conventions, security-audit trigger.
- [README.md](README.md) — project intro.
