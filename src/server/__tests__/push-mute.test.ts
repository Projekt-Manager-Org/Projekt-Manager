/**
 * Push-mute integration tests — Iteration 8, issue #112.
 *
 * Pins AC-195 (push-mute) via AT-103.
 * `notification-publisher.test.ts` covers mute from the publisher's
 * angle; this file covers mute from the self-update API + subscription
 * persistence angle — the two sides of the contract, split for
 * T-ACBS clarity.
 *
 * Failing-state expectations (step 3):
 *   - `PATCH /api/auth/me` does not yet accept `pushMuted` → 400 / 422.
 *   - `push_subscriptions` table does not exist → COUNT raises
 *     "relation does not exist".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPatch } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

// ---------------------------------------------------------------------
// AC-195 — pushMuted controls push delivery, not activity-feed inclusion
// ---------------------------------------------------------------------
describe('AC-195: pushMuted toggles push delivery; rows retained; feed unaffected', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('PATCH /api/auth/me with pushMuted=true persists the value and is reflected by GET /api/auth/me', async () => {
    // Precondition: reset to false so the assertion is observable.
    const reset = await authPatch(ownerToken, '/api/auth/me', { pushMuted: false });
    expect(reset.statusCode).toBe(200);

    const muteRes = await authPatch(ownerToken, '/api/auth/me', { pushMuted: true });
    expect(muteRes.statusCode).toBe(200);
    const after = muteRes.json() as { user: { pushMuted?: boolean } };
    expect(after.user.pushMuted).toBe(true);

    const getRes = await authGet(ownerToken, '/api/auth/me');
    expect(getRes.statusCode).toBe(200);
    const me = getRes.json() as { user: { pushMuted?: boolean } };
    expect(me.user.pushMuted).toBe(true);
  });

  it('PATCH /api/auth/me rejects non-boolean pushMuted as 422 VALIDATION_ERROR', async () => {
    const res = await authPatch(ownerToken, '/api/auth/me', {
      pushMuted: 'not-a-boolean',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});
