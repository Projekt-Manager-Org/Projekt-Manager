/**
 * Start-up seeding, driven by `SEED`. Production never seeds, whatever
 * `SEED` says (AC-764, ADR-0010): no wipe, and no demo users sharing
 * one known password. An unset
 * `NODE_ENV` parses as production, so the gate fails closed.
 */
import type { Env } from './config/env.js';

export interface StartupSeedDeps {
  seed: (opts: { force: boolean }) => Promise<void>;
  /** Removes the bucket objects a forced wipe left unreferenced. */
  pruneBucket: () => Promise<unknown>;
  warn: (message: string) => void;
}

export async function runStartupSeed(
  env: Pick<Env, 'NODE_ENV' | 'SEED'>,
  deps: StartupSeedDeps,
): Promise<void> {
  if (env.SEED === 'false') return;
  if (env.NODE_ENV === 'production') {
    deps.warn(
      'WARNING: SEED is set but NODE_ENV=production — skipping seed to protect production data.',
    );
    return;
  }
  // SEED=true → seed only if the database is empty; SEED=force → wipe and re-seed.
  const force = env.SEED === 'force';
  await deps.seed({ force });
  // The forced wipe truncates `attachments` (CASCADE from `projects`) but
  // not the bucket. Without the prune, orphan blobs grow each run and
  // scripts/sync-dev-to-vps.sh would mirror them, were its pollution guard
  // not to refuse. Prune so "force" means a full reset.
  if (force) await deps.pruneBucket();
}
