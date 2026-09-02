/**
 * Backup-freshness badge.
 *
 * Pure presentational component: consumes the already-derived
 * `BackupBadgeState` from `src/domain/backupBadge.ts`. The caller is
 * responsible for deriving the state (from `deriveBadgeState`) so this
 * component stays free of timing, thresholds, and data-shape knowledge
 * — it just maps a kind+reason to a visible label and a color cue.
 *
 * Shape: a fixed-size server-with-arrow icon that always occupies the
 * same pixel footprint in the header (previously alternated between a
 * bare dot in the healthy case and a full pill when degraded — the
 * size change read as a button that wasn't clickable and drew the eye
 * away from the affordance row on phones). Colour is the only signal
 * carrying state: green (healthy), amber (drill stale), red (action
 * required), muted (unknown).
 *
 * Spec pins ([verification.md §15.22](../../../docs/spec/verification.md#1522-backup-and-recovery)):
 *   - AC-170 — rendered on the owner's landing view only (not on the
 *     login screen, not on other roles' surfaces). Caller gates the
 *     render; this component renders unconditionally when asked.
 *   - AC-171 — never silently hidden; an `unknown` state still paints
 *     the icon in the muted colour and carries "Status unbekannt" in
 *     the tooltip / aria-label, so an unreachable status source is
 *     discoverable by hover and announced to assistive tech.
 *
 * Accessibility: the element is a `<button>` so it is keyboard-focusable
 * and tap-actionable on touch. The label is surfaced via `aria-label` +
 * the `title` tooltip (desktop hover) and — on tap/click — as a toast
 * that also works on mobile where `title` tooltips are practically
 * invisible. `aria-live="polite"` preserves the original state-change
 * announcement that the previous `role="status"` provided, without
 * clobbering the button's implicit role.
 *
 * Colours consume the semantic token chain (`--color-success`, etc.)
 * via the CSS module so a theme override in tokens.css flows through
 * without touching this file.
 */
import type { BackupBadgeState } from '@/domain/backupBadge';
import { STRINGS } from '@/config/strings';
import { formatBackupTimestampDE } from '@/domain/dateFormat';
import { useToastStore } from '@/state/toastStore';
import styles from './BackupBadge.module.css';

interface BackupBadgeProps {
  state: BackupBadgeState;
  /**
   * Surface context. The header consumer passes `inverse` so the icon
   * tint reads against the dark header frame. The default light variant
   * is kept for any future caller on a light surface.
   */
  variant?: 'default' | 'inverse';
}

/**
 * German label for a derived state. Centralized via `STRINGS.backup` so
 * the reason-string union from `deriveBadgeState` drives the visible
 * copy rather than a parallel table that could drift. Exhaustive over
 * the union — adding a new reason in the domain will surface here as a
 * compile error via the `never` branch.
 */
function labelForRedReason(reason: Extract<BackupBadgeState, { kind: 'red' }>['reason']): string {
  switch (reason) {
    case 'backup-stale':
      return STRINGS.backup.backupStale;
    case 'last-run-failed':
      return STRINGS.backup.lastRunFailed;
    case 'backup-never-run':
      return STRINGS.backup.backupNeverRun;
    case 'drill-never-run':
      return STRINGS.backup.drillNeverRun;
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unhandled backup-badge reason: ${String(_exhaustive)}`);
    }
  }
}

/**
 * German label for an amber reason. Mirrors `labelForRedReason` — the
 * two amber cases are distinct problems ('drill-stale' = the verifier
 * is late, 'backup-aging' = the backup itself is getting old) and read
 * as different sentences to the operator.
 */
function labelForAmberReason(
  reason: Extract<BackupBadgeState, { kind: 'amber' }>['reason'],
): string {
  switch (reason) {
    case 'drill-stale':
      return STRINGS.backup.drillStale;
    case 'backup-aging':
      return STRINGS.backup.backupAging;
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unhandled backup-badge amber reason: ${String(_exhaustive)}`);
    }
  }
}

function baseLabelFor(state: BackupBadgeState): string {
  switch (state.kind) {
    case 'unknown':
      return STRINGS.backup.unknown;
    case 'green':
      return STRINGS.backup.green;
    case 'amber':
      return labelForAmberReason(state.reason);
    case 'red':
      return labelForRedReason(state.reason);
    default: {
      const _exhaustive: never = state;
      throw new Error(`Unhandled backup-badge state: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Visible label = base status text + (timestamp of last run) when the
 * timestamp is known. The timestamp lifts the surface from a bare
 * status word ("Backup: aktuell") to actionable detail
 * ("Backup: aktuell (14:00 So. 26.04.2026)") that tells the operator
 * *when* the green/amber/red reading was earned. The 'unknown' branch
 * and the 'backup-never-run' branch never carry a timestamp — there is
 * no run to point at — so they fall through with the bare base label.
 */
function labelFor(state: BackupBadgeState): string {
  const base = baseLabelFor(state);
  if (state.kind === 'unknown') return base;
  if (state.kind === 'red' && state.reason === 'backup-never-run') return base;
  if (state.lastBackupAt === undefined) return base;
  return STRINGS.backup.withTimestamp(base, formatBackupTimestampDE(state.lastBackupAt));
}

/**
 * Map the discriminated `kind` to a CSS-module class so the icon tint
 * consumes the semantic token chain (danger / warning / success /
 * muted). Kept here rather than inline so theme overrides via tokens.css
 * flow through without touching this file.
 */
function stateClassFor(state: BackupBadgeState): string {
  switch (state.kind) {
    case 'green':
      return styles.stateGreen;
    case 'amber':
      return styles.stateAmber;
    case 'red':
      return styles.stateRed;
    case 'unknown':
      return styles.stateUnknown;
    default: {
      const _exhaustive: never = state;
      throw new Error(`Unhandled backup-badge state: ${String(_exhaustive)}`);
    }
  }
}

export function BackupBadge({ state, variant = 'default' }: BackupBadgeProps) {
  const label = labelFor(state);
  const stateClass = stateClassFor(state);
  const surfaceClass = variant === 'inverse' ? styles.badgeInverse : '';

  // Tap surfaces the label as a toast so mobile users — where `title`
  // tooltips are effectively invisible — can discover the backup
  // state. Desktop users who click (rather than hover) get the same
  // toast as a harmless redundancy alongside the native tooltip;
  // keeping a single code path avoids an unreliable `hover: none`
  // media-query branch.
  const handleClick = () => {
    useToastStore.getState().show('info', label);
  };

  return (
    <button
      type="button"
      className={`${styles.badge} ${stateClass} ${surfaceClass}`.trim()}
      data-testid="backup-badge"
      data-badge-kind={state.kind}
      onClick={handleClick}
      title={label}
      aria-label={label}
      aria-live="polite"
    >
      {/* Database-stack + circular arrow — "database backup" glyph.
          `fill: currentColor` in CSS lets the colour follow the state
          class, so the same SVG renders in success/warning/danger/muted
          without per-variant art. */}
      <svg
        className={styles.icon}
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        focusable="false"
      >
        <ellipse cx="9" cy="5" rx="6" ry="2" />
        <path d="M3 5v4c0 1.1 2.7 2 6 2s6-.9 6-2V5" />
        <path d="M3 9v4c0 1.1 2.7 2 6 2s6-.9 6-2V9" />
        <path d="M3 13v4c0 1.1 2.7 2 6 2 .7 0 1.4 0 2-.1" />
        <path
          d="M14 14a4 4 0 1 1 4 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15 21h3v-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
