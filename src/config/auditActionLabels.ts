/**
 * German labels for audit-log actions.
 *
 * Mapping from the API's action vocabulary (api.md §14.2.8, data-model.md
 * §5.10) to a user-facing German label rendered in both the project-
 * detail activity feed (ui/workflow-views.md §8.4.1) and the global
 * Aktivität view (ui/management.md §8.13).
 *
 * [C] customer-configurable per architecture.md §12.2. Mirrors the
 * pattern in `stateConfig.ts` / `backupThresholds.ts`: the config layer
 * owns the mapping, the UI layer reads it through a small resolver.
 *
 * New action vocabulary values must be added here — `labelForAuditAction`
 * falls back to the raw action string if a label is missing, so a new
 * server-side action does not break rendering, but the fallback is a
 * visible reminder that a translation row is owed.
 */

/**
 * The server-side action vocabulary — the single source of truth for
 * the audit action set (data-model.md §5.10). Imported by server code
 * (`AuditService`, `mutate()`, route schemas) AND the UI resolver below.
 *
 * Layering: the config layer is importable from both server and UI code
 * (architecture.md §11.2). Keeping the vocabulary here avoids the
 * server↔UI duplication that an earlier draft had — a new action adds
 * one line here and propagates to the filter schema, the type union,
 * and the UI label via the same import.
 */
export const AUDIT_ACTION_KEYS = [
  'create',
  'update',
  'delete',
  'archive',
  'restore',
  'transition:forward',
  'transition:backward',
  'purge',
  'reactivate',
  'deactivate',
  'password-reset',
  'password-change',
  'attachment:add',
  'attachment:hide',
  'attachment:restore',
  'attachment:purge',
  // Invoice domain (ADR-0026, api.md §14.2.14).
  // - 'invoice:delete' on a draft hard-delete (ADR-0026 §Audit and realtime).
  // - 'invoice:issue'  on the issuance transaction; also on the Storno row's
  //   own issuance (a Storno is a fresh sibling that itself was issued).
  // - 'invoice:cancel' on the original row's flip to `cancelled`.
  // - Draft create / update reuse the generic 'create' / 'update' keys.
  'invoice:delete',
  'invoice:issue',
  'invoice:cancel',
  // Data-import event (issue #230). One row per `/api/import` commit,
  // entity_type='data_import' with a synthetic batch UUID for entity_id;
  // payload carries per-slot counts.
  'import_restored',
  // Full-account export-job terminal events (ADR-0018, api.md §14.2.4
  // "Jobs — audit"). One row per job at its terminal transition,
  // entity_type='data_import' (the synthetic deployment-level type) with
  // the job id as entity_id; payload carries the file/byte totals
  // (export_built) or the failure detail (export_failed).
  'export_built',
  'export_failed',
] as const;

export type AuditActionKey = (typeof AUDIT_ACTION_KEYS)[number];

/**
 * The domain-wide `AuditAction` type. Re-exported under the conventional
 * name so service-layer code (`MutateSpec.action`) can tighten its type
 * without reaching into the UI-flavored `AuditActionKey` alias.
 */
export type AuditAction = AuditActionKey;

/**
 * Primary action-to-label mapping. Rendered as the one-line description
 * of an audit row when no richer payload-aware derivation applies.
 *
 * Localized German, consistent with the project's "German UI, English
 * code" rule.
 */
export const AUDIT_ACTION_LABELS: Record<AuditActionKey, string> = {
  create: 'Erstellt',
  update: 'Aktualisiert',
  delete: 'Gelöscht',
  archive: 'Archiviert',
  restore: 'Wiederhergestellt',
  'transition:forward': 'Status weiter',
  'transition:backward': 'Status zurück',
  purge: 'Endgültig gelöscht',
  reactivate: 'Reaktiviert',
  deactivate: 'Deaktiviert',
  'password-reset': 'Passwort zurückgesetzt',
  'password-change': 'Passwort geändert',
  'attachment:add': 'Datei hinzugefügt',
  'attachment:hide': 'In Papierkorb verschoben',
  'attachment:restore': 'Aus Papierkorb wiederhergestellt',
  'attachment:purge': 'Aus Papierkorb endgültig gelöscht',
  'invoice:delete': 'Entwurf gelöscht',
  'invoice:issue': 'Rechnung ausgestellt',
  'invoice:cancel': 'Rechnung storniert',
  import_restored: 'Daten importiert',
  export_built: 'Export erstellt',
  export_failed: 'Export fehlgeschlagen',
};

/**
 * Resolve a raw action string to its German label. Falls back to the
 * raw value for unknown actions — see module docstring for the rationale.
 */
export function labelForAuditAction(action: string): string {
  if ((AUDIT_ACTION_KEYS as readonly string[]).includes(action)) {
    return AUDIT_ACTION_LABELS[action as AuditActionKey];
  }
  return action;
}
