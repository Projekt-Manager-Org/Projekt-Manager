import { differenceInCalendarDays } from 'date-fns';
import { STRINGS } from '@/config/strings';
import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import type { WorkflowState } from '@/config/stateConfig';

/**
 * Calculate the number of days a project has been in its current state.
 */
export function getDaysInState(statusChangedAt: string, now: Date = new Date()): number {
  const changedDate = new Date(statusChangedAt);
  return differenceInCalendarDays(now, changedDate);
}

/**
 * Returns whether the entry date should be bold for this state.
 * Action states: bold from agingBoldDays on.
 * Buffer states: bold from agingBoldDays on (same as threshold).
 * Active/Done: never bold.
 */
export function isAgingBold(
  state: WorkflowState,
  statusChangedAt: string,
  now: Date = new Date(),
): boolean {
  const config = STATE_CONFIG_MAP[state];
  if (config.type === 'active' || config.type === 'done') return false;
  if (config.agingBoldDays === undefined) return false;
  const days = getDaysInState(statusChangedAt, now);
  return days >= config.agingBoldDays;
}

/**
 * Returns "seit X Tagen" text for buffer states at or past threshold, or null.
 */
export function getAgingText(
  state: WorkflowState,
  statusChangedAt: string,
  now: Date = new Date(),
): string | null {
  const config = STATE_CONFIG_MAP[state];
  if (config.type !== 'buffer') return null;
  if (config.agingThresholdDays === undefined) return null;
  const days = getDaysInState(statusChangedAt, now);
  if (days < config.agingThresholdDays) return null;
  return STRINGS.aging.sinceNDays(days);
}

/**
 * Check if a buffer project is at or past its aging threshold.
 */
export function isBufferAged(
  state: WorkflowState,
  statusChangedAt: string,
  now: Date = new Date(),
): boolean {
  const config = STATE_CONFIG_MAP[state];
  if (config.type !== 'buffer') return false;
  if (config.agingThresholdDays === undefined) return false;
  return getDaysInState(statusChangedAt, now) >= config.agingThresholdDays;
}
