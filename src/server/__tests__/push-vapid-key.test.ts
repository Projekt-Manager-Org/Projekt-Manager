/**
 * VAPID public-key endpoint tests — ADR-0023 / api.md §14.2.10.
 *
 * The endpoint returns the public key captured at plugin-registration
 * time (resolved once at boot in `buildApp`). These tests pin:
 *   - Configured case: key passed to plugin → 200 with the key.
 *   - Absent case: `null` passed to plugin → 200 with `null`.
 *   - Method shape: non-GET verbs → 405, not 404.
 *
 * Scope: unit-level. The endpoint does not touch the DB or the auth
 * middleware, so a minimal Fastify instance with the public plugin
 * registered is enough — no integration harness, no env mocking.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pushPublicRoutes } from '../routes/push.js';
import { installErrorHandler } from '../error-handler.js';
import { STRINGS } from '../../config/strings.js';

async function buildTestApp(publicKey: string | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // The 405 guard throws an `AppError` carrying its own `Allow` header,
  // which the global handler writes with the body. Registering it here
  // is what makes this harness exercise the production path rather than
  // Fastify's default error serializer.
  installErrorHandler(app);
  await app.register(pushPublicRoutes(publicKey));
  await app.ready();
  return app;
}

describe('GET /api/push/vapid-public-key', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns the configured public key', async () => {
    app = await buildTestApp('BPublic_key_url_safe_base64');

    const res = await app.inject({ method: 'GET', url: '/api/push/vapid-public-key' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ vapidPublicKey: 'BPublic_key_url_safe_base64' });
    // Short cache: the client re-fetches on each subscribe attempt, so
    // an hour-long cache would mask a deploy-time key rotation.
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('returns null when push is not configured', async () => {
    app = await buildTestApp(null);

    const res = await app.inject({ method: 'GET', url: '/api/push/vapid-public-key' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ vapidPublicKey: null });
  });

  describe('non-GET verbs', () => {
    beforeEach(async () => {
      app = await buildTestApp(null);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('rejects %s with 405', async (method) => {
      const res = await app.inject({ method, url: '/api/push/vapid-public-key' });

      expect(res.statusCode).toBe(405);
      expect(res.headers['allow']).toBe('GET');
      // Body, not just the status line: this guard answered with a code
      // absent from the catalogue and an English message for as long as
      // it existed (AC-354). The other three 405 sites assert the same.
      const body = res.json() as { code?: string; message?: string };
      expect(body.code).toBe('METHOD_NOT_ALLOWED');
      expect(body.message).toBe(STRINGS.errors.methodNotAllowed);
    });
  });
});
