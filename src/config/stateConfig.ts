import { STRINGS } from './strings.js';

export type StateType = 'action' | 'buffer' | 'active' | 'done';

/**
 * Auto-collapse priority for Kanban columns as the board narrows (see
 * `useCollapseTier.ts`). Lower tier = higher priority = stays expanded
 * longer: a column collapses when `activeTier > 0 && collapseTier >=
 * activeTier`, so tier-3 columns collapse first (widest boards), tier-2
 * next, and tier-1 last (only on the narrowest boards).
 */
export type CollapseTier = 1 | 2 | 3;

/**
 * Single source of truth for the workflow-state set. The `WorkflowState`
 * type and all downstream config derive from this array.
 *
 * Adding, renaming, or removing a state is NOT a config-only change: the
 * DB CHECK constraint (`projects_valid_status`) enumerates every state and
 * needs a regenerated migration, and `src/domain/transitions.ts` hardcodes
 * the first/last boundary literals. See ARCHITECTURE.md § "Adding a new
 * workflow state" for the full checklist.
 */
export const STATE_KEYS = [
  'anfrage',
  'angebot',
  'beauftragt',
  'geplant',
  'in_arbeit',
  'abnahme',
  'rechnung_faellig',
  'abgerechnet',
  'erledigt',
] as const;

export type WorkflowState = (typeof STATE_KEYS)[number];

export interface StateConfig {
  key: WorkflowState;
  label: string;
  type: StateType;
  order: number;
  color: string;
  collapseTier: CollapseTier;
  agingThresholdDays?: number;
  agingBoldDays?: number;
}

export const STATE_CONFIGS: StateConfig[] = [
  {
    key: 'anfrage',
    label: STRINGS.states.anfrage,
    type: 'action',
    order: 1,
    color: '#F97316',
    collapseTier: 1,
    agingBoldDays: 3,
  },
  {
    key: 'angebot',
    label: STRINGS.states.angebot,
    type: 'buffer',
    order: 2,
    color: '#93C5FD',
    collapseTier: 3,
    agingThresholdDays: 14,
    agingBoldDays: 14,
  },
  {
    key: 'beauftragt',
    label: STRINGS.states.beauftragt,
    type: 'action',
    order: 3,
    color: '#F59E0B',
    collapseTier: 1,
    agingBoldDays: 5,
  },
  {
    key: 'geplant',
    label: STRINGS.states.geplant,
    type: 'buffer',
    order: 4,
    color: '#3B82F6',
    collapseTier: 2,
    agingThresholdDays: 21,
    agingBoldDays: 21,
  },
  {
    key: 'in_arbeit',
    label: STRINGS.states.in_arbeit,
    type: 'active',
    order: 5,
    color: '#22C55E',
    collapseTier: 2,
  },
  {
    key: 'abnahme',
    label: STRINGS.states.abnahme,
    type: 'buffer',
    order: 6,
    color: '#14B8A6',
    collapseTier: 2,
    agingThresholdDays: 7,
    agingBoldDays: 7,
  },
  {
    key: 'rechnung_faellig',
    label: STRINGS.states.rechnung_faellig,
    type: 'action',
    order: 7,
    color: '#EF4444',
    collapseTier: 1,
    agingBoldDays: 3,
  },
  {
    key: 'abgerechnet',
    label: STRINGS.states.abgerechnet,
    type: 'buffer',
    order: 8,
    color: '#6366F1',
    collapseTier: 3,
    agingThresholdDays: 30,
    agingBoldDays: 30,
  },
  {
    key: 'erledigt',
    label: STRINGS.states.erledigt,
    type: 'done',
    order: 9,
    color: '#9CA3AF',
    collapseTier: 3,
  },
];

export const STATE_CONFIG_MAP: Record<WorkflowState, StateConfig> = Object.fromEntries(
  STATE_CONFIGS.map((config) => [config.key, config]),
) as Record<WorkflowState, StateConfig>;

export const WORKFLOW_ORDER: WorkflowState[] = STATE_CONFIGS.sort((a, b) => a.order - b.order).map(
  (c) => c.key,
);

// State-domain fallback color for unknown workflow states. Lives here with
// the state palette (not in tokens.css) so the state-color domain stays
// self-contained; this file is the documented allowlist exception for
// palette literals (AC-108).
export const STATE_FALLBACK_COLOR = '#94a3b8';
