/**
 * Seed business-envelope builder — users, company_profile, customers,
 * projects, project_workers.
 *
 * Issue #230: the Layer 1 envelope covers every user-meaningful table
 * (data-model.md §5.8, ADR-0018). The seed assembles the whole envelope
 * in one place and ships it through the same `ImportService.import` path
 * the public restore uses, so envelope-format drift breaks the
 * seed and the public restore path together instead of only one or the
 * other. Invoices and `invoice_sequence` stay empty in the envelope —
 * `loadInvoices` mints them afterwards through the real draft→issue
 * lifecycle (real PDFs, sequence allocation, audit rows).
 *
 * The transformer (`buildBusinessEnvelope`) is pure and takes `now` plus
 * a pre-hashed password as the only inputs. `now` is the single
 * reference moment — every relative date (and the project number year
 * prefix) is derived from it. `hashedPassword` is bcrypt-hashed once by
 * the orchestrator (bcrypt is expensive) and threaded onto every
 * `users[*].passwordHash` slot.
 */
import { randomUUID } from 'node:crypto';

import type { Database } from '../db/connection.js';
import { ImportService } from '../services/ImportService.js';
import {
  SCHEMA_VERSION,
  type Envelope,
  type EnvelopeCompanyProfile,
  type EnvelopeCustomer,
  type EnvelopeProject,
  type EnvelopeAssignment,
  type EnvelopeUser,
} from '../../domain/dataExchange.js';

import { daysFromNow } from './daysFromNow.js';
import { getSeededUserIds, getSeededUserRecords } from './users.js';

interface CustomerSpec {
  name: string;
  phone?: string;
  email?: string;
  address?: { street: string; zip: string; city: string };
  notes?: string;
}

interface ProjectSpec {
  numberSuffix: string; // e.g. '001' — year prefix is applied by the builder
  title: string;
  status: EnvelopeProject['status'];
  statusChangedAtDays: number;
  customerName: string;
  /**
   * Optional divergent Baustellen-/Leistungsadresse (data-model.md §5.1).
   * When omitted (the common case) the project's siteAddress is null and
   * the UI falls back to the customer's Rechnungsadresse. At least one
   * Hausverwaltung-style customer's project sets this so the divergent-
   * site rendering is exercised; the rest stay null so the fallback
   * branch is exercised too.
   */
  siteAddress?: { street: string; zip: string; city: string };
  plannedStartDays?: number;
  plannedEndDays?: number;
  estimatedValue?: string;
  createdAtDays: number;
  updatedAtDays: number;
}

interface AssignmentSpec {
  projectNumberSuffix: string;
  username: 'arbeiter1' | 'arbeiter2';
}

// ---------------------------------------------------------------
// Customers (data-model.md §7.3 — 21 customers, mix of full/minimal)
// ---------------------------------------------------------------
const CUSTOMER_SPECS: readonly CustomerSpec[] = [
  {
    name: 'Familie Müller',
    phone: '+49 221 1234567',
    address: { street: 'Hauptstr. 12', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Firma Weber GmbH',
    email: 'info@weber-gmbh.de',
  },
  {
    name: 'Schmidt Hausverwaltung',
    phone: '+49 221 9876543',
    address: { street: 'Kölner Str. 45', zip: '51429', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Weber Immobilien',
    phone: '+49 2202 54321',
    address: { street: 'Industriestr. 8', zip: '51399', city: 'Burscheid' },
  },
  {
    name: 'Familie Becker',
    phone: '+49 221 7654321',
    address: { street: 'Am Graben 7', zip: '51467', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Herr Schneider',
    // Minimal — no phone, email, or address
  },
  {
    name: 'Evangelische Gemeinde Refrath',
    phone: '+49 2204 12345',
    address: { street: 'Kirchweg 3', zip: '51427', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Frau Klein',
    phone: '+49 221 3456789',
    address: { street: 'Rosenweg 15', zip: '51469', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Dr. Braun Zahnarztpraxis',
    phone: '+49 2204 67890',
    address: { street: 'Bahnhofstr. 22', zip: '51427', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Familie Hoffmann',
    address: { street: 'Lindenallee 5', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Café Sonnenschein GbR',
    email: 'info@cafe-sonnenschein.de',
    address: { street: 'Marktplatz 1', zip: '51429', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Herr Wagner',
    phone: '+49 221 8765432',
    address: { street: 'Paffrather Str. 88', zip: '51469', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Stadt Bergisch Gladbach',
    email: 'vergabe@stadt-gl.de',
    address: { street: 'Schulstr. 12', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Autohaus Kramer GmbH',
    phone: '+49 2202 11111',
    address: { street: 'Gewerbepark 4', zip: '51399', city: 'Burscheid' },
  },
  {
    name: 'Herr Peters',
    // Address required even on minimal customers so the invoice issuance
    // gate (AC-289) passes when this customer's project is the first
    // `rechnung_faellig` row returned by the API ordering. The
    // customer-minimal-data path is exercised by the no-address arm of
    // `customers.test.ts` instead.
    address: { street: 'Gartenweg 4', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Rheinisch-Bergischer Kreis',
    email: 'bau@rbk-online.de',
    address: { street: 'Schulweg 20', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Metzgerei Frank',
    phone: '+49 221 2222222',
    address: { street: 'Hauptstr. 55', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Familie Richter',
    phone: '+49 2204 33333',
    address: { street: 'Birkenweg 9', zip: '51427', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Kanzlei Dr. Meier',
    email: 'kanzlei@dr-meier.de',
    // No address
  },
  // Customers with no projects yet (spec §7.3)
  {
    name: 'Schulz & Partner PartG',
    phone: '+49 221 4444444',
    notes: 'Kontakt über Empfehlung',
  },
  {
    name: 'Monika Engel',
    notes: 'Import aus externem System',
  },
];

// ---------------------------------------------------------------
// Projects (data-model.md §7.1 — 19 projects across all 9 states)
// ---------------------------------------------------------------
const PROJECT_SPECS: readonly ProjectSpec[] = [
  // Anfrage (2) — recent, no dates planned
  {
    numberSuffix: '001',
    title: 'Fassadenanstrich Müller',
    status: 'anfrage',
    statusChangedAtDays: -1,
    customerName: 'Familie Müller',
    createdAtDays: -1,
    updatedAtDays: -1,
  },
  {
    numberSuffix: '002',
    title: 'Innenraumgestaltung Weber',
    status: 'anfrage',
    statusChangedAtDays: -10,
    customerName: 'Firma Weber GmbH',
    createdAtDays: -10,
    updatedAtDays: -10,
  },
  // Angebot (2) — one fresh, one stale
  {
    numberSuffix: '003',
    title: 'Treppenhaussanierung Schmidt',
    status: 'angebot',
    statusChangedAtDays: -3,
    customerName: 'Schmidt Hausverwaltung',
    // Divergent Baustelle — the Hausverwaltung's billing address sits
    // elsewhere; the work happens at one of its managed properties.
    // Exercises the project-detail panel's "Baustelle" line and the
    // form's populated-address branch (data-model.md §7.3, issue #179).
    siteAddress: { street: 'Goethestr. 18', zip: '51103', city: 'Köln' },
    estimatedValue: '8500.00',
    createdAtDays: -5,
    updatedAtDays: -3,
  },
  {
    numberSuffix: '004',
    title: 'Malerarbeiten Bürokomplex Weber',
    status: 'angebot',
    statusChangedAtDays: -18,
    customerName: 'Weber Immobilien',
    estimatedValue: '24000.00',
    createdAtDays: -20,
    updatedAtDays: -18,
  },
  // Beauftragt (2) — confirmed, no dates
  {
    numberSuffix: '005',
    title: 'Kellerdeckendämmung Becker',
    status: 'beauftragt',
    statusChangedAtDays: -4,
    customerName: 'Familie Becker',
    estimatedValue: '3200.00',
    createdAtDays: -8,
    updatedAtDays: -4,
  },
  {
    numberSuffix: '006',
    title: 'Fensteranstrich Schneider',
    status: 'beauftragt',
    statusChangedAtDays: -2,
    customerName: 'Herr Schneider',
    createdAtDays: -6,
    updatedAtDays: -2,
  },
  // Geplant (2) — dates assigned
  {
    numberSuffix: '007',
    title: 'Fassadensanierung Gemeindezentrum',
    status: 'geplant',
    statusChangedAtDays: -7,
    customerName: 'Evangelische Gemeinde Refrath',
    plannedStartDays: 5,
    plannedEndDays: 12,
    estimatedValue: '18500.00',
    createdAtDays: -14,
    updatedAtDays: -7,
  },
  {
    numberSuffix: '008',
    title: 'Wohnungsrenovierung Klein',
    status: 'geplant',
    statusChangedAtDays: -3,
    customerName: 'Frau Klein',
    plannedStartDays: 8,
    plannedEndDays: 10,
    estimatedValue: '4800.00',
    createdAtDays: -10,
    updatedAtDays: -3,
  },
  // In Arbeit (3) — currently on-site
  {
    numberSuffix: '009',
    title: 'Malerarbeiten Praxis Dr. Braun',
    status: 'in_arbeit',
    statusChangedAtDays: -5,
    customerName: 'Dr. Braun Zahnarztpraxis',
    plannedStartDays: -5,
    plannedEndDays: 2,
    estimatedValue: '12000.00',
    createdAtDays: -18,
    updatedAtDays: -5,
  },
  {
    numberSuffix: '010',
    title: 'Lackierung Treppengeländer Hoffmann',
    status: 'in_arbeit',
    statusChangedAtDays: -3,
    customerName: 'Familie Hoffmann',
    plannedStartDays: -3,
    plannedEndDays: -1, // slightly past end — edge case
    estimatedValue: '2800.00',
    createdAtDays: -12,
    updatedAtDays: -3,
  },
  {
    numberSuffix: '011',
    title: 'Tapezierarbeiten Café Sonnenschein',
    status: 'in_arbeit',
    statusChangedAtDays: -2,
    customerName: 'Café Sonnenschein GbR',
    plannedStartDays: -2,
    plannedEndDays: 1,
    estimatedValue: '6500.00',
    createdAtDays: -15,
    updatedAtDays: -2,
  },
  // Abnahme (1) — waiting for customer walk-through
  {
    numberSuffix: '012',
    title: 'Außenanstrich Reihenhaus Wagner',
    status: 'abnahme',
    statusChangedAtDays: -1,
    customerName: 'Herr Wagner',
    plannedStartDays: -10,
    plannedEndDays: -2,
    estimatedValue: '7200.00',
    createdAtDays: -21,
    updatedAtDays: -1,
  },
  // Rechnung fällig (3) — critical accumulation
  {
    numberSuffix: '013',
    title: 'Malerarbeiten Kita Sonnenkäfer',
    status: 'rechnung_faellig',
    statusChangedAtDays: -2,
    customerName: 'Stadt Bergisch Gladbach',
    plannedStartDays: -20,
    plannedEndDays: -5,
    estimatedValue: '15000.00',
    createdAtDays: -25,
    updatedAtDays: -2,
  },
  {
    numberSuffix: '014',
    title: 'Bodenbeschichtung Autohaus Kramer',
    status: 'rechnung_faellig',
    statusChangedAtDays: -5,
    customerName: 'Autohaus Kramer GmbH',
    estimatedValue: '9800.00',
    createdAtDays: -28,
    updatedAtDays: -5,
  },
  {
    numberSuffix: '015',
    title: 'Anstrich Gartenlaube Peters',
    status: 'rechnung_faellig',
    statusChangedAtDays: -8,
    customerName: 'Herr Peters',
    estimatedValue: '1200.00',
    createdAtDays: -22,
    updatedAtDays: -8,
  },
  // Abgerechnet (2) — invoice sent, waiting for payment. Both projects
  // are re-invoiced by the invoice loader (seed/invoices.ts), whose
  // issuance overwrites `statusChangedAt`. Their final board age — set a
  // little past the 30-day aging threshold so the buffer badge has
  // realistic data — lives there (`finalStatusChangedAtDaysFromNow`); the
  // values below are pre-issuance placeholders that never reach the board.
  {
    numberSuffix: '016',
    title: 'Fassadenanstrich Schule am Park',
    status: 'abgerechnet',
    statusChangedAtDays: -3,
    customerName: 'Rheinisch-Bergischer Kreis',
    plannedStartDays: -28,
    plannedEndDays: -15,
    estimatedValue: '32000.00',
    createdAtDays: -30,
    updatedAtDays: -3,
  },
  {
    numberSuffix: '017',
    title: 'Lackierarbeiten Türen Metzgerei Frank',
    status: 'abgerechnet',
    statusChangedAtDays: -6,
    customerName: 'Metzgerei Frank',
    estimatedValue: '3600.00',
    createdAtDays: -24,
    updatedAtDays: -6,
  },
  // Erledigt (2) — completed and paid
  {
    numberSuffix: '018',
    title: 'Malerarbeiten Neubau Richter',
    status: 'erledigt',
    statusChangedAtDays: -5,
    customerName: 'Familie Richter',
    plannedStartDays: -25,
    plannedEndDays: -12,
    estimatedValue: '21000.00',
    createdAtDays: -28,
    updatedAtDays: -5,
  },
  {
    numberSuffix: '019',
    title: 'Wandgestaltung Kanzlei Dr. Meier',
    status: 'erledigt',
    statusChangedAtDays: -10,
    customerName: 'Kanzlei Dr. Meier',
    estimatedValue: '5400.00',
    createdAtDays: -26,
    updatedAtDays: -10,
  },
];

// ---------------------------------------------------------------
// Project–Worker assignments (7 rows)
// ---------------------------------------------------------------
const ASSIGNMENT_SPECS: readonly AssignmentSpec[] = [
  // Geplant
  { projectNumberSuffix: '007', username: 'arbeiter1' },
  { projectNumberSuffix: '007', username: 'arbeiter2' },
  { projectNumberSuffix: '008', username: 'arbeiter1' },
  // In Arbeit
  { projectNumberSuffix: '009', username: 'arbeiter1' },
  { projectNumberSuffix: '009', username: 'arbeiter2' },
  { projectNumberSuffix: '010', username: 'arbeiter2' },
  { projectNumberSuffix: '011', username: 'arbeiter1' },
];

/**
 * Build the in-memory envelope that represents the seed's business data.
 * Pure — given the same `(now, hashedPassword)` the output is byte-equal.
 * Dates are ISO strings because the envelope types declare them that way
 * (`ImportService.toXxxInsert` parses them back to `Date`).
 *
 * `hashedPassword` is the bcrypt hash for `SEED_DEFAULT_PASSWORD`,
 * computed once by `seed.ts` and threaded onto every user row. Hashing
 * inline per row would multiply the seed runtime by the user count.
 */
export function buildBusinessEnvelope(now: Date, hashedPassword: string): Envelope {
  const year = now.getFullYear();
  const nowIso = now.toISOString();

  // Users: every fixture row becomes an envelope row. `passwordHash`
  // comes from the orchestrator (one bcrypt call, reused). Defaults
  // mirror the schema's column defaults (data-model.md §5.3, §5.7):
  //   themePreference = 'system', pushMuted = false, lastLoginAt = null.
  // `createdBy` / `updatedBy` are null — seeded users have no audit
  // ancestor inside the seed corpus.
  const userRows: EnvelopeUser[] = getSeededUserRecords().map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    passwordHash: hashedPassword,
    roles: u.roles,
    email: u.email,
    active: u.active,
    themePreference: 'system',
    pushMuted: false,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastLoginAt: null,
    createdBy: null,
    updatedBy: null,
  }));

  // Singleton company_profile (data-model.md §5.17, ADR-0026). The
  // baseline migration pre-seeds an empty placeholder row; the import
  // path UPSERTs over it via `ON CONFLICT (singleton)`, so a fresh
  // install ends up with this fixture's values. `accentColor`,
  // `footerText`, and `logoBinaryDescriptorId` stay null — the fixture
  // does not pin them and the schema defaults are the right resting
  // state.
  const companyProfileRow: EnvelopeCompanyProfile = {
    id: randomUUID(),
    companyName: 'Maler Berger GmbH',
    address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
    taxId: '111/222/33333',
    ustId: 'DE123456789',
    iban: 'DE12 1000 0000 1234 5678 90',
    accentColor: null,
    footerText: null,
    logoBinaryDescriptorId: null,
    defaultTaxMode: 'standard',
    updatedAt: nowIso,
    updatedBy: null,
  };

  // Customers first — projects reference customers by id.
  const customerById = new Map<string, EnvelopeCustomer>();
  const customerIdByName = new Map<string, string>();
  for (const spec of CUSTOMER_SPECS) {
    const id = randomUUID();
    const customer: EnvelopeCustomer = {
      id,
      name: spec.name,
      phone: spec.phone ?? null,
      email: spec.email ?? null,
      address: spec.address ?? null,
      // The seed business envelope ships every customer without a USt-IdNr.
      // Reverse-charge invoices (§13b — RE-0001 in the invoice seed) carry
      // a recipient-side `ustId` override on the issued snapshot instead;
      // see `src/server/seed/invoices.ts` for the override site.
      ustId: null,
      notes: spec.notes ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
      createdBy: null,
      updatedBy: null,
    };
    customerById.set(id, customer);
    customerIdByName.set(spec.name, id);
  }

  // Projects carry the year prefix derived from `now` — not from a
  // module-load-time capture. Dates are produced via the shared
  // `daysFromNow(now, d)` helper so every offset uses the same base.
  const projectById = new Map<string, EnvelopeProject>();
  const projectIdBySuffix = new Map<string, string>();
  for (const spec of PROJECT_SPECS) {
    const customerId = customerIdByName.get(spec.customerName);
    if (customerId === undefined) {
      throw new Error(
        `Seed business-envelope bug: project '${spec.numberSuffix}' references unknown customer '${spec.customerName}'`,
      );
    }
    const id = randomUUID();
    const project: EnvelopeProject = {
      id,
      number: `${year}-${spec.numberSuffix}`,
      title: spec.title,
      status: spec.status,
      statusChangedAt: daysFromNow(now, spec.statusChangedAtDays).toISOString(),
      customerId,
      siteAddress: spec.siteAddress ?? null,
      plannedStart:
        spec.plannedStartDays === undefined
          ? null
          : daysFromNow(now, spec.plannedStartDays).toISOString(),
      plannedEnd:
        spec.plannedEndDays === undefined
          ? null
          : daysFromNow(now, spec.plannedEndDays).toISOString(),
      estimatedValue: spec.estimatedValue ?? null,
      notes: null,
      deleted: false,
      createdAt: daysFromNow(now, spec.createdAtDays).toISOString(),
      updatedAt: daysFromNow(now, spec.updatedAtDays).toISOString(),
      createdBy: null,
      updatedBy: null,
    };
    projectById.set(id, project);
    projectIdBySuffix.set(spec.numberSuffix, id);
  }

  const userIdByUsername = getSeededUserIds();
  const assignments: EnvelopeAssignment[] = ASSIGNMENT_SPECS.map((a) => {
    const projectId = projectIdBySuffix.get(a.projectNumberSuffix);
    if (projectId === undefined) {
      throw new Error(
        `Seed business-envelope bug: assignment references unknown project suffix '${a.projectNumberSuffix}'`,
      );
    }
    const userId = userIdByUsername[a.username]!;
    return { projectId, userId };
  });

  return {
    schema_version: SCHEMA_VERSION,
    exported_at: nowIso,
    // Issue #230: this builder owns every envelope-resident table
    // EXCEPT invoices + invoice_sequence. Those stay empty here because
    // `loadInvoices` runs after the envelope lands and mints them
    // through the real draft→issue cycle (real PDFs, sequence
    // allocation, audit rows). Every other slot is populated so the
    // import is a single ImportService call exercising the full Layer 1
    // contract.
    users: userRows,
    company_profile: [companyProfileRow],
    customers: Array.from(customerById.values()),
    projects: Array.from(projectById.values()),
    project_workers: assignments,
    invoices: [],
    invoice_sequence: [],
    // Seed business data has no attachments — the seed only mints
    // text rows. The envelope shape requires the field, so an empty
    // array is the right shape (issue #163 / data-model.md §5.8).
    attachments: [],
  };
}

/**
 * Build and apply the business envelope via `ImportService`. Mirrors the
 * constructor pattern in `src/server/routes/data-exchange.ts`. The target
 * is guaranteed empty by the orchestrator's TRUNCATE, so the safe path
 * (`override: false`, `confirmationPhrase: null`) succeeds.
 *
 * `hashedPassword` is threaded through `buildBusinessEnvelope` onto every
 * user row — the orchestrator computes it once because bcrypt is
 * expensive (see `seed.ts`).
 */
export async function loadBusiness(
  db: Database,
  opts: { now?: Date; hashedPassword: string },
): Promise<void> {
  const now = opts.now ?? new Date();
  const envelope = buildBusinessEnvelope(now, opts.hashedPassword);
  const importService = new ImportService(db);
  await importService.import(envelope, {
    dryRun: false,
    override: false,
    confirmationPhrase: null,
  });
}
