/**
 * Push-dispatch configuration — ADR-0023.
 *
 * The kickoff commits to "delivered instantaneously under standard
 * circumstances" (kickoff §Done when #64). ADR-0023 pins the enforceable
 * ceiling at 5 s. Tests read this value rather than hardcoding a literal
 * so the configurable budget clause stays honest.
 *
 * `[C]` per architecture.md §12.2 — the env var is the customer-deployable
 * override; the default is the build-time shipping value.
 */

const DEFAULT_PUSH_DISPATCH_LATENCY_BUDGET_MS = 5000;

function readBudget(): number {
  const raw = process.env.PUSH_DISPATCH_LATENCY_BUDGET_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_PUSH_DISPATCH_LATENCY_BUDGET_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PUSH_DISPATCH_LATENCY_BUDGET_MS;
  }
  return parsed;
}

/**
 * Budget in milliseconds between the triggering domain commit and the
 * moment the push transport is invoked. AT-102 observes this
 * value.
 */
export const PUSH_DISPATCH_LATENCY_BUDGET_MS: number = readBudget();
