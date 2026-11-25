/**
 * Feature catalog and boot-time manifest emission — AC-230.
 *
 * Issue #139 traced silent feature outages to operator forgetfulness
 * (e.g. VAPID_SUBJECT missing on prod silently no-op'd push). The fix:
 * a single source of truth mapping `feature -> required env vars`, and a
 * structured info line at boot enumerating every feature's enabled-or-
 * not state with a human-readable reason. Operators see the actual state
 * of every feature flag the moment the container starts.
 *
 * The boot-time emission is the customer-facing surface; every gate
 * (push resolver, LLM extractor, bootstrap, backup runner) decides from
 * `featureStatus(env, feature)` so the manifest cannot diverge from
 * the wiring.
 */

import type { Env } from './env.js';

export type FeatureName = 'push' | 'llm' | 'admin-bootstrap' | 'backup';

export interface FeatureCatalogEntry {
  feature: FeatureName;
  /** Env-var names required for the feature to be enabled. Order is
   * significant — `featureStatus` reports the FIRST missing var, so an
   * operator sees one canonical name (not a shifting "first found
   * missing" depending on Object.keys iteration order). */
  requires: readonly (keyof Env)[];
}

/** The values the backup needs. Exported on its own because production
 * requires every one of them (AC-774, `checkBackupInProduction`). */
export const BACKUP_REQUIRES = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_BUCKET',
  'AGE_RECIPIENT',
] as const satisfies readonly (keyof Env)[];

/** Single source of truth: feature → required env vars. Adding a feature
 * is one entry here; every other surface (FEATURES, featureStatus,
 * emitFeatureManifest) derives from this list. */
export const FEATURE_CATALOG: readonly FeatureCatalogEntry[] = [
  { feature: 'push', requires: ['VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] },
  { feature: 'llm', requires: ['OPENROUTER_API_KEY'] },
  {
    feature: 'admin-bootstrap',
    requires: ['BOOTSTRAP_ADMIN_USERNAME', 'BOOTSTRAP_ADMIN_PASSWORD'],
  },
  { feature: 'backup', requires: BACKUP_REQUIRES },
];

/** Stable enumeration order — derived from FEATURE_CATALOG so the two
 * cannot drift. Used by `emitFeatureManifest` so the log line and
 * downstream consumers see a deterministic feature list. */
export const FEATURES: readonly FeatureName[] = FEATURE_CATALOG.map((e) => e.feature);

export type FeatureStatus = { enabled: true } | { enabled: false; reason: string };

/** Any record keyed by env var names — the typed `Env`, or a gate's own
 * subset of it (the bootstrap gate holds only its credential pair). */
export type FeatureSource = Readonly<Partial<Record<keyof Env, unknown>>>;

/**
 * A value counts as set when it is a string with non-whitespace content.
 * Compose forwards an unconfigured var as `""`; whitespace-only is an
 * operator slip, not a value. Every gate uses this one definition, so a
 * gate cannot run a feature the manifest reports disabled (AC-230).
 */
export function isConfigured(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Reports whether a feature is enabled for the given env — the decision
 * every feature gate takes (AC-230). A feature is enabled iff every env
 * var in its catalog entry's `requires` list is set (`isConfigured`). The
 * first missing var (per the catalog's declaration order) populates the
 * `reason` so the disabled state names one canonical fault.
 */
export function featureStatus(env: FeatureSource, feature: FeatureName): FeatureStatus {
  const entry = FEATURE_CATALOG.find((e) => e.feature === feature);
  if (!entry) {
    // Unreachable as long as the union and the catalog stay in sync —
    // the type system pins this. Surface a non-empty reason so a
    // regression that drops a catalog entry trips loud rather than
    // silent.
    return { enabled: false, reason: `Unknown feature "${feature}"` };
  }
  for (const varName of entry.requires) {
    if (!isConfigured(env[varName])) {
      return { enabled: false, reason: `${String(varName)} is not set` };
    }
  }
  return { enabled: true };
}

export interface ManifestLogger {
  info: (ctx: Record<string, unknown>, event?: string) => void;
}

/**
 * Per-feature record reported in the manifest log line.
 * `state` mirrors `featureStatus.enabled` (boolean → 'enabled' | 'disabled');
 * `reason` is undefined when enabled, a non-empty string when not.
 */
interface FeatureReport {
  state: 'enabled' | 'disabled';
  reason: string | undefined;
}

/**
 * Emits the boot-time feature manifest as a single structured info line
 * with `event: 'config-feature-manifest'` and a `features` map keyed by
 * every catalog feature. The map's per-feature `state` is derived from
 * `featureStatus(env, feature)` so the manifest cannot drift from the
 * wiring (AC-230).
 */
export function emitFeatureManifest(env: Env, logger: ManifestLogger): void {
  const features: Record<FeatureName, FeatureReport> = {} as Record<FeatureName, FeatureReport>;
  for (const f of FEATURES) {
    const status = featureStatus(env, f);
    features[f] = status.enabled
      ? { state: 'enabled', reason: undefined }
      : { state: 'disabled', reason: status.reason };
  }
  logger.info({ event: 'config-feature-manifest', features });
}

/**
 * Human-readable manifest for the deploy operator's terminal. Returns
 * the same per-feature data as `emitFeatureManifest` formatted as
 * aligned columns instead of single-line JSON.
 *
 * The boot-time emission stays JSON because production logs need to be
 * machine-grep-able; this format is for the one-shot pre-flight CLI
 * where the consumer is a human reading deploy output.
 */
export function formatFeatureManifest(env: Env): string {
  const nameWidth = Math.max(...FEATURES.map((f) => f.length));
  const lines = FEATURES.map((f) => {
    const status = featureStatus(env, f);
    const namePad = f.padEnd(nameWidth);
    return status.enabled ? `  ${namePad}  enabled` : `  ${namePad}  disabled — ${status.reason}`;
  });
  return ['Feature manifest (this deploy):', ...lines].join('\n');
}
