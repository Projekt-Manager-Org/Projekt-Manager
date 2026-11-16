/**
 * Notification domain types — shared by server services, repositories
 * and UI components. Per architecture.md §11.2 the domain layer is the
 * only module cross-importable from both sides of the codebase.
 *
 * The DB-level column types live in schema.ts; these interfaces pin the
 * service-boundary shape (camelCase, no ORM artefacts).
 */

import type { NotificationEventClass } from '../config/notificationEvents.js';

export type { NotificationEventClass };

export interface NotificationRecipientSpec {
  roles: string[];
  includeAssignedWorkers: boolean;
  userIds: string[];
}

/**
 * API-facing rule shape consumed by the admin rule-editor surface
 * (ui/management.md §8.14) and the `notificationRuleStore`. Mirrors
 * the server's `NotificationRuleResponse` — kept here so the UI layer
 * can import the type without touching the API client (AC-33).
 */
export interface NotificationRule {
  id: string;
  eventClass: NotificationEventClass;
  stateFilter: string | null;
  recipientSpec: NotificationRecipientSpec;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

/**
 * Create / update input for a rule. Validation (event class closed set,
 * stateFilter only on transitions, active userIds) is authoritative on
 * the server per AC-190.
 */
export interface NotificationRuleInput {
  eventClass: NotificationEventClass;
  stateFilter: string | null;
  recipientSpec: NotificationRecipientSpec;
  enabled: boolean;
}
