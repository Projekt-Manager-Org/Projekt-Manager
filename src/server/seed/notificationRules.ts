/**
 * Seed loader for v1 notification rules — ADR-0023 §Decision (initial
 * event set). Populated once during seed hydration; production deployments
 * run the same seed on first boot (SEED=true) and the admin adjusts rules
 * after the first login.
 *
 * Rule choices (recorded here as canonical starting state; revisit in
 * the admin UI as usage emerges):
 *   - project.transition_forward  → assigned workers
 *   - project.transition_backward → assigned workers
 *   - project.archived            → owner
 *   - project.assignment_changed  → assigned workers
 *   - project.attachment_added    → owner + office
 *   - backup.failed               → owner
 *   - disk.threshold_reached      → owner
 *
 * Rationale: the per-project events target the people actually doing the
 * work (assigned workers). Owner stays out of these defaults because the
 * activity feed already surfaces every mutation to them — there is no
 * signal loss. Archive is an owner-only event (destructive), matching
 * the matrix where `project:purge` and archive visibility are owner
 * territory. Backup / disk events are infrastructure concerns the owner
 * operates, so the default recipient is owner only.
 *
 * New attachments notify owner + office: a file landing on a project is
 * an inbound document the supervising roles want pushed proactively (a
 * worker uploads a site photo or a signed form), so it is not missed
 * between active feed sessions. Unlike the high-frequency transition /
 * assignment events, an upload is a discrete arrival worth a push.
 *
 * This is a direct-DB INSERT path — the seed hydrates administrative
 * config, not a normal rule edit, so the `audit_log` row would be noise
 * and ADR-0021 §Decision explicitly allowlists seed writes.
 */

import type { Database } from '../db/connection.js';
import { notificationRule } from '../db/schema.js';
import type { NotificationRecipientSpec } from '../../domain/notifications.js';
import type { NotificationEventClass } from '../../config/notificationEvents.js';

interface SeedRuleSpec {
  eventClass: NotificationEventClass;
  stateFilter: string | null;
  recipientSpec: NotificationRecipientSpec;
}

const SEED_RULES: readonly SeedRuleSpec[] = [
  {
    eventClass: 'project.transition_forward',
    stateFilter: null,
    recipientSpec: {
      roles: [],
      includeAssignedWorkers: true,
      userIds: [],
    },
  },
  {
    eventClass: 'project.transition_backward',
    stateFilter: null,
    recipientSpec: {
      roles: [],
      includeAssignedWorkers: true,
      userIds: [],
    },
  },
  {
    eventClass: 'project.archived',
    stateFilter: null,
    recipientSpec: {
      roles: ['owner'],
      includeAssignedWorkers: false,
      userIds: [],
    },
  },
  {
    eventClass: 'project.assignment_changed',
    stateFilter: null,
    recipientSpec: {
      roles: [],
      includeAssignedWorkers: true,
      userIds: [],
    },
  },
  {
    eventClass: 'project.attachment_added',
    stateFilter: null,
    recipientSpec: {
      roles: ['owner', 'office'],
      includeAssignedWorkers: false,
      userIds: [],
    },
  },
  {
    eventClass: 'backup.failed',
    stateFilter: null,
    recipientSpec: {
      roles: ['owner'],
      includeAssignedWorkers: false,
      userIds: [],
    },
  },
  {
    eventClass: 'disk.threshold_reached',
    stateFilter: null,
    recipientSpec: {
      roles: ['owner'],
      includeAssignedWorkers: false,
      userIds: [],
    },
  },
];

export async function loadNotificationRules(db: Database): Promise<void> {
  if (SEED_RULES.length === 0) return;
  await db.insert(notificationRule).values(
    SEED_RULES.map((r) => ({
      eventClass: r.eventClass,
      stateFilter: r.stateFilter,
      recipientSpec: r.recipientSpec,
      enabled: true,
    })),
  );
}
