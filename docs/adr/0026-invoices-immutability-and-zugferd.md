# ADR-0026: Invoices — immutable snapshot, gapless sequence, ZUGFeRD EN 16931

- **Status:** Accepted
- **Date:** 2026-05-12 (storage and retention amended 2026-09-21, #417; restore gap amended 2026-09-28, #429; compliance boundary amended 2026-10-21, #551)
- **Confidence:** High

## Context

Invoicing is the closing transition of the project workflow ([kickoff.md](../project/kickoff.md): `Rechnung fällig → Abgerechnet`) and the surface the bookkeeper view is built on. Until now the data model has tracked the _state_ of an invoice via the project's `status` column without producing the artifact. This ADR pins the artifact: schema, identifier scheme, e-invoicing format, immutability posture, and the cancellation path.

Forces:

- **Compliance stays with the company** ([kickoff § Not Doing](../project/kickoff.md#not-doing)). Law binds the company, not its tools. Statute shapes the artifact; it does not make the system answerable for the company's obligations:
  - **§14 UStG** — mandatory content: issuer, recipient, unique sequential number, issue and performance dates, line items, tax breakdown.
  - **§14a UStG** — B2B e-invoicing: receive from 2025-01-01; paper or other formats only until 2026-12-31, or 2027-12-31 for issuers with prior-year turnover ≤ €800,000 ([§27 Abs. 38 UStG](https://www.gesetze-im-internet.de/ustg_1980/__27.html)). Handwerker have business customers (Hausverwaltungen, Bauträger, general contractors), so a plain PDF is not an option.
  - **§13b UStG** — reverse charge; for Handwerker, Abs. 2 Nr. 4 covers Bauleistungen, common when a Handwerker works as a subcontractor.
- **Only machine-checkable rules have a competent reviewer.** EN 16931 conformance has one: the official CEN Schematron. Tax semantics (which mode applies, which notices) have none on this project — findings there cannot converge.
- **Snapshot or drift.** Customer addresses, USt-IdNr., line wording, tax rates, and the issuer's own company profile evolve over years. An issued invoice must render identically forever; lookup-by-FK against live rows is incompatible with that requirement.
- **Gapless sequences are an audit-trail expectation.** §14 Abs. 4 Nr. 4 UStG requires a unique, sequential number — not a gapless one — but auditors ask about every gap by default; a gapless mechanism avoids that question. Postgres `SERIAL`/`IDENTITY` advance on rollback and silently leak gaps.
- **No backwards compatibility burden.** No issued invoices exist; the schema can be shaped for the right model directly (project convention).
- **Project primitives already exist.** Audit log + single-write path ([ADR-0021](0021-audit-log-and-notifications-single-write-path.md)), B2 binary descriptor flow with Compliance Object Lock ([ADR-0022](0022-binary-storage-b2-compliance-object-lock.md)), e2e encryption of binaries ([ADR-0024](0024-binary-attachment-e2e-encryption.md)), SSE invalidation ([ADR-0025](0025-realtime-ui-invalidation-via-sse.md)), repository-predicate worker scoping ([ADR-0019](0019-worker-data-scoping-repository-layer-predicate.md)) — the invoice domain composes on these rather than introducing parallel infrastructure.

## Decision

We will model invoices as **immutable issued snapshots with a gapless year-scoped sequence, rendered as ZUGFeRD EN 16931 (Comfort) PDF/A-3**, anchored in the existing audit, storage, and notification primitives. The closest production analogue is the **Stripe Invoices** model (issued invoices are content-frozen; corrections are sibling credit notes rather than edits) combined with the **DATEV** convention for German numbering (year-scoped `RE-YYYY-NNNN`, distinct prefix for Stornorechnung).

### Compliance boundary

| The system guarantees                                                                          | The company owns                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Its own outputs agree: an issued invoice is read-only, its PDF is Object-Locked                | Legal correctness of content: tax mode, wording, notices — the shipped boilerplate is a default the company reviews |
| The XML conforms to EN 16931 for the supported cases ([§ E-invoice format](#e-invoice-format)) | Correct use: no second invoice for the same supply (§14c UStG), corrections, customer communication                 |
| Invoice numbers are unique within the system                                                   | Retention, archiving, GoBD, Verfahrensdokumentation. The Object Lock is defense in depth, not a promise             |

- **Supported cases** are the [tax modes](#tax-modes) × invoice / Storno. Rule violations the test matrix finds are fixed in the renderer (e.g. BR-27, a negative item price) or refused at issuance by input validation (e.g. an empty company USt-IdNr., BR-CO-26; a 0 % `standard` line, BR-S-05). The system does not judge whether the chosen tax mode applies.
- Responsibilities and limits for the operating company: [Betriebsverantwortung](../compliance/betriebsverantwortung.md).

### Data model

- **New `invoices` table — snapshot at issuance.** Issuer block (company name, address, tax id, USt-IdNr., IBAN, footer text), recipient block (customer name + address), line items as a JSONB array, tax aggregation, totals, dates (issue, performance/Leistungsdatum), identifiers (number, status), `taxMode` (snapshotted), `profile` (ZUGFeRD profile snapshotted), binary descriptor reference to the rendered PDF/A-3, `cancellationOf` (nullable self-FK to the original invoice for Stornorechnung rows). Issued rows are write-once after the issuance transaction commits.
- **New `invoice_sequence` table — gapless allocation.** One row per `(year, kind)` where `kind ∈ {'invoice', 'storno'}` with `nextValue bigint NOT NULL`. Allocation is a single atomic `INSERT … ON CONFLICT (year, kind) DO UPDATE SET next_value = next_value + 1 RETURNING next_value` inside the same transaction that inserts the invoice — Postgres takes a row-exclusive lock equivalent to `SELECT FOR UPDATE` for the duration of the transaction, so a rollback returns the value to the sequence. The single statement collapses the first-of-year case (INSERT) and the steady-state case (DO UPDATE) into one race-free path. Canonical Postgres pattern for gapless counters; incompatible with `SERIAL`/`IDENTITY`, which advance on rollback by design. The year segment is derived from issuance-time wall-clock UTC.
- **New `company_profile` table — single row.** Columns: company name, address, tax id, USt-IdNr., IBAN, accent color, footer text, `defaultTaxMode`. (The logo was originally listed here as a binary-descriptor reference; issue #189 moved it to the deploy-time branding config — it is installation identity, not business data.) Singleton enforced by a CHECK on a constant primary key (same shape as `meta_backup_status.singleton`). Owner-only CRUD; the row is pre-seeded by the baseline migration so write paths upsert rather than first-write.
- **New `AuditEntityType: 'invoice'`.** Added to the `AUDIT_ENTITY_TYPES` array and `AUDIT_ENTITY_TO_TABLE` map in `schema.ts`; the architecture check ([scripts/check-audit-mutations.sh](../../scripts/check-audit-mutations.sh)) derives the audited-tables list from this constant. The `audit_log_entity_type_valid` and `audit_log_ancestor_type_valid` CHECKs are extended in lock-step.

### State machine

- **`draft`** — fully editable, no number assigned, deletable. Lines, recipient, tax mode all mutable.
- **`issued`** — at the issuance transaction: number allocated atomically from `invoice_sequence` (single `INSERT … ON CONFLICT … DO UPDATE … RETURNING next_value` taking a row-exclusive lock), content frozen (no UPDATE path on issued rows beyond the cancellation flag), PDF/A-3 + ZUGFeRD XML rendered, blob written through the [ADR-0022](0022-binary-storage-b2-compliance-object-lock.md)/[ADR-0024](0024-binary-attachment-e2e-encryption.md) pipeline, project status transitioned to `abgerechnet`, audit row written, SSE `invoice_changed` AND `project_changed` events emitted post-commit (the project status changed, so both consumer surfaces invalidate). All one transaction.
- **`cancelled`** — a flag on the original issued row. Cancellation does not edit the original; it **inserts a sibling Stornorechnung row** with its own `ST-YYYY-NNNN` number from the `storno` sub-sequence, line amounts negated, mandatory `cancellationOf` pointing at the original. Both rows persist forever. A _corrected_ invoice is a fresh `draft → issued` cycle, not a Storno variant. Project status is **not** auto-reverted on cancellation — surfaced as a UI banner so the operator decides what to do with the project state.

### Numbering

- **Invoice:** `RE-YYYY-NNNN` (e.g. `RE-2026-0001`). Year-scoped, gapless within `(year, 'invoice')`.
- **Storno:** `ST-YYYY-NNNN`. Separate sub-sequence within `(year, 'storno')`. The distinct prefix discriminates at a glance and matches the German DATEV convention (RE = Rechnung, ST = Storno).
- **Format pinned at the DB.** A CHECK constraint on `invoices.number` enforces the regex `^(RE|ST)-\d{4}-\d{4,}$` so a misshapen number cannot land even via raw SQL. The four-digit-minimum suffix allows growth past 9999 without a schema migration; the regex anchors the prefix and the year width.

### E-invoice format

- **ZUGFeRD profile EN 16931 (Comfort), PDF/A-3 wrapper with embedded `factur-x.xml`.** Both human-readable (PDF) and machine-readable (XML) in one file; the industry default for B2B DE under §14a. The Comfort profile is the EN 16931-conformant tier — the format the §14a mandate targets and what most ERP receivers expect.
- **Validation.** XSD per render: a non-conformant XML aborts issuance. EN 16931 business rules (CEN validation artefacts, CII binding, EUPL-1.2) run in tests over a fixture matrix of the supported cases (`src/test/en16931/`). Not per render: the only in-process XSLT 3 processor, SaxonJS, is proprietary and cannot ship in the AGPL-3.0 runtime; Saxon-HE needs a JVM. Residual risk, accepted: an input combination outside the fixtures fails a rule at the receiver, and the company corrects it with a Storno and a new invoice.
- **XRECHNUNG is a future-work seam, not v1 scope.** Required only for public-sector clients; the schema accommodates it via the snapshotted `profile` column on the invoice row (current values: `'zugferd-en16931'`; future: `'xrechnung'`, `'zugferd-xrechnung'`). The renderer is selected by `profile` at issuance; pure-XML XRECHNUNG produces an XML file rather than PDF/A-3 — the storage shape and audit shape are unchanged.
- **Per-customer toggle is a future-work seam.** v1 issues with the company-default profile; a `customers.defaultInvoiceProfile` column is a non-breaking later addition.

### Storage and retention

- PDF/A-3 (ZUGFeRD-wrapped) stored as an `attachments` descriptor row under the E2E envelope ([ADR-0024](0024-binary-attachment-e2e-encryption.md)), so B2 sees only ciphertext plus the invoice number as object metadata ([ADR-0024](0024-binary-attachment-e2e-encryption.md) § Self-describing objects) — but in its own key namespace, which keeps it off the attachment surface: no attachment operation lists, hides, restores, or serves it, and the full-account import restores it into the same namespace.
- **Object Lock retention is per object.** Each rendered PDF is PUT with its own Compliance lock until write time + `INVOICE_OBJECT_LOCK_DAYS`: `3650` in production — defense in depth against the application's own unreliability, not a retention promise ([§ Compliance boundary](#compliance-boundary)); `.env.example` ships `0` (no lock) so dev binaries stay disposable. Not the bucket default: [ADR-0022](0022-binary-storage-b2-compliance-object-lock.md) requires `R ≤ L`, so a multi-year `R` would stretch every attachment's trash window to years. The original design asserted bucket default ≥ env at boot, which no bucket could satisfy together with `R ≤ L` (#417).
- Lifecycle and capability split from ADR-0022 are reused unchanged — the bucket primitives operate on opaque bytes, so the Object Lock window defends ciphertext exactly as it defends attachment ciphertext.

### Tax modes

Two modes — the target company's ([kickoff § Not Doing](../project/kickoff.md#not-doing): no generalization beyond it). Each renders its boilerplate:

- **`standard`** — per-line VAT (19% / 7%), full tax breakdown in the totals block.
- **`reverse_charge`** — §13b UStG: no VAT on lines, mandatory recipient-pays note ("Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG"). For Handwerker Bauleistungen this is §13b Abs. 2 Nr. 4.

Kleinunternehmer (§19 UStG) is not supported ([§ Kleinunternehmer tax mode](#kleinunternehmer-tax-mode-19-ustg); removed in #552).

`company_profile.defaultTaxMode` pre-fills new drafts. The draft's `taxMode` is editable until issuance. **At issuance the value is snapshotted onto the invoice row and frozen** — the issued row carries its own copy and is not re-derived from `company_profile` on render.

### Permissions

- **`invoice:write`** — owner, office.
- **`invoice:read`** — owner, office, bookkeeper.
- **Worker:** no access. The repository-predicate scope ([ADR-0019](0019-worker-data-scoping-repository-layer-predicate.md)) already gates worker visibility through project-assignment; invoices have no `project_worker` scope path, so the predicate returns the empty set for the worker role — no special case needed at the route layer.

### Audit and realtime

- Draft mutations, issuance, and cancellation all flow through the single-write `mutate()` path ([ADR-0021](0021-audit-log-and-notifications-single-write-path.md)). Audit entity type `'invoice'`; ancestor denormalization sets `(ancestor_entity_type='project', ancestor_entity_id=projectId)` so the project-detail activity feed surfaces invoice events on the same indexed predicate as attachments.
- SSE event name `invoice_changed`, emitted post-commit from the mutation call sites per [ADR-0025](0025-realtime-ui-invalidation-via-sse.md). Payload is the standard invalidation ping; the client refetches via the gated read endpoints.

### Future-work seams (recorded, not implemented)

- **XRECHNUNG profile** — schema field `profile` already discriminates; the renderer dispatch and the public-sector receiver surface land when the first such customer appears.
- **Per-customer template variants** — non-breaking `customers.defaultInvoiceProfile` (and, if needed, accent/footer overrides) when a customer population needs differentiation.
- **Line-item import** — out of scope v1; manual line entry is the only path. The JSONB shape accommodates an import without migration.

## Alternatives Considered

### PDF-only output, defer ZUGFeRD/EN 16931 until forced

Ship a plain PDF in v1 and add EN 16931 when the 2027-01-01 send mandate hits. Ruled out: the mandate date is published and external, "defer" against a known regulatory deadline is the canonical shape of avoidable debt, and the EN 16931 schema is the part that must be right from day 1 — line shapes, party identifiers, tax codes need to round-trip through the official validators. Catching them at scale-out is materially worse than catching them on the first issuance.

### XRECHNUNG pure XML, no PDF

Spec-conformant for public-sector. Ruled out: customers in the Handwerker B2B scope expect a readable artifact; pure XML inverts that expectation. ZUGFeRD ships both in one file and covers the same EN 16931 semantic — superset for the actual customer mix. XRECHNUNG remains the future-work seam for public-sector clients.

### Normalized `invoice_lines` table (FK from line rows to the invoice header)

Standard third-normal-form modeling: query-able historical line items, FK integrity. Ruled out: lines are part of the immutable snapshot — the row freezes at issuance and is never queried for analytic aggregations across lines. The relational shape adds FK graph weight (cascade rules, ordering column, per-line audit smear) for a query workload that does not exist. JSONB on the header is the right shape when the contained data is immutable and read as a unit; it matches the issuance/render lifecycle exactly.

### Postgres `SERIAL` / `IDENTITY` for the invoice number

Trivially gapless-looking, well-supported. Ruled out: both leak gaps on rollback — the sequence advances even when the inserting transaction aborts, and the gap is permanent. Gapless is the chosen mechanism ([Context](#context)); the legal requirement is uniqueness, not gaplessness (see Negative). The row-exclusive lock on `invoice_sequence` (via a single `INSERT … ON CONFLICT … DO UPDATE … RETURNING next_value`) is the canonical Postgres pattern when gaplessness is required and writes are low-rate.

### Soft-delete instead of immutability + Stornorechnung

A `deleted` flag on `invoices` analogous to `projects.deleted`. Ruled out: a hidden row would contradict its Object-Locked PDF, and hiding is no correction toward the customer. Stornorechnung is the corrective primitive — a fresh sibling document, not a flip on the original.

### Per-customer or per-project template variants in v1

Per-customer branding/footer/accent overrides. Out of scope: one code template + one `company_profile` row is sufficient under [ADR-0001](0001-generalized-system-with-configurable-customer-specifics.md)'s single-tenant deployment, and the per-customer seam is non-breaking when it lands. Building it now spends design surface on a need that has not surfaced.

### The system guarantees legal compliance

This ADR's original framing: "legal anchors are non-negotiable", with §147 AO and GoBD as system requirements. Ruled out (#551): law binds the company, not its tools, and no one on the project can review tax semantics, so findings could not converge. The system guarantees what is machine-checkable; the company owns the rest ([§ Compliance boundary](#compliance-boundary)).

### Kleinunternehmer tax mode (§19 UStG)

Ruled out (#552): a Handwerker company with employees typically exceeds the §19 turnover limits, and generalization beyond the target company is out of scope. The mode doubled every fixture matrix.

### Schematron validation per render

Ruled out: licensing ([§ E-invoice format](#e-invoice-format)). Validation in tests over the supported cases is the fallback.

### Default-mode on profile + per-invoice override boolean for tax

Keep `company_profile.defaultTaxMode` plus a `taxModeOverride boolean` on the invoice row. Ruled out: the snapshot pattern already requires the invoice row to carry its own frozen `taxMode` (issuance freezes it regardless of override). An additional boolean is dead modeling — the resolved value already lives where it needs to.

## Consequences

### Positive

- **E-invoice capable for the supported cases.** The XML is checked against the official EN 16931 rules in tests, so the 2027/2028 send mandate needs no follow-up program. Content correctness stays with the company.
- **Historical readability is structural.** Issued invoices render identically forever because the snapshot is on the row, not chased through joins against mutable parents.
- **Gapless numbering survives rollback** by construction (single atomic `INSERT … ON CONFLICT (year, kind) DO UPDATE … RETURNING next_value` inside the issuing transaction takes a row-exclusive lock equivalent to `SELECT FOR UPDATE`). No reconciliation pass, no "missing number" auditor question — outside a DR restore (Negative below).
- **Immutability is storage-enforced**, not policy-enforced. Compliance Object Lock on the rendered PDF/A-3 means even a compromised app credential cannot destroy issued artifacts within the retention window.
- **No new infrastructure.** Reuses audit, storage, encryption, SSE, and the scope predicate. The invoice domain is a fifth audited entity type, not a parallel stack.
- **Stornorechnung is a regular row.** The cancellation primitive does not need special-casing in audit, storage, listing, or permissions — it is an invoice with `cancellationOf` set and a Storno prefix.

### Negative

- **Business rules are checked in tests, not per render.** A real input combination outside the fixtures can fail at the receiver; the correction is a Storno and a new invoice.
- **Two tax modes only.** A similar company adopting the system adds its own modes.
- **Manual line-item entry only in v1.** No import path; bookkeeper-facing pain on long line lists. The JSONB shape accommodates an importer without migration when the need is concrete.
- **Single `company_profile` row constrains multi-entity tenants.** Acceptable under [ADR-0001](0001-generalized-system-with-configurable-customer-specifics.md); if a customer ever operates two issuing entities under one deployment, the singleton lifts to a row-per-entity with a `companyProfileId` FK on `invoices`.
- **ZUGFeRD adds a toolchain surface.** PDF/A-3 generation, the `factur-x.xml` builder against the EN 16931 schema, and per-render XSD validation against the canonical EN 16931 schemas before embed. A non-conformant XML aborts the issuance transaction at the validator step before any binary lands on B2. The Node-native rendering pipeline is located in [`ARCHITECTURE.md` § Invoices Module](../../ARCHITECTURE.md#invoices-module); its libraries in [§ Dep lifecycle health](#dep-lifecycle-health-as-of-2026-05-15).
- **Stornorechnung surfaces as a distinct row in invoice lists.** UI must group it visually under the original; bookkeeper exports include both. Acceptable — it is the expected correction document.
- **Object Lock + Compliance retention is unforgiving.** A Storno-then-correct cycle is the only correction path; there is no "fix a typo on the issued invoice" door, by design.
- **A DR restore to an earlier DB state leaves a gap.** Invoices issued after the backup vanish from the DB, but their numbers reached customers. The DR procedure advances the counter past them ([data-model.md §6.13](../spec/data-model.md#613-gapless-sequence-allocation)) — §14 Abs. 4 Nr. 4 UStG requires a number issued once; gaplessness is this ADR's stricter choice and yields. The gap is recorded in the incident record.

### Operational

- Schema delta lands as edits to `src/server/db/schema.ts` + a regenerated baseline migration (project convention: no incremental Drizzle migration files, no production data to preserve). The new `invoices`, `invoice_sequence`, and `company_profile` tables, the `AUDIT_ENTITY_TYPES` extension, the `AUDIT_ENTITY_TO_TABLE` map entry, and the two `audit_log_*_type_valid` CHECK updates land in the same edit.
- New env var `INVOICE_OBJECT_LOCK_DAYS` and corresponding entries in `.env.production.example` + the env-drift gate (`scripts/check-env-drift.sh`). Dev `.env.example` ships `0`.
- The storage client's PUT accepts a per-object Compliance lock. It needs the app key's `writeFileRetentions` (B2) / `s3:PutObjectRetention` (dev MinIO); a PUT whose lock the provider rejects fails and the issuance rolls back.
- New SSE event name `invoice_changed` registered with the event-name registry — no `/api/events` route change.
- New permission keys `invoice:read` and `invoice:write` added to the permission registry; the bookkeeper role (currently a stub) gains `invoice:read`.
- ZUGFeRD generation lands as a Node-native rendering pipeline (PDF/A-3 + embedded `factur-x.xml` with per-render XSD validation against the EN 16931 schemas); libraries: [§ Dep lifecycle health](#dep-lifecycle-health-as-of-2026-05-15); paths: [`ARCHITECTURE.md` § Invoices Module](../../ARCHITECTURE.md#invoices-module). No JVM, no external service.

## Dep lifecycle health (as of 2026-05-15)

The named npm dependencies that implement this ADR's shape (PDF/A-3 + factur-x.xml + XSD validation + ZIP export + decimal money math), plus the test-only Schematron validation.

| Dep                               | Last release                                                                               | License                                         | Maintainership                                             | Notes                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@cantoo/pdf-lib`                 | 2.6.5 (2026-03-20)                                                                         | MIT                                             | active maintainer                                          | Maintained fork of upstream `pdf-lib` (last upstream publish 2021-11-06). Adopted per audit [#187](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/187) to replace the dormant upstream. [deps.dev](https://deps.dev/npm/%40cantoo%2Fpdf-lib)        |
| `xmllint-wasm`                    | 5.2.0 (2026-03-24)                                                                         | MIT                                             | `noppa/xmllint-wasm`, active                               | Pure-WASM XSD validator. Replaces unmaintained `libxmljs2` ([#192](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/192) / PR #194). Drops the only native binding from the project's dep graph. [deps.dev](https://deps.dev/npm/xmllint-wasm)        |
| `archiver`                        | 8.0.0 (per [#187](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/187) bump) | MIT                                             | active                                                     | Server-side ZIP for bookkeeper bulk-export. [deps.dev](https://deps.dev/npm/archiver)                                                                                                                                                                              |
| big.js                            | 7.0.1 (2025-04-21)                                                                         | MIT                                             | MikeMcl/big.js, active                                     | Decimal arithmetic for invoice amounts ([#534](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/534)), added 2026-10-19. Small, zero-dep; also in the client bundle. [deps.dev](https://deps.dev/npm/big.js)                                          |
| EN 16931 XSD schemas              | Bundled from `akretion/factur-x@d7fa1e7`                                                   | EU/CEN standard                                 | Versioned at the standards body                            | Standards-track artifact (not a runtime dep); refreshed when the standard publishes a new version.                                                                                                                                                                 |
| EN 16931 CII validation artefacts | 1.3.17 (2026-10-12), vendored in `src/test/en16931/`                                       | EUPL-1.2                                        | ConnectingEurope/eInvoicing-EN16931, active                | Test-only Schematron rules ([#544](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/544)), added 2026-10-21. Update per that folder's README.                                                                                                         |
| `saxon-js`, `xslt3` (dev)         | 2.7.0 (2024-10-17)                                                                         | Saxonica license: free, proprietary, obfuscated | Saxonica (commercial vendor); no npm release since 2024-10 | Test-only XSLT 3 engine and compiler for the Schematron rules ([#544](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/544)), added 2026-10-21; runtime exclusion: [§ E-invoice format](#e-invoice-format). [deps.dev](https://deps.dev/npm/saxon-js) |

## References

- [ADR-0001](0001-generalized-system-with-configurable-customer-specifics.md) — single-tenant deployment shape; basis for the `company_profile` singleton.
- [ADR-0019](0019-worker-data-scoping-repository-layer-predicate.md) — worker scope; the predicate excludes invoices by absence of a `project_worker` path.
- [ADR-0021](0021-audit-log-and-notifications-single-write-path.md) — single-write `mutate()` path; reused for draft/issue/cancel.
- [ADR-0022](0022-binary-storage-b2-compliance-object-lock.md) — bucket primitives, Compliance Object Lock backstop applied to the rendered PDF/A-3.
- [ADR-0024](0024-binary-attachment-e2e-encryption.md) — E2E envelope encryption; rendered invoice ciphertext rides the same pipeline.
- [ADR-0025](0025-realtime-ui-invalidation-via-sse.md) — SSE invalidation primitive; `invoice_changed` is a new typed event on the existing channel.
- [Kickoff](../project/kickoff.md) — Rechnung-fällig / Abgerechnet workflow and the bookkeeper view that consumes this domain.
- [Issue #109](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/109) — implementation tracking; the prior comment is superseded by this ADR.
- §14 UStG — [Pflichtangaben einer Rechnung](https://www.gesetze-im-internet.de/ustg_1980/__14.html).
- §14a UStG — [Elektronische Rechnung / E-Rechnungspflicht](https://www.gesetze-im-internet.de/ustg_1980/__14a.html).
- §14c UStG — [Unrichtiger oder unberechtigter Steuerausweis](https://www.gesetze-im-internet.de/ustg_1980/__14c.html).
- §27 Abs. 38 UStG — [E-Rechnung: Übergangsregelung](https://www.gesetze-im-internet.de/ustg_1980/__27.html).
- §19 UStG — [Kleinunternehmer](https://www.gesetze-im-internet.de/ustg_1980/__19.html).
- §13b UStG — [Leistungsempfänger als Steuerschuldner / Reverse-Charge](https://www.gesetze-im-internet.de/ustg_1980/__13b.html).
- [GoBD](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/2019-11-28-GoBD.html) — Grundsätze zur ordnungsmäßigen Führung und Aufbewahrung von Büchern, Aufzeichnungen und Unterlagen in elektronischer Form.
- [EN 16931](https://standards.cen.eu/dyn/www/f?p=204:110:0::::FSP_PROJECT,FSP_LANG_ID:60602,25) — Electronic invoicing: semantic data model of the core elements of an electronic invoice.
- [ZUGFeRD / Factur-X specification](https://www.ferd-net.de/standards/zugferd/) — hybrid PDF/A-3 + embedded EN 16931 XML.
- [XRECHNUNG specification](https://www.xoev.de/xrechnung-16828) — public-sector profile; future-work seam.
