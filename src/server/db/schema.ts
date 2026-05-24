/**
 * Drizzle ORM schema — PostgreSQL tables for Projekt-Manager.
 *
 * Tables: customers, projects, project_workers, users, sessions, audit_log,
 * notification_rule, push_subscriptions. See data-model.md for entity
 * definitions.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  bigint,
  smallint,
  timestamp,
  date,
  jsonb,
  numeric,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------
// Audit entity types — data-model.md §5.10
// ---------------------------------------------------------------
/**
 * The closed set of entity types that produce `audit_log` rows.
 *
 * Two flavours coexist in this set:
 *   - **Domain entity types** — `project`, `customer`, `user`,
 *     `project_worker`, `attachment`, `invoice`, `company_profile`. Each
 *     row in `audit_log` with one of these `entity_type` values describes
 *     a state change on the matching physical table; `entity_id` points
 *     at that row.
 *   - **Synthetic entity types** — `data_import` (and any future
 *     deployment-level event class). No physical table backs the
 *     `entity_id`; the audit row describes a deployment-level event
 *     (e.g. "an `/api/import` happened") whose granularity is the batch,
 *     not a single row. `entity_id` carries a synthetic UUID minted at
 *     write time.
 *
 * Repositories and services import the union type; the architecture
 * check (scripts/check-audit-mutations.sh) reads the table-map below
 * — only domain types appear there.
 */
export const AUDIT_ENTITY_TYPES = [
  'project',
  'customer',
  'user',
  'project_worker',
  'attachment',
  'invoice',
  'company_profile',
  'data_import',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * Maps each **domain** `AuditEntityType` to its physical table
 * representation: the SQL table name (used by raw-SQL scanners) and the
 * Drizzle export name (used by builder-call scanners). The architecture
 * check at `scripts/check-audit-mutations.sh` reads this map via
 * `scripts/print-audited-tables.ts` — AC-179 requires the audited-table
 * set to be derived from `AuditEntityType`, not hand-maintained.
 *
 * Synthetic entity types (e.g. `data_import`) have no physical row
 * backing the audit entry — they describe deployment-level events. They
 * are deliberately absent from this map; the `Partial<...>` type below
 * pins that absence so a new synthetic entity type does not need a
 * fake table mapping just to satisfy a `Record` constraint. A new
 * **domain** entity type still must land a mapping here, because the
 * scanner's audited-table set is the only line of defence against a
 * raw mutation slipping past the `mutate()` single-write-path; the
 * absence is checked at runtime in `print-audited-tables.ts` (an empty
 * set is refused).
 */
export const AUDIT_ENTITY_TO_TABLE = {
  project: { sqlName: 'projects', drizzleExport: 'projects' },
  customer: { sqlName: 'customers', drizzleExport: 'customers' },
  user: { sqlName: 'users', drizzleExport: 'users' },
  project_worker: { sqlName: 'project_workers', drizzleExport: 'projectWorkers' },
  attachment: { sqlName: 'attachments', drizzleExport: 'attachments' },
  invoice: { sqlName: 'invoices', drizzleExport: 'invoices' },
  company_profile: { sqlName: 'company_profile', drizzleExport: 'companyProfile' },
} as const satisfies Partial<Record<AuditEntityType, { sqlName: string; drizzleExport: string }>>;

// ---------------------------------------------------------------
// Users (data-model.md §5.3, §5.7)
// ---------------------------------------------------------------
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: varchar('username', { length: 255 }).notNull().unique(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    roles: text('roles').array().notNull().default([]),
    email: varchar('email', { length: 255 }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    // Audit references — nullable for seeded/bootstrapped records (data-model.md §5.5).
    // No FK back to users.id: self-referential FKs complicate bootstrapping
    // and deletion without adding meaningful integrity guarantees here.
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    // data-model.md §5.7: 'light' | 'dark' | 'system'. DB default matches
    // the documented new-user default; the CHECK constraint below is the
    // defense-in-depth backstop pinned by AT-57 / AC-115.
    themePreference: text('theme_preference').notNull().default('system'),
    // data-model.md §5.3 / §5.12: single self-settable boolean controlling
    // push delivery. Mute is a delivery-time filter — activity-feed
    // inclusion is independent.
    pushMuted: boolean('push_muted').notNull().default(false),
  },
  (table) => [
    check(
      'users_valid_theme_preference',
      sql`${table.themePreference} IN ('light', 'dark', 'system')`,
    ),
  ],
);

// ---------------------------------------------------------------
// Sessions (data-model.md §5.4)
// ---------------------------------------------------------------
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 64 }).notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_sessions_expires_at').on(table.expiresAt),
    index('idx_sessions_user_id').on(table.userId),
  ],
);

// ---------------------------------------------------------------
// Customers (data-model.md §5.6)
// ---------------------------------------------------------------
export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 100 }),
  email: varchar('email', { length: 255 }),
  address: jsonb('address').$type<{
    street: string;
    zip: string;
    city: string;
  } | null>(),
  // USt-IdNr. — data-model.md §5.6, AC-306 / AC-289. Structurally
  // optional; the requiredness gate fires at invoice issuance when
  // the draft's taxMode = 'reverse_charge'. Pre-fills the recipient
  // ustId on new invoice drafts when set. ADR-0026.
  ustId: text('ust_id'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

// ---------------------------------------------------------------
// Projects (data-model.md §5.1)
// ---------------------------------------------------------------
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: varchar('number', { length: 20 }).notNull().unique(),
    title: varchar('title', { length: 500 }).notNull(),
    status: varchar('status', { length: 50 }).notNull().default('anfrage'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    // Baustellen-/Leistungsadresse — where the work physically happens.
    // Distinct from `customers.address` (Rechnungsadresse). Null means
    // "the site is at the customer's billing address" (data-model.md
    // §5.1) — UI fallback only, no semantic difference at the data layer.
    // Same JSONB shape as `customers.address`.
    siteAddress: jsonb('site_address').$type<{
      street: string;
      zip: string;
      city: string;
    } | null>(),

    plannedStart: date('planned_start', { mode: 'date' }),
    plannedEnd: date('planned_end', { mode: 'date' }),

    estimatedValue: numeric('estimated_value', { precision: 12, scale: 2 }),
    notes: text('notes'),
    deleted: boolean('deleted').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_projects_status').on(table.status),
    index('idx_projects_status_changed_at').on(table.statusChangedAt),
    index('idx_projects_customer_id').on(table.customerId),
    check(
      'projects_end_requires_start',
      sql`${table.plannedEnd} IS NULL OR ${table.plannedStart} IS NOT NULL`,
    ),
    check(
      'projects_end_not_before_start',
      sql`${table.plannedEnd} IS NULL OR ${table.plannedStart} IS NULL OR ${table.plannedEnd} >= ${table.plannedStart}`,
    ),
    check(
      'projects_valid_status',
      sql`${table.status} IN ('anfrage', 'angebot', 'beauftragt', 'geplant', 'in_arbeit', 'abnahme', 'rechnung_faellig', 'abgerechnet', 'erledigt')`,
    ),
  ],
);

// ---------------------------------------------------------------
// Project–Worker assignments (m:n join table)
// ---------------------------------------------------------------
export const projectWorkers = pgTable(
  'project_workers',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index('idx_project_workers_user_id').on(table.userId),
  ],
);

// ---------------------------------------------------------------
// Backup status (data-model.md §5.9, ADR-0020)
//
// Single-row table. The `singleton` primary key is a fixed sentinel
// enforced by a CHECK so the app never has to distinguish "first
// write" from "nth write" — it always upserts the same row. A row
// is pre-seeded by the migration so repositories can rely on its
// existence (upsert on the sentinel PK).
// ---------------------------------------------------------------
export const metaBackupStatus = pgTable(
  'meta_backup_status',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    lastBackupAt: timestamp('last_backup_at', { withTimezone: true }),
    lastBackupOk: boolean('last_backup_ok').notNull().default(false),
    lastDrillAt: timestamp('last_drill_at', { withTimezone: true }),
    // `lastDrillOk: boolean | null` per data-model.md §5.9 —
    // null is the authoritative "never-run" signal, distinct from "skipped".
    lastDrillOk: boolean('last_drill_ok'),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('meta_backup_status_singleton', sql`${table.singleton} = true`)],
);

// ---------------------------------------------------------------
// Data-exchange job (ADR-0018 § Two surfaces, ADR-0024 § Full-account
// takeout).
//
// Tracks one full-account "Vollständiger Export/Import" job: the rare,
// operator-initiated server-side dump/restore of all business data +
// every attachment. The interactive hot path (gallery, upload,
// per-project bulk download) does NOT use this table. Progress counters
// drive the live readout; `data_exchange_job_changed` SSE fires on
// transitions so the UI refetches the row. Not routed through `mutate()`
// — lifecycle progress is high-frequency and not a business-entity audit
// event; the start/terminal audit row (entity_type `data_import`) is
// written by the job endpoints, not here.
//
//   kind:   export | import
//   status: pending → running → (ready | failed)
//
// `archive_ref` is the staged plaintext archive's location on the VPS
// (export output / import upload) — never a B2 key (ADR-0024: plaintext
// stages only inside the trust radius). Bytes are bigint: a multi-GB
// archive overflows int4.
// ---------------------------------------------------------------
export const dataExchangeJob = pgTable(
  'data_exchange_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    filesTotal: bigint('files_total', { mode: 'number' }).notNull().default(0),
    filesDone: bigint('files_done', { mode: 'number' }).notNull().default(0),
    bytesTotal: bigint('bytes_total', { mode: 'number' }).notNull().default(0),
    bytesDone: bigint('bytes_done', { mode: 'number' }).notNull().default(0),
    // Human-readable current activity (e.g. the file being processed),
    // surfaced verbatim in the progress dialog. Nullable: unset before
    // the first item.
    currentItem: text('current_item'),
    // Staged archive location on the VPS (filesystem path or local
    // staging key). Nullable until the export build finishes / the
    // import upload lands.
    archiveRef: text('archive_ref'),
    // Failure detail for the summary view. Nullable; set only on `failed`.
    errorDetail: text('error_detail'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    check('data_exchange_job_kind_valid', sql`${table.kind} IN ('export', 'import')`),
    check(
      'data_exchange_job_status_valid',
      sql`${table.status} IN ('pending', 'running', 'ready', 'failed')`,
    ),
    check(
      'data_exchange_job_counts_non_negative',
      sql`${table.filesTotal} >= 0 AND ${table.filesDone} >= 0 AND ${table.bytesTotal} >= 0 AND ${table.bytesDone} >= 0`,
    ),
    index('idx_data_exchange_job_status').on(table.status),
    index('idx_data_exchange_job_created_at').on(table.createdAt),
  ],
);

// ---------------------------------------------------------------
// Audit log (data-model.md §5.10, ADR-0021)
//
// Append-only record of every domain-entity state change. Written
// atomically with the state change by the service-layer `mutate()`
// helper. The compound CHECK constraint pins the actor_kind /
// actor_id / actor_reason invariant:
//
//   - actor_kind='user'   → actor_id NOT NULL, actor_reason NULL
//   - actor_kind='system' → actor_id NULL,     actor_reason non-empty
//
// The non-empty `actor_reason` is the defense-in-depth backstop for
// AC-178: without it a bootstrap entry would be invisible in the
// activity feed.
// ---------------------------------------------------------------
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // ON DELETE SET NULL mirrors AC-98 for createdBy/updatedBy: hard-deleting
    // a user must not cascade their audit trail away. entity_id deliberately
    // has no FK — a `purge` removes the target row while the audit entry
    // remains (data-model.md §5.10 "Referential integrity").
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorKind: text('actor_kind').notNull(),
    actorReason: text('actor_reason'),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    // Human-readable label for the entity at the time of the event
    // (e.g. "Firma Weber GmbH", "Innenraumgestaltung Weber"). Captured
    // at write time so the activity feed remains readable even after
    // the target row is renamed or purged. Nullable for paths that
    // cannot supply a label (import, retention cleanup); the client
    // falls back to the UUID.
    entityLabel: text('entity_label'),
    // Ancestor denormalization (architecture.md §11.12). Per-parent
    // activity feeds (project detail) need rows for the project itself
    // AND for its nested entities (`project_worker`, `attachment`).
    // Write-time convention:
    //   - `project` rows self-ancestor: ancestor = (project, entityId).
    //   - Nested entities (`project_worker`, `attachment`) set
    //     ancestor = (project, projectId).
    //   - Top-level entities (`customer`, `user`) leave ancestor NULL.
    // Reads use a single indexed predicate (`audit_log_ancestor_idx`)
    // instead of a JSONB path match or a bespoke `projectScope` carve-out.
    ancestorEntityType: text('ancestor_entity_type'),
    ancestorEntityId: uuid('ancestor_entity_id'),
    action: text('action').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    correlationId: text('correlation_id'),
  },
  (table) => [
    index('audit_log_entity_idx').on(table.entityType, table.entityId, table.createdAt.desc()),
    index('audit_log_actor_idx').on(table.actorId, table.createdAt.desc()),
    index('audit_log_created_at_idx').on(table.createdAt.desc()),
    // Compound index for the per-parent activity-feed query shape
    // (`ancestorEntityType + ancestorEntityId + createdAt DESC`, with
    // `id DESC` mirroring the ORDER BY tiebreaker in `listAuditEntries`
    // so the page is served entirely from the index — no sort step).
    index('audit_log_ancestor_idx').on(
      table.ancestorEntityType,
      table.ancestorEntityId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    // GIN trigram index powers the Aktivität view's substring search on
    // entity_label (ui/management.md §8.13.2). Without it, `ILIKE '%q%'`
    // falls back to a seq scan. The pg_trgm extension itself is enabled
    // by a hand-edit in 0000_baseline.sql — drizzle-kit does not emit
    // CREATE EXTENSION statements.
    index('audit_log_entity_label_trgm_idx').using('gin', sql`${table.entityLabel} gin_trgm_ops`),
    check('audit_log_actor_kind_valid', sql`${table.actorKind} IN ('user', 'system')`),
    check(
      'audit_log_entity_type_valid',
      sql`${table.entityType} IN ('project', 'customer', 'user', 'project_worker', 'attachment', 'invoice', 'company_profile', 'data_import')`,
    ),
    // Ancestor type must be one of the same closed set, OR NULL (top-
    // level entities). Kept in lock-step with `audit_log_entity_type_valid`
    // — a new entity type added to `AUDIT_ENTITY_TYPES` lands here too.
    // `data_import` is a top-level deployment event and never appears as
    // an ancestor in practice; including it here is for consistency so
    // the two CHECKs do not drift symbolically.
    check(
      'audit_log_ancestor_type_valid',
      sql`${table.ancestorEntityType} IS NULL
          OR ${table.ancestorEntityType} IN ('project', 'customer', 'user', 'project_worker', 'attachment', 'invoice', 'company_profile', 'data_import')`,
    ),
    // Both ancestor columns must be NULL or both non-NULL — a partial
    // ancestor is meaningless and would break the compound-index lookup.
    check(
      'audit_log_ancestor_pair',
      sql`(${table.ancestorEntityType} IS NULL AND ${table.ancestorEntityId} IS NULL)
          OR (${table.ancestorEntityType} IS NOT NULL AND ${table.ancestorEntityId} IS NOT NULL)`,
    ),
    // Compound invariant — AC-178 defense in depth. Missing this CHECK
    // would let a bootstrap write land with actor_reason=NULL, making
    // the first-admin creation invisible to the activity feed.
    //
    // actor_id is deliberately NOT required for user-kind rows: when
    // the authoring user is hard-deleted, the FK's ON DELETE SET NULL
    // clause nullifies this column — per data-model.md §5.10
    // "Referential integrity" (parity with AC-98). Write-time
    // validation lives in the service layer (`validateContext()` in
    // mutate.ts); the CHECK here pins only the invariants that must
    // hold regardless of cascades.
    check(
      'audit_log_actor_shape',
      sql`(
        (${table.actorKind} = 'user'
          AND ${table.actorReason} IS NULL)
        OR
        (${table.actorKind} = 'system'
          AND ${table.actorId} IS NULL
          AND ${table.actorReason} IS NOT NULL
          AND length(trim(${table.actorReason})) > 0)
      )`,
    ),
  ],
);

// ---------------------------------------------------------------
// Notification rule (data-model.md §5.11, ADR-0023)
//
// Admin-editable rules mapping the closed event catalog to recipient
// specs. CRUD does NOT route through `mutate()` — rule changes are
// administrative config, not audited domain events (ADR-0023).
// ---------------------------------------------------------------
export const notificationRule = pgTable('notification_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Event class — closed enum (data-model.md §5.11 NotificationEventClass).
  // Application-level validation restricts the value set; left as text at
  // the DB level so seed migrations do not need a CHECK update per rule.
  eventClass: text('event_class').notNull(),
  // Transition-only filter — matches when `after.status` equals the value;
  // null means no state filter. Application validation rejects non-null
  // values on non-transition classes.
  stateFilter: text('state_filter'),
  // Additive recipient spec: `{ roles, includeAssignedWorkers, userIds }`.
  // Shape pinned by data-model.md §5.11 NotificationRecipientSpec.
  recipientSpec: jsonb('recipient_spec').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

// ---------------------------------------------------------------
// Push subscriptions (data-model.md §5.12, ADR-0023)
//
// Per-device push subscription. A user may hold multiple rows (phone,
// desktop). Unique on (user_id, endpoint) so re-subscribe upserts.
// Hard-delete of the user cascades; deactivation retains rows (mute is
// a delivery-time filter).
// ---------------------------------------------------------------
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('push_subscriptions_user_endpoint_uq').on(table.userId, table.endpoint),
    index('push_subscriptions_user_id_idx').on(table.userId),
  ],
);

// ---------------------------------------------------------------
// Attachments (data-model.md §5.13)
// ---------------------------------------------------------------
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    originalKey: text('original_key').notNull(),
    thumbKey: text('thumb_key'),
    /**
     * Declared sizeBytes of the thumbnail blob, persisted at init-time.
     * The presigned PUT pins this exact value into the SigV4 signature,
     * but the persisted copy lets `completeUpload` re-assert size at
     * HEAD-verify time — defence in depth against a signature bypass.
     * Mirrors the original side's `sizeBytes` re-assertion.
     *
     * Null for binaries (no thumb) and for legacy pending rows that
     * predate this column. Both make the value structurally absent
     * rather than meaningless.
     */
    thumbSizeBytes: bigint('thumb_size_bytes', { mode: 'number' }),
    hasThumbnail: boolean('has_thumbnail').notNull().default(false),
    /**
     * Ciphertext size of the original blob — the byte count the server
     * signs into the presigned PUT (Content-Length) and re-asserts at
     * complete-time via HEAD. Distinct from `sizeBytes` (plaintext) which
     * backs the per-file cap and rides the export envelope (ADR-0024 /
     * data-model.md §5.13).
     *
     * Nullable here so legacy pre-e2e tests that raw-INSERT attachment
     * rows without ciphertext metadata still typecheck under Phase 1A;
     * Phase 2D wires the init flow to populate this column unconditionally
     * and the production AC-245 path requires a non-null value at write
     * time. Tightening to NOT NULL is tracked debt for Phase 2D.
     */
    ciphertextSizeBytes: bigint('ciphertext_size_bytes', { mode: 'number' }),
    /**
     * Ciphertext size of the thumbnail blob; null for non-photo kinds
     * and for photos without a thumbnail (per data-model.md §5.13).
     * Set at init-time alongside `wrappedThumbDek`.
     */
    ciphertextThumbSizeBytes: bigint('ciphertext_thumb_size_bytes', { mode: 'number' }),
    /**
     * S3 VersionId of the current original-key version, captured at
     * complete-time from the bucket's HEAD response. Persisted so the
     * Papierkorb restore flow can `copyFromVersion(originalKey, versionId)`
     * after a hide. Null while status='pending' (no upload yet).
     * ADR-0022.
     */
    versionId: text('version_id'),
    /**
     * S3 VersionId of the current thumb-key version. Set in tandem with
     * `versionId` for photos where `hasThumbnail=true`; null for binaries
     * (no thumb) and for pending rows. Restore replays both copies so the
     * gallery preview returns intact.
     */
    thumbVersionId: text('thumb_version_id'),
    /**
     * Base64 of the operator-`age`-wrapped envelope of the per-blob
     * 32-byte AES-256-GCM DEK for the original ciphertext object
     * (ADR-0024 / data-model.md §5.13). The unwrapped DEK is never
     * persisted; this column is the entire crypto perimeter on B2 — a
     * DB dump alone (without the operator-loaded binary `age` identity)
     * cannot recover the bytes.
     *
     * Audit-excluded at the schema layer (see `AUDIT_EXCLUDED_FIELDS`
     * below). The audit-payload builder strips both the camelCase JS
     * key and the snake_case DB column name from every payload it
     * writes — declarative on the column rather than enforced per call
     * site, so a future column rename or new audited mutation cannot
     * leak the envelope.
     *
     * Nullable for the same Phase 1A reason as `ciphertextSizeBytes`
     * above; tightening to NOT NULL is tracked debt for Phase 2D when
     * the route layer wraps the client-supplied DEK material at init.
     */
    wrappedDek: text('wrapped_dek'),
    /**
     * Base64 of the `age`-wrapped envelope of the per-blob DEK for the
     * thumbnail; null for non-photo kinds and for photos without a
     * thumbnail. Same audit-exclusion contract as `wrappedDek`.
     */
    wrappedThumbDek: text('wrapped_thumb_dek'),
    /**
     * Monotonic envelope-format discriminator (ADR-0024). Shared between
     * `wrappedDek` and `wrappedThumbDek` on a row — both envelopes are
     * written at the same init and so share the same wrapping format.
     * Current value is `1` (age X25519 KEM + ChaCha20-Poly1305).
     *
     * No DB DEFAULT and NOT NULL: every insert site sets the value
     * explicitly so a future v2 introduction is a code change at the
     * relevant init paths, not a silent column default flip. The unwrap
     * path validates `version === 1` and throws on any other value
     * (`envelope format unknown: <N>`); the export envelope carries the
     * field so post-import rows preserve the discriminator and the
     * import path refuses unknown versions before insertion.
     *
     * `smallint` over `integer` because the universe of envelope
     * formats is tiny by design (a handful of generations across the
     * project's lifetime); the 2-byte column matches that ceiling
     * without any pretense of precision.
     */
    wrappedDekVersion: smallint('wrapped_dek_version').notNull(),
    /**
     * Set when the attachment is moved to the Papierkorb (status =
     * 'hidden'). Null while live or pending. The scheduled hidden reaper
     * (data-model.md §6.12) hard-deletes the row once `now() - hiddenAt
     * > L`; the bucket lifecycle reaps the underlying noncurrent versions
     * on the same window. Both are keyed off `L` so the row never
     * outlives recoverability.
     */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('attachments_project_id_idx').on(table.projectId),
    index('attachments_created_by_idx').on(table.createdBy),
    uniqueIndex('attachments_original_key_uq').on(table.originalKey),
    check('attachments_valid_status', sql`${table.status} IN ('pending', 'ready', 'hidden')`),
    check('attachments_valid_kind', sql`${table.kind} IN ('photo', 'binary')`),
    check(
      'attachments_valid_label',
      sql`${table.label} IN ('angebot', 'auftragsbestaetigung', 'rechnung', 'aufmass', 'foto', 'sonstiges')`,
    ),
    check(
      'attachments_valid_mime_type',
      sql`${table.mimeType} IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')`,
    ),
    // ADR-0024: a `ready` row MUST carry a wrapped DEK envelope and a
    // ciphertext byte count — the column pair that lets the SW unwrap
    // and decrypt the bytes on B2. Pending rows can have nulls (the row
    // exists before init wraps the DEK in legacy raw-INSERT seed paths;
    // production init always populates both columns); hidden rows
    // inherit the values they had at `ready` time. NOT NULL is too tight
    // (it breaks pending-state seeds in tests); the CHECK is the right
    // shape — the column pair is mandatory exactly when the row is
    // user-visible. Mirrors the `projects_end_requires_start` shape.
    check(
      'attachments_wrapped_dek_required_when_ready',
      sql`${table.status} != 'ready' OR (${table.wrappedDek} IS NOT NULL AND ${table.ciphertextSizeBytes} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------
// Project storage usage — derived state, trigger-maintained
// (data-model.md §5.14, ARCHITECTURE.md "Storage usage —
// trigger-maintained side table")
// ---------------------------------------------------------------
/**
 * Per-project four-bucket aggregate of attachment byte counts. Maintained
 * by two PL/pgSQL triggers in the baseline migration tail (the canonical
 * Postgres pattern for maintained aggregates over an authoritative
 * source-of-truth table):
 *
 *   - `projects_storage_usage_init` (AFTER INSERT ON projects) seeds a
 *     zero row for every new project, so the delta trigger only ever
 *     issues UPDATEs.
 *   - `attachments_storage_usage_delta` (AFTER INSERT/UPDATE/DELETE ON
 *     attachments) computes the four-counter delta from OLD/NEW and
 *     applies it via one UPDATE keyed on `project_id`.
 *
 * Side table over columns-on-`projects` because (1) `projects` is
 * audited and trigger-maintained derived state on an audited table
 * muddies the audit invariant boundary, and (2) cleaner separation of
 * concerns. The FK cascade hard-deletes the row alongside the parent
 * project on purge ([AC-266](docs/spec/verification.md#1526-attachments)).
 *
 * Plaintext counters sum `size_bytes + COALESCE(thumb_size_bytes, 0)` —
 * the user-facing "what I uploaded" view. Ciphertext counters sum the
 * `ciphertext_*` analogues — the operator-facing "what is on object
 * storage" view. Both axes track each row's contribution to the matching
 * status bucket (`ready` or `hidden`); `pending` rows contribute to
 * neither.
 */
export const projectStorageUsage = pgTable(
  'project_storage_usage',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    spaceReadyBytes: bigint('space_ready_bytes', { mode: 'number' }).notNull().default(0),
    spaceHiddenBytes: bigint('space_hidden_bytes', { mode: 'number' }).notNull().default(0),
    ciphertextReadyBytes: bigint('ciphertext_ready_bytes', { mode: 'number' }).notNull().default(0),
    ciphertextHiddenBytes: bigint('ciphertext_hidden_bytes', { mode: 'number' })
      .notNull()
      .default(0),
  },
  (table) => [
    // Tripwire — counters can only grow from the trigger arithmetic
    // and a divergence (broken trigger replacement, hand-edited row,
    // status-flip without matching insert) must trip at write time
    // rather than drift silently. The reconcilability invariant
    // (verification.md AC-267) is the integration-test backstop;
    // this CHECK is the row-level one.
    check(
      'project_storage_usage_non_negative',
      sql`${table.spaceReadyBytes} >= 0 AND ${table.spaceHiddenBytes} >= 0 AND ${table.ciphertextReadyBytes} >= 0 AND ${table.ciphertextHiddenBytes} >= 0`,
    ),
  ],
);

// ---------------------------------------------------------------
// Company profile (data-model.md §5.17, ADR-0026)
//
// Singleton table — exactly one row carrying the issuing company's
// identity. Distinct from meta_backup_status (§5.9) in one respect:
// `company_profile` IS audited (AUDIT_ENTITY_TYPES above, AC-302) and
// `audit_log.entity_id` is `uuid NOT NULL`, so the row needs a real
// UUID identity in addition to the singleton-enforcement plumbing. The
// shape is:
//   - `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` carries the audit
//     identity — every `audit_log` row written by a PUT carries this id.
//   - `singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton
//     = true)` enforces the singleton invariant: every row MUST have
//     `singleton = true`, and UNIQUE on `singleton` means only one row
//     can carry the value — so the table holds at most one row.
//   - A BEFORE DELETE trigger in the baseline migration tail rejects
//     removals (AC-300) so the singleton can never go below one.
// The row is pre-seeded by the baseline migration with empty mandatory
// fields so write paths are always upserts.
//
// Owner-only mutation surface, but every authenticated role may read
// (route-layer role check — no dedicated company_profile:* permission
// keys). At invoice issuance the row's contents are snapshotted onto
// the invoice row and never re-derived.
// ---------------------------------------------------------------
export const companyProfile = pgTable(
  'company_profile',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Singleton-enforcement discriminator. NOT a PK — `id` is the PK so
    // audit_log.entity_id has a UUID target. UNIQUE on the boolean +
    // CHECK (singleton = true) means only one row may exist.
    singleton: boolean('singleton').notNull().default(true).unique(),
    companyName: text('company_name').notNull().default(''),
    // {street, zip, city} — all three required at issuance for §14 UStG;
    // structurally optional at the column level so the baseline seed
    // can insert an empty row.
    address: jsonb('address')
      .$type<{ street: string; zip: string; city: string }>()
      .notNull()
      .default(sql`'{"street":"","zip":"","city":""}'::jsonb`),
    taxId: text('tax_id').notNull().default(''),
    ustId: text('ust_id'),
    iban: text('iban'),
    accentColor: text('accent_color'),
    footerText: text('footer_text'),
    logoBinaryDescriptorId: uuid('logo_binary_descriptor_id'),
    defaultTaxMode: text('default_tax_mode').notNull().default('standard'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    check('company_profile_singleton', sql`${table.singleton} = true`),
    check(
      'company_profile_default_tax_mode_valid',
      sql`${table.defaultTaxMode} IN ('standard', 'kleinunternehmer', 'reverse_charge')`,
    ),
  ],
);

// ---------------------------------------------------------------
// Invoice sequence (data-model.md §5.16, ADR-0026 §Data model)
//
// Gapless year-scoped counter feeding `invoices.number` allocation at
// issuance time. One row per (year, kind); allocation is a single
// atomic `INSERT … ON CONFLICT (year, kind) DO UPDATE
// SET next_value = next_value + 1 RETURNING next_value` inside the
// issuance transaction — Postgres takes a row-exclusive lock
// equivalent to `SELECT FOR UPDATE`. The single statement collapses
// the first-of-year case (INSERT) and the steady-state case
// (DO UPDATE) into one race-free path. The lock is held until
// commit, so a rollback returns the value to the sequence — the
// canonical Postgres gapless-counter pattern (§6.13). SERIAL /
// IDENTITY is incompatible by design: they advance on rollback.
//
// `nextValue` is bigint so a deployment cannot mathematically exhaust
// a year's namespace; the four-digit-minimum number format widens
// past 9999 without a schema migration.
// ---------------------------------------------------------------
export const invoiceSequence = pgTable(
  'invoice_sequence',
  {
    year: smallint('year').notNull(),
    // 'invoice' for RE-YYYY-NNNN; 'storno' for ST-YYYY-NNNN. The two
    // sub-sequences are independent — a Storno does not consume an
    // invoice number and vice versa.
    kind: text('kind').notNull(),
    nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.year, table.kind] }),
    check('invoice_sequence_kind_valid', sql`${table.kind} IN ('invoice', 'storno')`),
  ],
);

// ---------------------------------------------------------------
// Invoices (data-model.md §5.15, ADR-0026)
//
// Immutable issued snapshots — every contributing value (issuer,
// recipient, lines, taxMode, profile) is copied onto the row at
// issuance and frozen thereafter. A correction is a fresh
// draft → issued cycle; cancellation creates a sibling Stornorechnung
// row with `cancellationOf` set, NEVER mutates the original beyond
// the `issued → cancelled` status flip.
//
// Issued rows are write-once at the persistence layer (AC-294,
// §6.14). The route layer rejects mutations on issued rows with
// INVOICE_FROZEN; the DB-level immutability backstop is a row-level
// trigger added in the baseline migration tail (parity with the
// project_storage_usage triggers — drizzle-kit does not emit
// triggers, hand-edited at regen time).
//
// `number` CHECK pins the canonical RE-YYYY-NNNN / ST-YYYY-NNNN
// shape; null is allowed for drafts. A partial unique index over
// non-null numbers enforces uniqueness on issued+cancelled rows.
// ---------------------------------------------------------------
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('draft'),
    // Null while status = 'draft'; pinned to RE-YYYY-NNNN or
    // ST-YYYY-NNNN by the regex CHECK below once issued.
    number: text('number'),
    // Rechnungsdatum per §14 UStG — set at issuance, frozen thereafter.
    // Date (not timestamp): §14 UStG anchors the invoice date as a
    // calendar date, not a moment. Matches data-model.md §5.15 line
    // 546 (`issueDate?: string; // ISO 8601 date`).
    issueDate: date('issue_date', { mode: 'date' }),
    // Leistungsdatum per §14 UStG — editable in draft, required at
    // issuance, frozen thereafter. Date (not timestamp) — a calendar
    // date is the right granularity for §14 UStG.
    performanceDate: date('performance_date', { mode: 'date' }),
    taxMode: text('tax_mode').notNull().default('standard'),
    // ZUGFeRD profile snapshot — v1 always 'zugferd-en16931'; future
    // 'xrechnung' lands without schema migration.
    profile: text('profile').notNull().default('zugferd-en16931'),
    // Snapshotted blocks — JSONB, frozen at issuance.
    issuer: jsonb('issuer')
      .notNull()
      .default(sql`'{}'::jsonb`),
    recipient: jsonb('recipient')
      .notNull()
      .default(sql`'{}'::jsonb`),
    lines: jsonb('lines')
      .notNull()
      .default(sql`'[]'::jsonb`),
    totals: jsonb('totals')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Self-FK — non-null only on Storno rows. Cascade-restrict on the
    // original is enforced at the API layer (delete rejected when a
    // Storno row references it; mirrors the FK semantic without
    // forcing the cascade rule to live in DDL).
    cancellationOf: uuid('cancellation_of').references(
      (): import('drizzle-orm/pg-core').AnyPgColumn => invoices.id,
      {
        onDelete: 'restrict',
      },
    ),
    cancellationReason: text('cancellation_reason'),
    // FK to the rendered ZUGFeRD PDF/A-3 binary descriptor. No FK
    // constraint at the DB layer — binary_descriptors is the
    // attachments table here (an attachment row carries the descriptor
    // shape); the renderer writes a free-standing row referenced by
    // this column without a foreign-key tie so a future binary-only
    // descriptor table extraction does not need a schema migration.
    // The application enforces existence at issuance.
    renderedPdfBinaryDescriptorId: uuid('rendered_pdf_binary_descriptor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('invoices_project_id_idx').on(table.projectId),
    index('invoices_status_idx').on(table.status),
    index('invoices_cancellation_of_idx').on(table.cancellationOf),
    // Partial unique index — invoice numbers are unique across the
    // non-draft set. Drafts have null number; many drafts may coexist
    // per project.
    uniqueIndex('invoices_number_uq')
      .on(table.number)
      .where(sql`${table.number} IS NOT NULL`),
    check('invoices_status_valid', sql`${table.status} IN ('draft', 'issued', 'cancelled')`),
    check(
      'invoices_tax_mode_valid',
      sql`${table.taxMode} IN ('standard', 'kleinunternehmer', 'reverse_charge')`,
    ),
    check('invoices_profile_valid', sql`${table.profile} IN ('zugferd-en16931')`),
    // Defense-in-depth backstop on direct DB writes (seed scripts,
    // migrations, manual SQL). The route layer formats from
    // invoice_sequence so this CHECK is unreachable in steady state;
    // the regex is the structural anchor (AC-295).
    check(
      'invoices_number_format',
      sql`${table.number} IS NULL
          OR ${table.number} ~ '^(RE|ST)-[0-9]{4}-[0-9]{4,}$'`,
    ),
    // A draft has no number; an issued or cancelled row MUST have one.
    check(
      'invoices_number_required_when_not_draft',
      sql`(${table.status} = 'draft' AND ${table.number} IS NULL)
          OR (${table.status} IN ('issued', 'cancelled') AND ${table.number} IS NOT NULL)`,
    ),
    // Storno rows MUST carry an ST- prefix; non-Storno rows MUST NOT.
    // `cancellationOf IS NOT NULL` ↔ `number LIKE 'ST-%'`. Drafts can
    // never be Storno rows (cancellation creates a sibling on an
    // issued original, never on a draft).
    check(
      'invoices_cancellation_pair',
      sql`(${table.cancellationOf} IS NULL AND (${table.number} IS NULL OR ${table.number} LIKE 'RE-%'))
          OR (${table.cancellationOf} IS NOT NULL AND ${table.number} LIKE 'ST-%')`,
    ),
  ],
);

// ---------------------------------------------------------------
// Schema-level audit-payload exclusion (ADR-0024 § Audit-log boundary,
// data-model.md §5.13 "Audit exclusion", architecture.md §
// "Schema-level audit exclusion")
// ---------------------------------------------------------------
/**
 * The set of column / property names the audit-payload builder strips
 * from every `before` / `after` snapshot it writes to `audit_log.payload`.
 *
 * Both the camelCase JS property (the form services use when building
 * payloads from row objects or input shapes) AND the snake_case DB
 * column name (the form raw-row mirrors carry) are listed — the
 * stripping pass runs once per payload, key-by-key, and short-circuits
 * on either form. A regression that serialised the row directly via
 * `JSON.stringify(row)` would surface the snake_case form; a regression
 * that built `after: { wrappedDek }` from the input would surface the
 * camelCase form. Pin both shapes here so neither path leaks.
 *
 * The marker is co-located with the column definitions above (a member
 * of this set has its column declared in the immediately-preceding
 * table block) so a future reviewer cannot rename a column without
 * updating the registry — they edit the same file. The architecture
 * spec (`docs/spec/architecture.md` § "Schema-level audit exclusion")
 * permits this shape: the contract pins the property (a flagged column
 * is unconditionally absent from every audit payload) and the
 * enforcement shape (an AC-pinned test asserts the absence across the
 * full mutation surface — `attachments-audit.test.ts` AC-240). The
 * mechanism — column allowlist consulted by the builder — is
 * implementation-defined.
 *
 * Members today (ADR-0024):
 *   - `wrappedDek` / `wrapped_dek` — the wrapped envelope of the
 *     per-blob DEK on the original ciphertext.
 *   - `wrappedThumbDek` / `wrapped_thumb_dek` — same for the thumbnail.
 *
 * The unwrapped DEK is never persisted, so it never reaches a payload
 * to begin with — only the wrapped envelopes need exclusion.
 */
export const AUDIT_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  'wrappedDek',
  'wrapped_dek',
  'wrappedThumbDek',
  'wrapped_thumb_dek',
]);
