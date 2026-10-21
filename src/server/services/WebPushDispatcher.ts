/**
 * Web Push dispatcher — real `web-push` transport. ADR-0023.
 *
 * Instantiated once at app composition when all three `VAPID_*` env
 * vars are present (see `buildApp` in `app.ts`). When any of them is
 * missing the composition falls back to `noopPushDispatcher` — this
 * class is not a silent no-op; a missing key would be an operator-
 * visible warning rather than a dispatch-time surprise.
 *
 * Response mapping (see `PushDispatcher.PushDispatchStatus`):
 *   - 200 / 201 / 202      → `'ok'`
 *   - 404 / 410            → `'gone'` (caller prunes the subscription)
 *   - everything else      → `'error'` (429, 5xx, network, timeout)
 *
 * `send()` never throws: the publisher's per-recipient loop relies on
 * the dispatcher being infallible so one bad subscription cannot block
 * the remaining recipients (architecture.md §11.11).
 */

import webpush, { WebPushError, type PushSubscription as WebPushSubscription } from 'web-push';
import type {
  PushDispatcher,
  PushDispatchStatus,
  PushPayload,
  PushSubscriptionTarget,
} from './PushDispatcher.js';

/**
 * TTL in seconds the push service retains the message while the device
 * is offline. 60 s matches the "instant delivery under standard
 * conditions" clause from kickoff §Done when #64 — notifications that
 * cannot reach the device promptly are dropped rather than queued for
 * hours.
 */
const PUSH_TTL_SECONDS = 60;

/**
 * Socket timeout for the outgoing POST to the push service. The
 * per-push budget (5 s) is the ceiling for the entire dispatch
 * pipeline (recipient resolution + transport). A 4 s transport cap
 * leaves room for the surrounding rule + recipient lookup without
 * punching through the budget.
 */
const PUSH_SOCKET_TIMEOUT_MS = 4000;

export interface WebPushDispatcherOptions {
  publicKey: string;
  privateKey: string;
  /** `mailto:` URL or `https:` URL per RFC 8292 §2.1. */
  subject: string;
}

export class WebPushDispatcher implements PushDispatcher {
  private readonly subject: string;
  private readonly publicKey: string;
  private readonly privateKey: string;

  constructor(opts: WebPushDispatcherOptions) {
    this.subject = opts.subject;
    this.publicKey = opts.publicKey;
    this.privateKey = opts.privateKey;
    // No module-level setVapidDetails call here — per-call `vapidDetails`
    // in sendNotification (below) is the isolation mechanism. A
    // constructor-level call would mutate shared `web-push` module state,
    // creating a race if two dispatcher instances coexist (e.g. tests).
  }

  async send(target: PushSubscriptionTarget, payload: PushPayload): Promise<PushDispatchStatus> {
    const subscription: WebPushSubscription = {
      endpoint: target.endpoint,
      keys: {
        p256dh: target.p256dh,
        auth: target.auth,
      },
    };

    let statusCode: number | null;
    try {
      const result = await webpush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: PUSH_TTL_SECONDS,
        timeout: PUSH_SOCKET_TIMEOUT_MS,
        // Re-assert vapidDetails per-call so concurrent dispatchers
        // (test harness) cannot race on the module-level state.
        vapidDetails: {
          subject: this.subject,
          publicKey: this.publicKey,
          privateKey: this.privateKey,
        },
      });
      statusCode = result.statusCode;
    } catch (err) {
      if (err instanceof WebPushError) {
        statusCode = err.statusCode;
      } else {
        // Network / timeout / unexpected — surface as generic error so
        // the caller records it without pruning the subscription.
        return 'error';
      }
    }

    return mapStatus(statusCode);
  }
}

/**
 * Pure status → PushDispatchStatus mapping. Exported for unit tests
 * that want to pin the mapping without involving the transport.
 */
export function mapStatus(statusCode: number | null): PushDispatchStatus {
  if (statusCode === null) return 'error';
  if (statusCode === 200 || statusCode === 201 || statusCode === 202) return 'ok';
  if (statusCode === 404 || statusCode === 410) return 'gone';
  return 'error';
}
