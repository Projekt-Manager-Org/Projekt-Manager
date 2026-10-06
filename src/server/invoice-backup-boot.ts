/**
 * Boot-time invoice backup gate reconciliation — architecture.md §11.14
 * "Backup gate" (Mark), AC-374.
 *
 * With the Layer 2 backup feature disabled no backup will ever release
 * a mark, so standing marks (left from a time the feature was enabled,
 * or carried in by a restored dump) would withhold their PDFs forever.
 * Drop them. With the feature enabled, marks stand until a backup
 * releases them.
 */

import type { Database } from './db/connection.js';
import type { Env } from './config/env.js';
import { featureStatus } from './config/features.js';
import { dropAllInvoiceBackupMarks } from './repositories/invoiceBackupPending.js';

/** Returns how many marks were dropped. */
export async function applyInvoiceBackupGateAtBoot(db: Database, env: Env): Promise<number> {
  if (featureStatus(env, 'backup').enabled) return 0;
  return dropAllInvoiceBackupMarks(db);
}
