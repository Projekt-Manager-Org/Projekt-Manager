/**
 * Data-exchange job repository — the `data_exchange_job` queries
 * (data-model.md §5.18). `DataExchangeJobService` owns the state machine,
 * the terminal audit row and the post-write emits; the reapers decide which
 * jobs to end.
 */

import { and, desc, eq, inArray, isNotNull, lt, or, type SQL } from 'drizzle-orm';
import type { TransactionalDatabase } from '../db/connection.js';
import { dataExchangeJob } from '../db/schema.js';

export type DataExchangeJobKind = 'export' | 'import';
export type DataExchangeJobStatus = 'pending' | 'running' | 'ready' | 'failed';

export type DataExchangeJobRow = typeof dataExchangeJob.$inferSelect;
export type DataExchangeJobPatch = Partial<typeof dataExchangeJob.$inferInsert>;

/**
 * Conditions a job must meet, ANDed. `status` as an array means any of them.
 * Passed to an update, it makes the write a no-op for a job that no longer
 * matches.
 */
export interface DataExchangeJobFilter {
  kind?: DataExchangeJobKind;
  status?: DataExchangeJobStatus | readonly DataExchangeJobStatus[];
  updatedBefore?: Date;
}

function filterPredicate(filter: DataExchangeJobFilter): SQL[] {
  const { kind, status, updatedBefore } = filter;
  const conditions: SQL[] = [];
  if (kind !== undefined) conditions.push(eq(dataExchangeJob.kind, kind));
  if (typeof status === 'string') conditions.push(eq(dataExchangeJob.status, status));
  else if (status !== undefined) conditions.push(inArray(dataExchangeJob.status, [...status]));
  if (updatedBefore !== undefined) conditions.push(lt(dataExchangeJob.updatedAt, updatedBefore));
  return conditions;
}

export async function insertDataExchangeJob(
  db: TransactionalDatabase,
  values: { kind: DataExchangeJobKind; createdBy: string | null },
): Promise<DataExchangeJobRow | undefined> {
  const [row] = await db.insert(dataExchangeJob).values(values).returning();
  return row;
}

/**
 * Apply `patch` to job `id` if it matches `filter`; return the updated row,
 * or `undefined` when no row matched.
 */
export async function updateDataExchangeJob(
  db: TransactionalDatabase,
  id: string,
  patch: DataExchangeJobPatch,
  filter: DataExchangeJobFilter = {},
): Promise<DataExchangeJobRow | undefined> {
  const conditions = filterPredicate(filter);
  const [row] = await db
    .update(dataExchangeJob)
    .set(patch)
    .where(
      conditions.length > 0
        ? and(eq(dataExchangeJob.id, id), ...conditions)
        : eq(dataExchangeJob.id, id),
    )
    .returning();
  return row;
}

export async function findDataExchangeJob(
  db: TransactionalDatabase,
  id: string,
): Promise<DataExchangeJobRow | undefined> {
  const [row] = await db.select().from(dataExchangeJob).where(eq(dataExchangeJob.id, id)).limit(1);
  return row;
}

/** The most recently created job of `kind`, optionally only among `status`. */
export async function findLatestDataExchangeJob(
  db: TransactionalDatabase,
  kind: DataExchangeJobKind,
  status?: readonly DataExchangeJobStatus[],
): Promise<DataExchangeJobRow | undefined> {
  const [row] = await db
    .select()
    .from(dataExchangeJob)
    .where(
      status
        ? and(eq(dataExchangeJob.kind, kind), inArray(dataExchangeJob.status, [...status]))
        : eq(dataExchangeJob.kind, kind),
    )
    .orderBy(desc(dataExchangeJob.createdAt))
    .limit(1);
  return row;
}

/** The ids and kinds of the jobs matching `filter`. */
export async function findDataExchangeJobIds(
  db: TransactionalDatabase,
  filter: DataExchangeJobFilter,
): Promise<{ id: string; kind: string }[]> {
  return db
    .select({ id: dataExchangeJob.id, kind: dataExchangeJob.kind })
    .from(dataExchangeJob)
    .where(and(...filterPredicate(filter)));
}

/**
 * Terminal jobs of `kind` that still hold a staged archive, most recent
 * first. Terminal is `ready` for an export, `ready` or `failed` for an
 * import (an import stamps `archive_ref` when its upload completes).
 */
export async function findStagedDataExchangeJobsOfKind(
  db: TransactionalDatabase,
  kind: DataExchangeJobKind,
): Promise<{ id: string; archiveRef: string | null }[]> {
  const terminalCondition =
    kind === 'export'
      ? eq(dataExchangeJob.status, 'ready')
      : or(eq(dataExchangeJob.status, 'ready'), eq(dataExchangeJob.status, 'failed'))!;

  return db
    .select({ id: dataExchangeJob.id, archiveRef: dataExchangeJob.archiveRef })
    .from(dataExchangeJob)
    .where(
      and(eq(dataExchangeJob.kind, kind), terminalCondition, isNotNull(dataExchangeJob.archiveRef)),
    )
    .orderBy(desc(dataExchangeJob.createdAt));
}

/**
 * Terminal jobs of either kind that still hold a staged archive and
 * finished before `cutoff` (AC-589).
 */
export async function findStagedDataExchangeJobsFinishedBefore(
  db: TransactionalDatabase,
  cutoff: Date,
): Promise<{ id: string; archiveRef: string | null }[]> {
  return db
    .select({ id: dataExchangeJob.id, archiveRef: dataExchangeJob.archiveRef })
    .from(dataExchangeJob)
    .where(
      and(
        or(
          // export: only ever ready when it has an archive
          and(eq(dataExchangeJob.kind, 'export'), eq(dataExchangeJob.status, 'ready')),
          // import: both terminal states can carry an archiveRef
          and(
            eq(dataExchangeJob.kind, 'import'),
            inArray(dataExchangeJob.status, ['ready', 'failed']),
          ),
        ),
        isNotNull(dataExchangeJob.archiveRef),
        lt(dataExchangeJob.finishedAt, cutoff),
      ),
    );
}
