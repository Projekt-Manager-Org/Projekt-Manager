/**
 * Notification rule validator — AC-190 clauses (a)–(f).
 *
 * Extracted from `NotificationRuleService` so the service file stays
 * focused on orchestration (mutate() calls + audit snapshotting) and
 * the validator sits next to the strings / config it depends on. Every
 * rejected clause maps to a single German error string in
 * `config/strings.ts` so a regression surfaces as a specific branch,
 * not a generic 422.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { TransactionalDatabase } from '../db/connection.js';
import { users } from '../db/schema.js';
import {
  NOTIFICATION_EVENT_CLASSES,
  PROJECT_SCOPED_EVENT_CLASSES,
  TRANSITION_EVENT_CLASSES,
  type NotificationEventClass,
} from '../../config/notificationEvents.js';
import { ROLE_KEYS } from '../../config/roleKeys.js';
import { STATE_KEYS } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { validationError } from '../errors.js';
import type { NotificationRecipientSpec } from '../../domain/notifications.js';

const VALID_EVENT_CLASSES: ReadonlySet<string> = new Set(NOTIFICATION_EVENT_CLASSES);
const VALID_ROLES: ReadonlySet<string> = new Set(ROLE_KEYS);
const VALID_STATES: ReadonlySet<string> = new Set(STATE_KEYS);

/**
 * Input shape for create/update validation. `stateFilter` is tri-state
 * — `undefined` = "not provided" (update-path no-op), `null` = "clear",
 * string = set. The same applies to other optional fields.
 */
export interface RuleInput {
  eventClass?: unknown;
  stateFilter?: unknown;
  recipientSpec?: unknown;
  enabled?: unknown;
}

export interface ValidatedRuleInput {
  eventClass: NotificationEventClass;
  stateFilter: string | null;
  recipientSpec: NotificationRecipientSpec;
  enabled?: boolean;
}

function isRecipientSpecEmpty(spec: NotificationRecipientSpec): boolean {
  return spec.roles.length === 0 && !spec.includeAssignedWorkers && spec.userIds.length === 0;
}

/**
 * Validate a rule payload against AC-190. Each rejected branch raises
 * `validationError()` with a focused message.
 */
export async function validateRuleInput(
  db: TransactionalDatabase,
  raw: RuleInput,
): Promise<ValidatedRuleInput> {
  // (a) eventClass must be in the closed catalog.
  const eventClass = raw.eventClass;
  if (typeof eventClass !== 'string' || !VALID_EVENT_CLASSES.has(eventClass)) {
    throw validationError(STRINGS.notifications.invalidEventClass);
  }

  // stateFilter — only meaningful on transition events (b).
  let stateFilter: string | null = null;
  if ('stateFilter' in raw && raw.stateFilter !== undefined) {
    if (raw.stateFilter === null) {
      stateFilter = null;
    } else if (typeof raw.stateFilter !== 'string') {
      throw validationError(STRINGS.notifications.invalidStateFilter);
    } else {
      if (!TRANSITION_EVENT_CLASSES.has(eventClass as NotificationEventClass)) {
        throw validationError(STRINGS.notifications.stateFilterNotAllowed);
      }
      if (!VALID_STATES.has(raw.stateFilter)) {
        throw validationError(STRINGS.notifications.invalidStateFilter);
      }
      stateFilter = raw.stateFilter;
    }
  }

  // recipientSpec — shape + role/user set checks (d, e, f).
  const rsRaw = raw.recipientSpec;
  if (
    typeof rsRaw !== 'object' ||
    rsRaw === null ||
    Array.isArray(rsRaw) ||
    !('roles' in rsRaw) ||
    !('includeAssignedWorkers' in rsRaw) ||
    !('userIds' in rsRaw)
  ) {
    throw validationError(STRINGS.notifications.invalidRecipientSpec);
  }
  const rs = rsRaw as Record<string, unknown>;
  if (!Array.isArray(rs.roles) || rs.roles.some((r) => typeof r !== 'string')) {
    throw validationError(STRINGS.notifications.invalidRecipientSpec);
  }
  if (typeof rs.includeAssignedWorkers !== 'boolean') {
    throw validationError(STRINGS.notifications.invalidRecipientSpec);
  }
  if (!Array.isArray(rs.userIds) || rs.userIds.some((u) => typeof u !== 'string')) {
    throw validationError(STRINGS.notifications.invalidRecipientSpec);
  }

  const roles = rs.roles as string[];
  const includeAssignedWorkers = rs.includeAssignedWorkers as boolean;
  const userIds = rs.userIds as string[];

  // (c) includeAssignedWorkers requires a project-scoped event class.
  if (
    includeAssignedWorkers &&
    !PROJECT_SCOPED_EVENT_CLASSES.has(eventClass as NotificationEventClass)
  ) {
    throw validationError(STRINGS.notifications.includeAssignedWorkersNotAllowed);
  }

  // (d) every role must be in the configured set.
  for (const r of roles) {
    if (!VALID_ROLES.has(r)) {
      throw validationError(STRINGS.notifications.invalidRole(r));
    }
  }

  // (e) every userId must reference an ACTIVE UserAccount row. A
  // missing id OR a row with active=false fails the payload; the
  // validator rejects with 422 VALIDATION_ERROR and does not persist.
  // Dispatch-time resilience (user deactivated/deleted AFTER rule
  // creation — AC-203) is handled at the publisher's
  // resolution step, not here.
  if (userIds.length > 0) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, userIds), eq(users.active, true)));
    const active = new Set(rows.map((r) => r.id));
    const missingOrInactive = userIds.filter((u) => !active.has(u));
    if (missingOrInactive.length > 0) {
      throw validationError(STRINGS.notifications.invalidUserId);
    }
  }

  const recipientSpec: NotificationRecipientSpec = {
    roles,
    includeAssignedWorkers,
    userIds,
  };

  // (f) the spec must resolve to at least one non-empty part. A spec
  // where every channel is empty is rejected as VALIDATION_ERROR —
  // the rule would fire for an event and deliver to nobody.
  if (isRecipientSpecEmpty(recipientSpec)) {
    throw validationError(STRINGS.notifications.emptyRecipientSpec);
  }

  const enabled = raw.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw validationError(STRINGS.notifications.invalidEnabled);
  }

  return {
    eventClass: eventClass as NotificationEventClass,
    stateFilter,
    recipientSpec,
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
  };
}
