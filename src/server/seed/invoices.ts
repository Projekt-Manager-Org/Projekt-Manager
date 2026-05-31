/**
 * Seed invoices loader — issues a fixture set against the live invoice
 * services so every seed run exercises the full issuance contract:
 * sequence allocation, snapshot freezing, factur-x XML build + XSD
 * validate, PDF render, age-wrapped binary persistence, parent-project
 * status transition, audit emission.
 *
 * Loader vs. envelope: the customer / project loaders go through
 * `ImportService.import` because the import envelope is their authored
 * contract. Invoices have NO import envelope (data-model.md §5.8) —
 * they are produced by the issuance atom, not by bulk insert. Calling
 * `InvoiceService` directly is the correct shape, mirroring what every
 * production caller does.
 *
 * Project-state choreography: `InvoiceIssueService.runIssueInsideTx`
 * rejects any project not in `rechnung_faellig`, and on success flips
 * it to `abgerechnet`. To populate the later-state projects with
 * their historical invoices, this loader temporarily sets each
 * project's status to `rechnung_faellig` before issuing, and restores
 * the original target afterward. Cancellation does NOT touch project
 * status (AC-290), so a cancel-then-reissue pair needs another flip
 * back to `rechnung_faellig` between the two issuances.
 *
 * The three projects that natively start in `rechnung_faellig` (013,
 * 014, 015) are deliberately left untouched — the integration tests
 * in `invoices-routes.test.ts` claim them via
 * `rechnungFaelligProjectId()` as fresh "ready to invoice" slots and
 * need at least three available. Drafts are placed on these projects
 * to populate the "draft on a rechnung_faellig project" UI path
 * without consuming the slot (drafts do not transition project
 * status).
 */

import { eq } from 'drizzle-orm';

import type { Database } from '../db/connection.js';
import { projects } from '../db/schema.js';
import { createInvoiceService } from '../services/InvoiceService.js';
import type { ServiceLogger } from '../services/Logger.js';
import { getSeededUserIds } from './users.js';
import type { InvoiceLine, InvoiceRecipientSnapshot, TaxMode } from '../../domain/invoice.js';

// `info` is silenced — routine seed invoice creation should not flood
// the dev startup log. `error` still goes to console so a broken seed
// is visible.
const SEED_LOG: ServiceLogger = {
  info: () => {},
  error: (ctx, evt) => console.error(`[seed/invoices] ${evt}`, ctx),
};

type RestorableProjectStatus = 'abgerechnet' | 'erledigt' | 'abnahme';

interface IssueSpec {
  projectNumberSuffix: string;
  /** Absolute ISO date (`YYYY-MM-DD`) used as the issuance clock seam.
   *  Drives both `issueDate` AND the gapless `RE-YYYY-NNNN` allocation,
   *  so the spread of issuances across 2024/2025/2026 is what the
   *  bookkeeper sees in the list. */
  issueDate: string;
  /** Offset (days) from `issueDate` to compute `performanceDate`.
   *  Negative = performance happened before issuance (the typical
   *  Handwerker case). */
  performanceDateDaysFromIssue: number;
  taxMode?: TaxMode;
  /** Overrides applied to the draft's recipient before issuance — for
   *  the reverse_charge ustId requirement (no seed customer carries
   *  one) and for customers with no address (`Kanzlei Dr. Meier`). */
  recipient?: {
    name?: string;
    address?: { street: string; zip: string; city: string } | null;
    ustId?: string | null;
  };
  lines: InvoiceLine[];
  /** If present: issue, then cancel; if `reissue` is also present, then
   *  re-issue a corrected invoice on the same project. */
  cancellation?: {
    reason: string;
    /** Days between the original `issueDate` and the cancellation
     *  Storno's own issueDate. Must be positive. */
    daysAfterIssue: number;
    reissue?: {
      issueDate: string;
      performanceDateDaysFromIssue: number;
      lines: InvoiceLine[];
    };
  };
  /** Final project status after all issue / cancel / reissue steps.
   *  `abgerechnet` is the natural post-issue state and needs no
   *  explicit restoration; the loader leaves the project there. The
   *  other values trigger a manual flip back to mirror the project's
   *  narrative state in the seed (an `erledigt` project means
   *  "invoiced and paid", `abnahme` means "work complete, not yet
   *  invoiced" — used here as the natural pre-issue state for the
   *  reproduced Wagner example). */
  finalProjectStatus: RestorableProjectStatus;
  /** Board age (`statusChangedAt`) for the project's final resting state,
   *  expressed as days from the seed `now` (negative = in the past).
   *  Issuance stamps `statusChangedAt` to the historical `issueDate`, so
   *  without this the board would age the project by the gap between
   *  `issueDate` and today. When set, the loader re-stamps the project to
   *  this deliberate offset after the issue/cancel/reissue choreography —
   *  decoupling the board age from the (intentionally historical)
   *  invoice date. When omitted the project is left at the post-issuance
   *  default (`now`, via `setProjectStatus`). */
  finalStatusChangedAtDaysFromNow?: number;
}

interface DraftSpec {
  projectNumberSuffix: string;
  performanceDateDaysFromNow: number;
  taxMode?: TaxMode;
  lines: InvoiceLine[];
}

// -------------------------------------------------------------------
// Issue fixtures (executed in order — RE-YYYY-NNNN numbers follow this
// ordering, so the resulting allocation is deterministic).
//
// Targets only `abgerechnet`, `erledigt`, and `abnahme` projects so
// the three `rechnung_faellig` slots (013, 014, 015) remain available
// to `invoices-routes.test.ts`. Each spec temporarily flips its
// project through `rechnung_faellig` and back.
// -------------------------------------------------------------------
const ISSUE_SPECS: readonly IssueSpec[] = [
  // RE-0001 — Rheinisch-Bergischer Kreis, Schule am Park. 4 lines,
  // reverse_charge (§13b — construction services). Recipient ustId
  // overridden because the seeded customer carries none. Also serves
  // as the cancellation showcase: the first issue is cancelled (wrong
  // measurements) and re-issued with corrected lines.
  {
    projectNumberSuffix: '016',
    issueDate: '2024-03-12',
    performanceDateDaysFromIssue: -15,
    taxMode: 'reverse_charge',
    recipient: { ustId: 'DE246800000' },
    lines: [
      {
        description: 'Fassadenanstrich Hauptgebäude',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 18500,
        lineTotal: 18500,
        taxRate: 0,
      },
      {
        description: 'Fassadenanstrich Sporthalle',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 9800,
        lineTotal: 9800,
        taxRate: 0,
      },
      {
        description: 'Gerüststellung 4 Wochen inkl. Auf- und Abbau',
        quantity: 4,
        unit: 'Woche',
        unitPrice: 850,
        lineTotal: 3400,
        taxRate: 0,
      },
      {
        description: 'Reinigung und Entsorgung',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 300,
        lineTotal: 300,
        taxRate: 0,
      },
    ],
    cancellation: {
      reason: 'Falsche Aufmaß-Angabe Sporthalle — Neu ausgestellt mit korrigierter Position.',
      daysAfterIssue: 21,
      reissue: {
        issueDate: '2024-04-05',
        performanceDateDaysFromIssue: -39,
        lines: [
          {
            description: 'Fassadenanstrich Hauptgebäude',
            quantity: 1,
            unit: 'Pauschal',
            unitPrice: 18500,
            lineTotal: 18500,
            taxRate: 0,
          },
          {
            description: 'Fassadenanstrich Sporthalle (korrigierte Fläche)',
            quantity: 1,
            unit: 'Pauschal',
            unitPrice: 8200,
            lineTotal: 8200,
            taxRate: 0,
          },
          {
            description: 'Gerüststellung 4 Wochen inkl. Auf- und Abbau',
            quantity: 4,
            unit: 'Woche',
            unitPrice: 850,
            lineTotal: 3400,
            taxRate: 0,
          },
          {
            description: 'Reinigung und Entsorgung',
            quantity: 1,
            unit: 'Pauschal',
            unitPrice: 300,
            lineTotal: 300,
            taxRate: 0,
          },
        ],
      },
    },
    finalProjectStatus: 'abgerechnet',
    // Showcase the "make inaction visible" buffer badge: a little past
    // the 30-day `abgerechnet` aging threshold (stateConfig.ts) so the
    // board reads "an invoice has been waiting on payment too long" with
    // realistic data — not the ~2-year gap the 2024 issueDate would imply.
    finalStatusChangedAtDaysFromNow: -34,
  },

  // RE-0004 (after the cancellation pair RE-0002 + ST-0001 + RE-0003)
  // — Metzgerei Frank, Türen-Lackierarbeiten. Standard mode, single
  // line. Note: number depends on allocator order — see numbers via
  // `db.select(...).from(invoices)` after a seed run.
  {
    projectNumberSuffix: '017',
    issueDate: '2024-07-18',
    performanceDateDaysFromIssue: -6,
    lines: [
      {
        description: 'Lackierarbeiten Türen Verkaufsraum',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 3450,
        lineTotal: 3450,
        taxRate: 19,
      },
    ],
    finalProjectStatus: 'abgerechnet',
    // Second aged buffer so the Abgerechnet column badge reads "2× seit
    // >30 Tagen" — a slightly older overdue invoice than RE-0001's.
    finalStatusChangedAtDaysFromNow: -41,
  },

  // — Familie Richter, Neubau-Malerarbeiten. 2 lines, standard. The
  // project's narrative state is `erledigt` (paid + done); restored
  // after issue.
  {
    projectNumberSuffix: '018',
    issueDate: '2025-04-22',
    performanceDateDaysFromIssue: -12,
    lines: [
      {
        description: 'Innenanstrich Erdgeschoss',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 11200,
        lineTotal: 11200,
        taxRate: 19,
      },
      {
        description: 'Innenanstrich Obergeschoss',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 9800,
        lineTotal: 9800,
        taxRate: 19,
      },
    ],
    finalProjectStatus: 'erledigt',
  },

  // — Kanzlei Dr. Meier, Wandgestaltung. Standard, single line. The
  // seeded customer has NO address, so `recipient.address` is
  // overridden to satisfy the issue-time guard (AC-289).
  {
    projectNumberSuffix: '019',
    issueDate: '2025-10-14',
    performanceDateDaysFromIssue: -10,
    recipient: {
      address: { street: 'Hauptstr. 88', zip: '51465', city: 'Bergisch Gladbach' },
    },
    lines: [
      {
        description: 'Wandgestaltung Empfang inkl. Strukturputz',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 5400,
        lineTotal: 5400,
        taxRate: 19,
      },
    ],
    finalProjectStatus: 'erledigt',
  },

  // — Herr Wagner, Außenanstrich Reihenhaus. Project is in `abnahme`
  // — flipped to `rechnung_faellig` for issuance, restored to
  // `abnahme` after. Mirrors the example invoice the user pinned the
  // rule-overlap fix against.
  {
    projectNumberSuffix: '012',
    issueDate: '2026-02-08',
    performanceDateDaysFromIssue: -4,
    lines: [
      {
        description: 'Außenanstrich Reihenhaus inkl. Material',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 3450,
        lineTotal: 3450,
        taxRate: 19,
      },
    ],
    finalProjectStatus: 'abnahme',
  },
];

// -------------------------------------------------------------------
// Draft fixtures — invoices in `status='draft'`, attached to projects
// in various states. These exercise the draft list / draft form UI
// without ever being issued; drafts do not transition project status
// so the `rechnung_faellig` slots remain available to integration
// tests.
// -------------------------------------------------------------------
const DRAFT_SPECS: readonly DraftSpec[] = [
  // D1 — Stadt Bergisch Gladbach (013, rechnung_faellig). The
  // "almost-ready" invoice that landed the project in its current
  // state.
  {
    projectNumberSuffix: '013',
    performanceDateDaysFromNow: -3,
    lines: [
      {
        description: 'Malerarbeiten Kita Sonnenkäfer — Innenräume',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 14850,
        lineTotal: 14850,
        taxRate: 19,
      },
    ],
  },

  // D2 — Autohaus Kramer (014, rechnung_faellig). Multi-line draft
  // with a deliberately long description to exercise the table wrap
  // path in the draft preview / PDF render once issued.
  {
    projectNumberSuffix: '014',
    performanceDateDaysFromNow: -6,
    lines: [
      {
        description:
          'Werkstattboden Epoxidharz-Beschichtung inkl. Grundierung, zweischichtigem Aufbau und rutschhemmender Versiegelung',
        quantity: 285,
        unit: 'm²',
        unitPrice: 24,
        lineTotal: 6840,
        taxRate: 19,
      },
      {
        description: 'Sockelaufkantung und Material',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 1280,
        lineTotal: 1280,
        taxRate: 19,
      },
    ],
  },

  // D3 — Herr Peters (015, rechnung_faellig). Kleinunternehmer mode.
  {
    projectNumberSuffix: '015',
    performanceDateDaysFromNow: -9,
    taxMode: 'kleinunternehmer',
    lines: [
      {
        description: 'Anstrich Gartenlaube außen',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 1180,
        lineTotal: 1180,
        taxRate: 0,
      },
    ],
  },

  // D4 — Café Sonnenschein (011, in_arbeit). Standard mode, single
  // line. The painter is already preparing the invoice for a
  // still-in-progress job.
  {
    projectNumberSuffix: '011',
    performanceDateDaysFromNow: -1,
    lines: [
      {
        description: 'Renovierung Gastraum — Wände und Decken',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 4200,
        lineTotal: 4200,
        taxRate: 19,
      },
    ],
  },

  // D5 — Familie Hoffmann (010, in_arbeit). Kleinunternehmer
  // multi-line.
  {
    projectNumberSuffix: '010',
    performanceDateDaysFromNow: 0,
    taxMode: 'kleinunternehmer',
    lines: [
      {
        description: 'Tapezieren Wohnzimmer',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 980,
        lineTotal: 980,
        taxRate: 0,
      },
      {
        description: 'Anstrich Decke und Wände Schlafzimmer',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 720,
        lineTotal: 720,
        taxRate: 0,
      },
    ],
  },
];

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateFromNow(now: Date, days: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** Parse a YYYY-MM-DD literal at midday UTC, avoiding TZ edge cases
 *  when used as the issuance clock seam. */
function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

/** Add days to a Date, returning a new Date. */
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Apply the invoice fixtures against the live services. The orchestrator
 * has already wiped + reseeded users / business / profile, so each call
 * here lands against a known starting state.
 */
export async function loadInvoices(db: Database, opts: { now?: Date } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const service = createInvoiceService(db);
  const userIds = getSeededUserIds();
  const ownerId = userIds['inhaber'];
  if (!ownerId) throw new Error('Seed bug: inhaber user id missing — loadUsers must run first');

  const projectIdByNumber = await loadProjectIdMap(db);

  for (const spec of ISSUE_SPECS) {
    await applyIssueSpec(db, service, ownerId, projectIdByNumber, now, spec);
  }

  for (const spec of DRAFT_SPECS) {
    await applyDraftSpec(service, ownerId, projectIdByNumber, now, spec);
  }
}

async function loadProjectIdMap(db: Database): Promise<Map<string, string>> {
  const rows = await db.select({ id: projects.id, number: projects.number }).from(projects);
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.number, r.id);
  return map;
}

function resolveProjectId(map: Map<string, string>, suffix: string): string {
  // The business loader uses `${year}-${suffix}` from the seed `now`.
  // We rebuild the same shape here.
  const year = new Date().getUTCFullYear();
  const num = `${year}-${suffix}`;
  const id = map.get(num);
  if (!id) {
    throw new Error(`Seed bug: no project with number '${num}' — business loader must run first`);
  }
  return id;
}

async function setProjectStatus(
  db: Database,
  projectId: string,
  status: 'rechnung_faellig' | RestorableProjectStatus,
  statusChangedAt: Date = new Date(),
): Promise<void> {
  // Direct UPDATE on `projects.status` — the project state machine's
  // legal-transition table doesn't allow `erledigt → rechnung_faellig`
  // (workflows.md §projectStatus), and the seed deliberately bypasses
  // that machine to reconstruct historical state. The orchestrator's
  // TRUNCATE just ran, so no users are observing these transitions.
  await db.update(projects).set({ status, statusChangedAt }).where(eq(projects.id, projectId));
}

async function applyIssueSpec(
  db: Database,
  service: ReturnType<typeof createInvoiceService>,
  ownerId: string,
  projectIdByNumber: Map<string, string>,
  now: Date,
  spec: IssueSpec,
): Promise<void> {
  const projectId = resolveProjectId(projectIdByNumber, spec.projectNumberSuffix);

  await setProjectStatus(db, projectId, 'rechnung_faellig');

  // `recipient` cast: `CreateDraftInput.recipient` is typed as a full
  // `InvoiceRecipientSnapshot` but `InvoiceService.createDraft` treats
  // each field as an optional overlay over the customer's row
  // (services/InvoiceService.ts:279-294). The seed supplies sparse
  // overrides (`address` only for the no-address customer; `ustId`
  // only for reverse_charge) and relies on that overlay semantics — a
  // future tightening of the service signature should turn this cast
  // into a proper partial type.
  const recipientOverride = spec.recipient as InvoiceRecipientSnapshot | undefined;

  const issueDate = parseIsoDate(spec.issueDate);

  const draft = await service.createDraft(
    {
      projectId,
      lines: spec.lines,
      taxMode: spec.taxMode,
      recipient: recipientOverride,
      performanceDate: dateFromNow(issueDate, spec.performanceDateDaysFromIssue),
    },
    ownerId,
    SEED_LOG,
    null,
  );

  await service.issueDraft(draft.id, ownerId, SEED_LOG, null, issueDate);

  if (spec.cancellation) {
    const cancellationDate = addDays(issueDate, spec.cancellation.daysAfterIssue);
    await service.cancel(
      draft.id,
      { reason: spec.cancellation.reason },
      ownerId,
      SEED_LOG,
      null,
      cancellationDate,
    );

    if (spec.cancellation.reissue) {
      // After cancellation the project is still `abgerechnet` (cancel
      // does not touch project status per AC-290); flip back so the
      // corrected invoice can be issued on the same project.
      await setProjectStatus(db, projectId, 'rechnung_faellig');

      const reissueIssueDate = parseIsoDate(spec.cancellation.reissue.issueDate);
      const reissueDraft = await service.createDraft(
        {
          projectId,
          lines: spec.cancellation.reissue.lines,
          taxMode: spec.taxMode,
          recipient: recipientOverride,
          performanceDate: dateFromNow(
            reissueIssueDate,
            spec.cancellation.reissue.performanceDateDaysFromIssue,
          ),
        },
        ownerId,
        SEED_LOG,
        null,
      );
      await service.issueDraft(reissueDraft.id, ownerId, SEED_LOG, null, reissueIssueDate);
    }
  }

  // Restore the project's final resting state. Issuance left it in
  // `abgerechnet` stamped at the (historical) issueDate; `erledigt` /
  // `abnahme` additionally need the status flipped back. In every case
  // re-stamp `statusChangedAt` so the board reflects the project's
  // intended age in its current state rather than the invoice's issue
  // date. A `finalStatusChangedAtDaysFromNow` offset (the two aged
  // `abgerechnet` showcases) re-stamps to that deliberate window; without
  // one the project lands at `now` (the `setProjectStatus` default).
  const finalStatusChangedAt =
    spec.finalStatusChangedAtDaysFromNow === undefined
      ? undefined
      : addDays(now, spec.finalStatusChangedAtDaysFromNow);
  await setProjectStatus(db, projectId, spec.finalProjectStatus, finalStatusChangedAt);
}

async function applyDraftSpec(
  service: ReturnType<typeof createInvoiceService>,
  ownerId: string,
  projectIdByNumber: Map<string, string>,
  now: Date,
  spec: DraftSpec,
): Promise<void> {
  const projectId = resolveProjectId(projectIdByNumber, spec.projectNumberSuffix);
  await service.createDraft(
    {
      projectId,
      lines: spec.lines,
      taxMode: spec.taxMode,
      performanceDate: dateFromNow(now, spec.performanceDateDaysFromNow),
    },
    ownerId,
    SEED_LOG,
    null,
  );
}
