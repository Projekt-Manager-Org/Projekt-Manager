/**
 * Notification rule service — admin CRUD (ADR-0023, data-model.md §5.11).
 *
 * Rule mutations do NOT route through `mutate()` (ADR-0023 §Decision:
 * rule changes are administrative config, not audited domain events).
 * Rule reads are unscoped: admin-only surface, so the ADR-0019 predicate
 * pattern is not applied here (permission gate is the only bar).
 *
 * Validation lives next door in `notificationRuleValidator.ts`.
 */

import type { Database } from '../db/connection.js';
import {
  deleteRule as deleteRuleRepo,
  findRuleById,
  insertRule,
  listRules as listRulesRepo,
  toRuleResponse,
  updateRule as updateRuleRepo,
  type NotificationRuleResponse,
} from '../repositories/notificationRule.js';
import { STRINGS } from '../../config/strings.js';
import { notFound } from '../errors.js';
import { validateRuleInput, type RuleInput } from './notificationRuleValidator.js';

export type { RuleInput } from './notificationRuleValidator.js';

export class NotificationRuleService {
  constructor(private db: Database) {}

  async list(): Promise<{ data: NotificationRuleResponse[]; total: number }> {
    const data = await listRulesRepo(this.db);
    return { data, total: data.length };
  }

  async get(id: string): Promise<NotificationRuleResponse> {
    const row = await findRuleById(this.db, id);
    if (!row) throw notFound(STRINGS.entities.notificationRule);
    return toRuleResponse(row);
  }

  // actorId / correlationId kept in the signature so the route layer
  // (notification-rules.ts) needs no change; they are unused here —
  // rule mutations are not audited (ADR-0023).
  async create(
    input: RuleInput,
    actorId: string,
    _correlationId?: string | null,
  ): Promise<NotificationRuleResponse> {
    const validated = await validateRuleInput(this.db, input);
    const row = await insertRule(this.db, {
      eventClass: validated.eventClass,
      stateFilter: validated.stateFilter ?? null,
      recipientSpec: validated.recipientSpec,
      enabled: validated.enabled ?? true,
      createdBy: actorId,
      updatedBy: actorId,
    });
    return toRuleResponse(row);
  }

  async update(
    id: string,
    input: RuleInput,
    actorId: string,
    _correlationId?: string | null,
  ): Promise<NotificationRuleResponse> {
    // Read-then-write inside a transaction so the merge is consistent
    // and validation sees the committed prior state.
    return this.db.transaction(async (tx) => {
      const prior = await findRuleById(tx, id);
      if (!prior) throw notFound(STRINGS.entities.notificationRule);

      // Merge the patch onto the prior row for validation — the merged
      // view must satisfy cross-field invariants (stateFilter only on
      // transition classes).
      const merged: RuleInput = {
        eventClass: input.eventClass ?? prior.eventClass,
        stateFilter: 'stateFilter' in input ? input.stateFilter : prior.stateFilter,
        recipientSpec: input.recipientSpec ?? prior.recipientSpec,
        enabled: input.enabled ?? prior.enabled,
      };
      const validated = await validateRuleInput(tx, merged);

      const updated = await updateRuleRepo(tx, id, actorId, {
        eventClass: validated.eventClass,
        stateFilter: 'stateFilter' in input ? (validated.stateFilter ?? null) : undefined,
        recipientSpec: validated.recipientSpec,
        enabled: validated.enabled,
      });
      if (!updated) throw notFound(STRINGS.entities.notificationRule);

      return toRuleResponse(updated);
    });
  }

  async remove(id: string, _actorId: string, _correlationId?: string | null): Promise<void> {
    const prior = await findRuleById(this.db, id);
    if (!prior) throw notFound(STRINGS.entities.notificationRule);
    const deleted = await deleteRuleRepo(this.db, id);
    if (!deleted) throw notFound(STRINGS.entities.notificationRule);
  }
}
