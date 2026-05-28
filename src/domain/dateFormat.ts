import { parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { LOCALE } from '@/config/localeConfig';
import { STRINGS } from '@/config/strings';

// The *DE formatters claim German formatting, which by convention
// includes Berlin wall-clock time. Binding the zone here means a
// process running on a UTC host (CI, default cloud VM) still renders
// the audit log / badge tooltips in the timezone users expect, rather
// than silently inheriting the host TZ.
const DE_TIMEZONE = 'Europe/Berlin';

/**
 * Format a `Date` as YYYY-MM-DD using its LOCAL components.
 *
 * `toISOString().slice(0, 10)` is wrong for this purpose: it emits the
 * UTC date, which under a non-UTC server timezone shifts a `date`-typed
 * row read by node-postgres — pg returns `2026-07-01` as `Date(2026-07-01
 * 00:00 local)`, then UTC slicing yields `2026-06-30` for any TZ east
 * of UTC. Use the local components so the formatted string matches the
 * date the JS `Date` actually represents.
 */
export function formatDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Format an ISO date string to German DD.MM.YYYY format.
 */
export function formatDateDE(isoDate: string): string {
  return formatInTimeZone(parseISO(isoDate), DE_TIMEZONE, 'dd.MM.yyyy', {
    locale: LOCALE.dateFns,
  });
}

/**
 * Format an ISO timestamp to German `DD.MM.YYYY HH:mm` — used by the
 * audit log / Aktivität view (spec ui/workflow-views.md §8.4.1,
 * ui/management.md §8.13.1).
 */
export function formatDateTimeDE(isoDate: string): string {
  return formatInTimeZone(parseISO(isoDate), DE_TIMEZONE, 'dd.MM.yyyy HH:mm', {
    locale: LOCALE.dateFns,
  });
}

/**
 * Format an ISO date string to short German DD.MM. format.
 */
export function formatDateShortDE(isoDate: string): string {
  return formatInTimeZone(parseISO(isoDate), DE_TIMEZONE, 'dd.MM.', {
    locale: LOCALE.dateFns,
  });
}

/**
 * Format an ISO timestamp for the backup-freshness badge tooltip:
 * `HH:mm EEE dd.MM.yyyy` — e.g. `14:00 So. 26.04.2026`.
 *
 * Distinct from `formatDateTimeDE` (audit log) because the badge surface
 * is a glanceable status cue, not a chronological log entry: the
 * weekday abbreviation in front lets the operator tell "yesterday" from
 * "Saturday last week" at a glance without subtracting dates.
 */
export function formatBackupTimestampDE(isoDate: string): string {
  return formatInTimeZone(parseISO(isoDate), DE_TIMEZONE, 'HH:mm EEE dd.MM.yyyy', {
    locale: LOCALE.dateFns,
  });
}

/**
 * Format a date range for display. Uses short format for start if same year.
 */
export function formatDateRange(start?: string, end?: string): string {
  if (!start && !end) return STRINGS.projects.noDate;
  if (start && !end) return formatDateDE(start);
  if (start && end) {
    const startDate = parseISO(start);
    const endDate = parseISO(end);
    if (startDate.getFullYear() === endDate.getFullYear()) {
      return `${formatDateShortDE(start)} – ${formatDateDE(end)}`;
    }
    return `${formatDateDE(start)} – ${formatDateDE(end)}`;
  }
  return STRINGS.projects.noDate;
}

/**
 * Format a currency value in German locale. `null` and `undefined`
 * return an em-dash placeholder rather than falling through to
 * `Intl.NumberFormat.format(null)`, which would render a falsified
 * "0,00 €" and mislead the user — see consolidation review D F-8.
 * Callers should also gate the surrounding DOM on a real number
 * (belt-and-braces), but the return value here guarantees no zero
 * leaks through the format path even if the gate is missed.
 */
export function formatCurrencyDE(value: number | null | undefined): string {
  if (value == null) return '\u2014';
  return new Intl.NumberFormat(LOCALE.intlLocale, {
    style: 'currency',
    currency: LOCALE.currency,
  }).format(value);
}
