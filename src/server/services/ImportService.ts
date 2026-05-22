/**
 * Unified business-data restore. See ADR-0018 and data-model.md §5.8.
 *
 * Empty target → proceed; non-empty target → refuse unless the caller sets
 * `override`, which wipes the importable set in the same transaction. IDs
 * are preserved; dry-run validates without writes.
 *
 * Issue #230 expanded the importable set to all user-meaningful business
 * state: `users`, `company_profile`, `invoices`, `invoice_sequence` join
 * the existing `customers`, `projects`, `project_workers`. Refs
 * (`createdBy`, `updatedBy`, `project_workers.userId`, etc.) resolve
 * against `envelope.users` rather than the target `users` table — with
 * users in the envelope, the happy path always resolves internally;
 * MISSING_USER_REFS now signals a hand-edited or partial envelope.
 *
 * Invoices have a self-FK (`cancellationOf` → `invoices.id` for Storno
 * rows); the importer inserts originals first, then Stornos, in two
 * separate `insert().values()` calls. The envelope arrives ordered by
 * the exporter `(cancellation_of NULLS FIRST, id)`, but the importer
 * re-slices on its own — a hand-edited envelope may reorder.
 */

import { inArray, sql } from 'drizzle-orm';
import {
  auditLog,
  companyProfile,
  customers,
  invoices,
  invoiceSequence,
  projects,
  projectWorkers,
  users,
  type AuditEntityType,
} from '../db/schema.js';
import type { Database } from '../db/connection.js';
import {
  missingUserRefs,
  restoreConfirmationMismatch,
  schemaVersionMismatch,
  targetNotEmpty,
  validationError,
} from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { restorePhraseMatches } from '../../config/dataExchangeConfig.js';
import {
  SCHEMA_VERSION,
  type Envelope,
  type EnvelopeCompanyProfile,
  type EnvelopeCustomer,
  type EnvelopeInvoice,
  type EnvelopeInvoiceSequence,
  type EnvelopeProject,
  type EnvelopeAssignment,
  type EnvelopeUser,
  type ImportOptions,
  type ImportResult,
  type DryRunPreview,
  type MissingUserReference,
  type MissingUserRefsPayload,
  type ValidationIssue,
} from '../../domain/dataExchange.js';
import { listAllKeys } from '../repositories/attachment.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import { bestEffortHideStorageKeys } from './AttachmentService.js';
import type { ServiceLogger } from './Logger.js';
import { emitProjectChanged } from '../sse/emitters.js';

/**
 * Within-envelope structural checks — uniqueness of keys that become DB
 * constraints on insert, plus referential integrity between tables. Row-level
 * column validation is left to the DB. This pre-check exists so dry-run
 * reports issues without writes, and so non-dry-run fails cleanly (422)
 * before TRUNCATE rather than bubbling a 23505 through as a generic 500.
 */
function validateEnvelope(envelope: Envelope): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Uniqueness: users id (pkey) and username (unique)
  const userIds = new Set<string>();
  const usernames = new Set<string>();
  for (let i = 0; i < envelope.users.length; i++) {
    const u = envelope.users[i]!;
    if (userIds.has(u.id)) {
      issues.push({
        path: `users[${i}].id`,
        message: `duplicate user id ${u.id} within envelope`,
      });
    }
    userIds.add(u.id);
    if (usernames.has(u.username)) {
      issues.push({
        path: `users[${i}].username`,
        message: `duplicate username ${u.username} within envelope`,
      });
    }
    usernames.add(u.username);
  }

  // Singleton: company_profile MUST be at most one row. The target table
  // enforces a singleton invariant via UNIQUE on a boolean discriminator
  // + CHECK; an envelope with two rows would fail the INSERT with 23505.
  // The empty arm is permitted: the seed's `loadBusiness` legitimately
  // ships `company_profile: []` because the singleton is restored by
  // `seed.ts` AFTER the business envelope lands (see seed.ts comments
  // around the TRUNCATE CASCADE). Exports always carry exactly one row.
  if (envelope.company_profile.length > 1) {
    issues.push({
      path: 'company_profile',
      message: `expected at most one company_profile row, got ${envelope.company_profile.length}`,
    });
  }

  // Uniqueness: customer id (pkey)
  const customerIds = new Set<string>();
  for (let i = 0; i < envelope.customers.length; i++) {
    const c = envelope.customers[i]!;
    if (customerIds.has(c.id)) {
      issues.push({
        path: `customers[${i}].id`,
        message: `duplicate customer id ${c.id} within envelope`,
      });
    }
    customerIds.add(c.id);
  }

  // Uniqueness: project id (pkey) and project number (unique)
  const projectIds = new Set<string>();
  const projectNumbers = new Set<string>();
  for (let i = 0; i < envelope.projects.length; i++) {
    const p = envelope.projects[i]!;
    if (projectIds.has(p.id)) {
      issues.push({
        path: `projects[${i}].id`,
        message: `duplicate project id ${p.id} within envelope`,
      });
    }
    projectIds.add(p.id);
    if (projectNumbers.has(p.number)) {
      issues.push({
        path: `projects[${i}].number`,
        message: `duplicate project number ${p.number} within envelope`,
      });
    }
    projectNumbers.add(p.number);
  }

  // Uniqueness: project_workers composite (projectId, userId)
  const assignmentKeys = new Set<string>();
  for (let i = 0; i < envelope.project_workers.length; i++) {
    const pw = envelope.project_workers[i]!;
    const key = `${pw.projectId}|${pw.userId}`;
    if (assignmentKeys.has(key)) {
      issues.push({
        path: `project_workers[${i}]`,
        message: `duplicate project_worker assignment (projectId=${pw.projectId}, userId=${pw.userId}) within envelope`,
      });
    }
    assignmentKeys.add(key);
  }

  // Uniqueness: invoice id (pkey) and invoice number (unique, non-null only).
  // The DB enforces uniqueness with a partial unique index on `number WHERE
  // number IS NOT NULL`; many drafts may share a null number per project.
  const invoiceIds = new Set<string>();
  const invoiceNumbers = new Set<string>();
  for (let i = 0; i < envelope.invoices.length; i++) {
    const inv = envelope.invoices[i]!;
    if (invoiceIds.has(inv.id)) {
      issues.push({
        path: `invoices[${i}].id`,
        message: `duplicate invoice id ${inv.id} within envelope`,
      });
    }
    invoiceIds.add(inv.id);
    if (inv.number !== null) {
      if (invoiceNumbers.has(inv.number)) {
        issues.push({
          path: `invoices[${i}].number`,
          message: `duplicate invoice number ${inv.number} within envelope`,
        });
      }
      invoiceNumbers.add(inv.number);
    }
  }

  // Uniqueness: invoice_sequence composite (year, kind) pkey.
  const sequenceKeys = new Set<string>();
  for (let i = 0; i < envelope.invoice_sequence.length; i++) {
    const seq = envelope.invoice_sequence[i]!;
    const key = `${seq.year}|${seq.kind}`;
    if (sequenceKeys.has(key)) {
      issues.push({
        path: `invoice_sequence[${i}]`,
        message: `duplicate invoice_sequence row (year=${seq.year}, kind=${seq.kind}) within envelope`,
      });
    }
    sequenceKeys.add(key);
  }

  // Referential integrity: project→customer, assignment→project,
  // invoice→project, invoice.cancellationOf→invoice.
  for (let i = 0; i < envelope.projects.length; i++) {
    const p = envelope.projects[i]!;
    if (!customerIds.has(p.customerId)) {
      issues.push({
        path: `projects[${i}].customerId`,
        message: `customerId ${p.customerId} not present in envelope.customers`,
      });
    }
  }

  // AC-284: siteAddress is all-or-nothing — null (site = customer
  // billing address) or a fully populated triple. A partial fill
  // (any empty-string component) is rejected here to mirror the
  // POST /api/projects backstop, so a hand-edited or round-tripped
  // envelope cannot land malformed rows that the form layer would
  // refuse.
  for (let i = 0; i < envelope.projects.length; i++) {
    const p = envelope.projects[i]!;
    if (p.siteAddress == null) continue;
    const { street, zip, city } = p.siteAddress;
    const partial =
      typeof street !== 'string' ||
      street.length === 0 ||
      typeof zip !== 'string' ||
      zip.length === 0 ||
      typeof city !== 'string' ||
      city.length === 0;
    if (partial) {
      issues.push({
        path: `projects[${i}].siteAddress`,
        message: `partial siteAddress (street/zip/city must all be non-empty, or the whole field must be null)`,
      });
    }
  }

  for (let i = 0; i < envelope.project_workers.length; i++) {
    const pw = envelope.project_workers[i]!;
    if (!projectIds.has(pw.projectId)) {
      issues.push({
        path: `project_workers[${i}].projectId`,
        message: `projectId ${pw.projectId} not present in envelope.projects`,
      });
    }
  }

  for (let i = 0; i < envelope.invoices.length; i++) {
    const inv = envelope.invoices[i]!;
    if (!projectIds.has(inv.projectId)) {
      issues.push({
        path: `invoices[${i}].projectId`,
        message: `projectId ${inv.projectId} not present in envelope.projects`,
      });
    }
    if (inv.cancellationOf !== null && !invoiceIds.has(inv.cancellationOf)) {
      issues.push({
        path: `invoices[${i}].cancellationOf`,
        message: `cancellationOf ${inv.cancellationOf} not present in envelope.invoices`,
      });
    }
  }

  // Issue #163: `/api/import` is text-only post-fix. The envelope
  // body MUST NOT carry an `attachments` key (rejected at the route
  // layer with 422 VALIDATION_ERROR — see api.md §14.2.4 and
  // AC-253). Per-attachment restoration runs through the standard
  // `init` (with `restore` block) + per-blob PUT + `complete`
  // pipeline against the importing instance (AC-256), driven by the
  // client orchestrator.

  return issues;
}

/**
 * Collect every envelope reference site whose user-id field must resolve
 * against `envelope.users`. Null / missing audit-field values are skipped
 * — they carry no reference, per api.md §14.2.4 and AC-162a.
 * `project_workers[].userId` is non-nullable by schema so it is always a
 * reference. Pure; unit-testable without a DB.
 *
 * Issue #230: with `users` in the envelope, refs resolve internally
 * against `envelope.users[*].id` rather than against the target's `users`
 * table — the target is wiped (override) or empty (fresh) at insert time.
 */
function collectEnvelopeUserRefs(envelope: Envelope): MissingUserReference[] {
  const refs: MissingUserReference[] = [];

  for (let i = 0; i < envelope.customers.length; i++) {
    const c = envelope.customers[i]!;
    if (c.createdBy !== null && c.createdBy !== undefined) {
      refs.push({ path: `customers[${i}].createdBy`, userId: c.createdBy });
    }
    if (c.updatedBy !== null && c.updatedBy !== undefined) {
      refs.push({ path: `customers[${i}].updatedBy`, userId: c.updatedBy });
    }
  }

  for (let i = 0; i < envelope.projects.length; i++) {
    const p = envelope.projects[i]!;
    if (p.createdBy !== null && p.createdBy !== undefined) {
      refs.push({ path: `projects[${i}].createdBy`, userId: p.createdBy });
    }
    if (p.updatedBy !== null && p.updatedBy !== undefined) {
      refs.push({ path: `projects[${i}].updatedBy`, userId: p.updatedBy });
    }
  }

  for (let i = 0; i < envelope.project_workers.length; i++) {
    const pw = envelope.project_workers[i]!;
    refs.push({ path: `project_workers[${i}].userId`, userId: pw.userId });
  }

  for (let i = 0; i < envelope.invoices.length; i++) {
    const inv = envelope.invoices[i]!;
    if (inv.createdBy !== null && inv.createdBy !== undefined) {
      refs.push({ path: `invoices[${i}].createdBy`, userId: inv.createdBy });
    }
    if (inv.updatedBy !== null && inv.updatedBy !== undefined) {
      refs.push({ path: `invoices[${i}].updatedBy`, userId: inv.updatedBy });
    }
  }

  for (let i = 0; i < envelope.company_profile.length; i++) {
    const cp = envelope.company_profile[i]!;
    if (cp.updatedBy !== null && cp.updatedBy !== undefined) {
      refs.push({ path: `company_profile[${i}].updatedBy`, userId: cp.updatedBy });
    }
  }

  // `users[].createdBy` / `users[].updatedBy` themselves can reference
  // other users in the envelope — they're checked against the same set,
  // so listing them here is correct.
  for (let i = 0; i < envelope.users.length; i++) {
    const u = envelope.users[i]!;
    if (u.createdBy !== null && u.createdBy !== undefined) {
      refs.push({ path: `users[${i}].createdBy`, userId: u.createdBy });
    }
    if (u.updatedBy !== null && u.updatedBy !== undefined) {
      refs.push({ path: `users[${i}].updatedBy`, userId: u.updatedBy });
    }
  }

  return refs;
}

/**
 * From a collected reference list and a set of user ids known to exist
 * within the envelope, compute the `MISSING_USER_REFS` payload. Returns
 * `null` when every reference resolves — callers use that to skip raising
 * the error and to omit the sibling field from the dry-run preview.
 *
 * `missingUserIds` is deduplicated (insertion-ordered); `references`
 * retains one entry per offending site (duplicates across distinct paths
 * produce distinct entries — per api.md §14.4.1).
 */
function deriveMissingUserRefsPayload(
  refs: MissingUserReference[],
  presentIds: Set<string>,
): MissingUserRefsPayload | null {
  const offending = refs.filter((r) => !presentIds.has(r.userId));
  if (offending.length === 0) return null;

  const missingIds: string[] = [];
  const seen = new Set<string>();
  for (const r of offending) {
    if (!seen.has(r.userId)) {
      seen.add(r.userId);
      missingIds.push(r.userId);
    }
  }
  return { missingUserIds: missingIds, references: offending };
}

function toUserInsert(u: EnvelopeUser) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    // Hash ships verbatim — already salted/peppered by the user-creation
    // path; this preserves the same bytes (issue #230 threat model note).
    passwordHash: u.passwordHash,
    roles: u.roles,
    email: u.email,
    active: u.active,
    themePreference: u.themePreference,
    pushMuted: u.pushMuted,
    createdAt: new Date(u.createdAt),
    updatedAt: new Date(u.updatedAt),
    lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt) : null,
    createdBy: u.createdBy,
    updatedBy: u.updatedBy,
  };
}

function toCompanyProfileInsert(cp: EnvelopeCompanyProfile) {
  return {
    id: cp.id,
    companyName: cp.companyName,
    address: cp.address,
    taxId: cp.taxId,
    ustId: cp.ustId,
    iban: cp.iban,
    accentColor: cp.accentColor,
    footerText: cp.footerText,
    logoBinaryDescriptorId: cp.logoBinaryDescriptorId,
    defaultTaxMode: cp.defaultTaxMode,
    updatedAt: new Date(cp.updatedAt),
    updatedBy: cp.updatedBy,
  };
}

function toCustomerInsert(c: EnvelopeCustomer) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    address: c.address,
    ustId: c.ustId,
    notes: c.notes,
    createdAt: new Date(c.createdAt),
    updatedAt: new Date(c.updatedAt),
    createdBy: c.createdBy,
    updatedBy: c.updatedBy,
  };
}

function toProjectInsert(p: EnvelopeProject) {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    status: p.status,
    statusChangedAt: new Date(p.statusChangedAt),
    customerId: p.customerId,
    siteAddress: p.siteAddress ?? null,
    plannedStart: p.plannedStart ? new Date(p.plannedStart) : null,
    plannedEnd: p.plannedEnd ? new Date(p.plannedEnd) : null,
    estimatedValue: p.estimatedValue,
    notes: p.notes,
    deleted: p.deleted,
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt),
    createdBy: p.createdBy,
    updatedBy: p.updatedBy,
  };
}

function toAssignmentInsert(pw: EnvelopeAssignment) {
  return { projectId: pw.projectId, userId: pw.userId };
}

function toInvoiceInsert(inv: EnvelopeInvoice) {
  return {
    id: inv.id,
    projectId: inv.projectId,
    status: inv.status,
    number: inv.number,
    // `issueDate` / `performanceDate` are DATE columns (calendar dates
    // per §14 UStG, not timestamps); the schema declares `mode: 'date'`
    // so the driver expects a JS `Date` instance whose date components
    // are taken at UTC.
    issueDate: inv.issueDate ? new Date(inv.issueDate) : null,
    performanceDate: inv.performanceDate ? new Date(inv.performanceDate) : null,
    taxMode: inv.taxMode,
    profile: inv.profile,
    issuer: inv.issuer,
    recipient: inv.recipient,
    lines: inv.lines,
    totals: inv.totals,
    cancellationOf: inv.cancellationOf,
    cancellationReason: inv.cancellationReason,
    renderedPdfBinaryDescriptorId: inv.renderedPdfBinaryDescriptorId,
    createdAt: new Date(inv.createdAt),
    updatedAt: new Date(inv.updatedAt),
    createdBy: inv.createdBy,
    updatedBy: inv.updatedBy,
  };
}

function toInvoiceSequenceInsert(seq: EnvelopeInvoiceSequence) {
  return {
    year: seq.year,
    kind: seq.kind,
    nextValue: seq.nextValue,
    updatedAt: new Date(seq.updatedAt),
  };
}

export class ImportService {
  /**
   * The optional `storage` client is required only for the override
   * path — `import()` throws if a non-empty target is wiped without one.
   * Empty-target imports (the seed path) construct without it.
   */
  constructor(
    private db: Database,
    private storage: AttachmentStorageClient | null = null,
  ) {}

  /**
   * Resolve which of `ids` are present in `envelope.users` OR in the
   * target's `users` table.
   *
   * Issue #230 reframe: the primary check is against the envelope's user
   * set — with users in the envelope on the external POST /api/import
   * path, the target's `users` is wiped (override) or empty (fresh
   * install) at insert time, so `envelope.users` is the authoritative
   * source. The fallback to target.users covers the seed's split-load
   * pattern (`loadUsers` populates target.users directly; `loadBusiness`
   * then calls ImportService with `users: []` in the envelope but real
   * project_workers.userId references — see seed/business.ts comments).
   *
   * Union semantics here are deliberate, not a back-door — a hand-edited
   * envelope with refs missing from BOTH envelope.users and target.users
   * still surfaces MISSING_USER_REFS, which is the right "partial
   * source" signal per issue #230.
   */
  private async fetchPresentUserIds(envelope: Envelope, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const envelopeIds = new Set(envelope.users.map((u) => u.id));
    const unresolvedAgainstEnvelope = ids.filter((id) => !envelopeIds.has(id));
    const present = new Set(ids.filter((id) => envelopeIds.has(id)));
    if (unresolvedAgainstEnvelope.length > 0) {
      // Fallback round-trip to target.users covers the seed path; in the
      // external POST /api/import happy path this query returns no rows
      // because `envelope.users` already covered every ref.
      const rows = await this.db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, unresolvedAgainstEnvelope));
      for (const r of rows) present.add(r.id);
    }
    return present;
  }

  async import(
    envelope: Envelope,
    opts: ImportOptions,
    log?: ServiceLogger,
  ): Promise<ImportResult | DryRunPreview> {
    if (envelope.schema_version !== SCHEMA_VERSION) {
      throw schemaVersionMismatch(SCHEMA_VERSION, envelope.schema_version);
    }

    const validationIssues = validateEnvelope(envelope);
    const userRefs = collectEnvelopeUserRefs(envelope);
    const uniqueReferencedIds = Array.from(new Set(userRefs.map((r) => r.userId)));

    if (opts.dryRun) {
      // Read-only snapshot matches the ExportService pattern — the preview
      // answers "what would happen if I committed right now", and a
      // repeatable-read read-only transaction is the closest match to that
      // semantic without contending with concurrent writers.
      const presentIds = await this.fetchPresentUserIds(envelope, uniqueReferencedIds);
      const missingUserPayload = deriveMissingUserRefsPayload(userRefs, presentIds);
      const targetNonEmpty = await this.db.transaction(
        async (tx) => {
          const presenceResult = await tx.execute<{ present: boolean }>(
            // Issue #230: probe the importable *data* tables — customers /
            // projects / project_workers (pre-#230 set), plus invoices /
            // attachments. `users` and `company_profile` are NOT in this
            // probe: `users` always carries the bootstrap admin
            // (ADR-0010), and `company_profile` is pre-seeded by the
            // baseline migration as an empty singleton. Treating either
            // as "non-empty" would mean every fresh install reports
            // target_non_empty=true, gating the UI's no-warning fast
            // path for operators who legitimately have nothing to
            // overwrite.
            sql`SELECT (
              EXISTS (SELECT 1 FROM customers)
              OR EXISTS (SELECT 1 FROM projects)
              OR EXISTS (SELECT 1 FROM project_workers)
              OR EXISTS (SELECT 1 FROM invoices)
              OR EXISTS (SELECT 1 FROM attachments)
            ) AS present`,
          );
          return presenceResult.rows[0]?.present === true;
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );

      // AC-162b: on the dry-run path both classes are evaluated regardless
      // of intra-envelope state. `validation_errors` continues to carry
      // intra-envelope issues only; missing-user issues surface under the
      // sibling `missing_user_refs` field. api.md §14.2.4 deliberately
      // does not mint a wire-field name for the preview surface — we
      // mirror the commit-path `details` shape so a future UI can render
      // one component for both paths.
      return {
        schema_version: SCHEMA_VERSION,
        target_non_empty: targetNonEmpty,
        would_write: {
          users: envelope.users.length,
          company_profile: envelope.company_profile.length,
          customers: envelope.customers.length,
          projects: envelope.projects.length,
          project_workers: envelope.project_workers.length,
          invoices: envelope.invoices.length,
          invoice_sequence: envelope.invoice_sequence.length,
        },
        validation_errors: validationIssues,
        missing_user_refs: missingUserPayload,
      };
    }

    // AC-162c: commit-path ordering. Intra-envelope integrity is reported
    // first; the missing-user check runs only on an intra-consistent
    // envelope. Never both codes in one response.
    if (validationIssues.length > 0) {
      throw validationError(STRINGS.errors.invalidInput, validationIssues);
    }

    const presentUserIds = await this.fetchPresentUserIds(envelope, uniqueReferencedIds);
    const missingUserPayload = deriveMissingUserRefsPayload(userRefs, presentUserIds);
    if (missingUserPayload !== null) {
      throw missingUserRefs(missingUserPayload);
    }

    // Pre-map before opening the tx — pure transformation, no reason to hold
    // a write lock while building the row objects. Issue #163: attachment
    // rows are NOT inserted here; they are created via the per-attachment
    // `init` + presigned PUT + `complete` pipeline driven by the client
    // orchestrator (AC-253).
    const userRows = envelope.users.map(toUserInsert);
    const companyProfileRows = envelope.company_profile.map(toCompanyProfileInsert);
    const customerRows = envelope.customers.map(toCustomerInsert);
    const projectRows = envelope.projects.map(toProjectInsert);
    const assignmentRows = envelope.project_workers.map(toAssignmentInsert);
    const invoiceSequenceRows = envelope.invoice_sequence.map(toInvoiceSequenceInsert);

    // Invoice two-pass: insert originals (cancellationOf IS NULL) first,
    // then Stornos (cancellationOf !== null). The envelope arrives ordered
    // by the exporter, but a hand-edited envelope may reorder — we
    // re-slice here defensively so the self-FK is satisfied regardless
    // of input order. Two separate `insert().values()` calls.
    const invoiceOriginals = envelope.invoices
      .filter((inv) => inv.cancellationOf === null)
      .map(toInvoiceInsert);
    const invoiceStornos = envelope.invoices
      .filter((inv) => inv.cancellationOf !== null)
      .map(toInvoiceInsert);

    let keysToHide: Array<{ originalKey: string; thumbKey: string | null }> = [];
    let sessionInvalidated = false;

    await this.db.transaction(async (tx) => {
      // VPN-first deployment (ADR-0008) rules out concurrent restores in
      // practice, so the default READ COMMITTED isolation is sufficient —
      // TRUNCATE takes ACCESS EXCLUSIVE anyway.
      const presenceResult = await tx.execute<{ present: boolean }>(
        sql`SELECT (
          EXISTS (SELECT 1 FROM customers)
          OR EXISTS (SELECT 1 FROM projects)
          OR EXISTS (SELECT 1 FROM project_workers)
          OR EXISTS (SELECT 1 FROM invoices)
          OR EXISTS (SELECT 1 FROM attachments)
        ) AS present`,
      );
      const hasExisting = presenceResult.rows[0]?.present === true;

      if (hasExisting && !opts.override) {
        throw targetNotEmpty();
      }

      // AC-160: destructive path (override into a non-empty target) demands
      // a typed confirmation phrase in the request body. The shared
      // `restorePhraseMatches` predicate keeps this check identical to the
      // client-side UX gate. Dry-run and empty-target paths never reach here.
      if (opts.override && hasExisting) {
        const typed = opts.confirmationPhrase;
        if (typeof typed !== 'string' || !restorePhraseMatches(typed)) {
          throw restoreConfirmationMismatch();
        }
        if (this.storage === null || log === undefined) {
          // The override path mutates storage state too — refuse it on
          // a service constructed without those collaborators rather
          // than silently leak the prior bytes. Empty-target callers
          // (e.g. the seed) never reach this branch.
          throw new Error('ImportService.import: override path requires storage + logger');
        }
      }

      if (opts.override) {
        // AC-254 / issue #230: the wipe is unconditional under override
        // and now covers the expanded set. CASCADE handles dependency
        // order — TRUNCATE … CASCADE propagates through every FK
        // reference (including `sessions.user_id → users.id ON DELETE
        // CASCADE`, which wipes every active session including the
        // operator's; see `sessionInvalidated` flag below).
        //
        // The storage objects backing the wiped attachment rows are NOT
        // cleaned up by either reaper: the pending-orphan reaper only
        // sweeps `status='pending'` rows past TTL, and the bucket
        // lifecycle rule reaps noncurrent versions only — a TRUNCATE
        // without a hide call leaves the prior bytes as the *current*
        // version of an unreferenced key, which lifecycle never reaches
        // (issue #163 follow-up). Capture the keys before the wipe so
        // the post-commit hide demotes them to noncurrent and the
        // existing lifecycle policy reaps them on its own clock.
        keysToHide = await listAllKeys(tx);
        // Order of tables in TRUNCATE is immaterial under CASCADE, but
        // listing the dependents-first reads more naturally. Note:
        // `company_profile` and `invoice_sequence` are listed
        // explicitly — they have no FK back to the rest of the wipe
        // set so CASCADE alone would not reach them.
        await tx.execute(
          sql`TRUNCATE TABLE
            attachments,
            invoices,
            invoice_sequence,
            project_workers,
            projects,
            customers,
            company_profile,
            users
          RESTART IDENTITY CASCADE`,
        );
        // The wipe cascaded to `sessions` (ON DELETE CASCADE on users).
        // Flag the result so the client can redirect to login cleanly
        // rather than hitting a 401 on the next request.
        sessionInvalidated = true;
      }

      // Insert order — pinned by issue #230:
      //   users → company_profile → customers → projects → project_workers
      //   → invoice_sequence → invoices (originals) → invoices (stornos).
      // Justified by FK direction:
      //   - users come first (every other table's audit columns reference
      //     users.id).
      //   - company_profile depends on users (updatedBy → users.id).
      //   - customers depends on users (createdBy/updatedBy).
      //   - projects depends on customers + users.
      //   - project_workers depends on projects + users.
      //   - invoice_sequence has no FK — order is cosmetic but kept
      //     before invoices so the next-number allocator is ready.
      //   - invoices originals (cancellationOf IS NULL) before Stornos
      //     so the self-FK from Storno → original resolves.
      if (userRows.length > 0) {
        await tx.insert(users).values(userRows);
      }
      if (companyProfileRows.length > 0) {
        // Singleton: the table holds at most one row by CHECK + UNIQUE
        // on the `singleton` boolean. After the wipe (or on a fresh
        // install where the baseline migration pre-seeded a default
        // row that the wipe just removed) we INSERT the envelope's
        // singleton. The empty-target path is the one wrinkle: a
        // baseline-pre-seeded row exists; we upsert with `ON CONFLICT
        // (singleton) DO UPDATE` so the envelope's contents replace
        // the placeholder. Drizzle's `onConflictDoUpdate` keeps the
        // semantic explicit.
        await tx
          .insert(companyProfile)
          .values(companyProfileRows)
          .onConflictDoUpdate({
            target: companyProfile.singleton,
            set: {
              id: sql`excluded.id`,
              companyName: sql`excluded.company_name`,
              address: sql`excluded.address`,
              taxId: sql`excluded.tax_id`,
              ustId: sql`excluded.ust_id`,
              iban: sql`excluded.iban`,
              accentColor: sql`excluded.accent_color`,
              footerText: sql`excluded.footer_text`,
              logoBinaryDescriptorId: sql`excluded.logo_binary_descriptor_id`,
              defaultTaxMode: sql`excluded.default_tax_mode`,
              updatedAt: sql`excluded.updated_at`,
              updatedBy: sql`excluded.updated_by`,
            },
          });
      }
      if (customerRows.length > 0) {
        await tx.insert(customers).values(customerRows);
      }
      if (projectRows.length > 0) {
        await tx.insert(projects).values(projectRows);
      }
      if (assignmentRows.length > 0) {
        await tx.insert(projectWorkers).values(assignmentRows);
      }
      if (invoiceSequenceRows.length > 0) {
        await tx.insert(invoiceSequence).values(invoiceSequenceRows);
      }
      if (invoiceOriginals.length > 0) {
        await tx.insert(invoices).values(invoiceOriginals);
      }
      if (invoiceStornos.length > 0) {
        await tx.insert(invoices).values(invoiceStornos);
      }

      // Per-entity-type import audit rows. One row per non-empty entity
      // slot, written inside the outer transaction so the audit + writes
      // commit together (parity with ADR-0021 — every domain state
      // change has its audit row in the same transaction). The
      // `actorKind='system'` + `actorReason='data:import'` shape matches
      // the existing bootstrap pattern (`bootstrap.ts`).
      //
      // entity_id pin: the column is NOT NULL (data-model.md §5.10);
      // we use the first row's id of the slot as a representative
      // anchor (deterministic, traceable back to the envelope). For
      // invoice_sequence (composite-key, no UUID) we mint a synthetic
      // UUID from the year/kind pair — the audit row's purpose here is
      // a marker of "import happened", not a foreign key into the
      // sequence row. For company_profile we use its (singleton) id.
      //
      // Note: no `attachment`-typed audit row is emitted here (per
      // AC-253 the text leg does not insert attachment rows; the
      // per-attachment audit rows come from the client orchestrator's
      // `init`+`complete` calls in the binary leg).
      // `correlationId` is null — the import is a single batch event;
      // the route layer doesn't thread the Fastify request id through
      // the ImportService constructor (would require a signature
      // change for a system-actor side effect). The audit row is
      // findable via (actor_kind='system', action='import_restored').
      const auditCorrelationId: string | null = null;
      const auditRows: Array<{
        actorKind: 'system';
        actorId: null;
        actorReason: string;
        entityType: AuditEntityType;
        entityId: string;
        entityLabel: string | null;
        action: string;
        payload: { count: number };
        ancestorEntityType: null;
        ancestorEntityId: null;
        correlationId: string | null;
      }> = [];
      const importAudit = (
        slot: Array<{ id: string }>,
        entityType: AuditEntityType,
        synthEntityId?: string,
      ): void => {
        if (slot.length === 0) return;
        auditRows.push({
          actorKind: 'system',
          actorId: null,
          actorReason: 'data:import',
          entityType,
          // `slot[0]!.id` for natural-key slots; `synthEntityId` (a
          // synthetic UUID) for invoice_sequence whose pkey is the
          // composite (year, kind).
          entityId: synthEntityId ?? slot[0]!.id,
          // German operator-facing label; the audit feed renders it
          // verbatim in the activity view (data-model.md §5.10).
          entityLabel: `Import: ${slot.length} Datensätze`,
          action: 'import_restored',
          payload: { count: slot.length },
          ancestorEntityType: null,
          ancestorEntityId: null,
          correlationId: auditCorrelationId,
        });
      };

      importAudit(userRows, 'user');
      importAudit(companyProfileRows, 'company_profile');
      importAudit(customerRows, 'customer');
      importAudit(projectRows, 'project');
      // project_workers composite pkey — use the projectId of the first
      // row as the anchor (correlates the audit row with the project
      // it assigned). `slot[0].id` is missing because the assignment row
      // has no `id`, so we inline a tailored push.
      if (assignmentRows.length > 0) {
        auditRows.push({
          actorKind: 'system',
          actorId: null,
          actorReason: 'data:import',
          entityType: 'project_worker',
          entityId: assignmentRows[0]!.projectId,
          entityLabel: `Import: ${assignmentRows.length} Datensätze`,
          action: 'import_restored',
          payload: { count: assignmentRows.length },
          ancestorEntityType: null,
          ancestorEntityId: null,
          correlationId: auditCorrelationId,
        });
      }
      // Invoices: one combined audit row across originals + Stornos.
      // The audit feed cares about "the import wrote N invoice rows",
      // not the two-pass insert split. invoice_sequence has no native
      // AuditEntityType (the closed `AUDIT_ENTITY_TYPES` set does not
      // include the sequence table); rather than mint an off-allowlist
      // entity_type that the CHECK constraint would reject, we omit
      // the per-slot row for invoice_sequence. The sequence is a
      // counter-restore detail subordinate to the invoice rows it
      // numbers; the per-invoice audit row stands in.
      const totalInvoiceCount = invoiceOriginals.length + invoiceStornos.length;
      if (totalInvoiceCount > 0) {
        // Anchor: prefer an original-row id (most invoices have an
        // original; the Storno row references it). If only Stornos
        // exist (unusual but legal — hand-edited envelope), fall back
        // to the first Storno.
        const anchorId =
          invoiceOriginals.length > 0 ? invoiceOriginals[0]!.id : invoiceStornos[0]!.id;
        auditRows.push({
          actorKind: 'system',
          actorId: null,
          actorReason: 'data:import',
          entityType: 'invoice',
          entityId: anchorId,
          entityLabel: `Import: ${totalInvoiceCount} Datensätze`,
          action: 'import_restored',
          payload: { count: totalInvoiceCount },
          ancestorEntityType: null,
          ancestorEntityId: null,
          correlationId: auditCorrelationId,
        });
      }

      if (auditRows.length > 0) {
        await tx.insert(auditLog).values(auditRows);
      }
    });

    // Post-commit project-list invalidation (AC-276). Both non-dry-run
    // branches write project rows: override TRUNCATEs and re-inserts
    // (replacing the corpus); empty-target inserts into empty tables
    // (establishing the corpus). One coarse signal is sufficient for
    // every consumer to refetch (architecture.md §11.13). The dry-run
    // path returned early above and never reaches here.
    emitProjectChanged();

    // Post-commit storage cleanup. A failure here does not abort the
    // import — the rows are already gone; orphaned keys are logged
    // and operators can sweep them later (see #169). Doing this
    // outside the tx avoids coupling a non-transactional side effect
    // to the SQL commit: a rollback after a successful hide cannot be
    // undone.
    if (keysToHide.length > 0 && this.storage !== null && log !== undefined) {
      await bestEffortHideStorageKeys(this.storage, keysToHide, log);
    }

    return {
      schema_version: SCHEMA_VERSION,
      summary: {
        users: envelope.users.length,
        company_profile: envelope.company_profile.length,
        customers: envelope.customers.length,
        projects: envelope.projects.length,
        project_workers: envelope.project_workers.length,
        invoices: envelope.invoices.length,
        invoice_sequence: envelope.invoice_sequence.length,
      },
      sessionInvalidated,
    };
  }
}
