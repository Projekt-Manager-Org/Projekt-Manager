/**
 * Unit tests: the access gates publish their own rule (AC-352).
 *
 * `scripts/generate-api-surface.ts` reads these tags instead of guessing
 * who can reach an endpoint. The generated table plus its `--check` would
 * catch a broken tag eventually, but as "API surface is stale" — which
 * points at the document, not at the gate that actually regressed. These
 * pin the contract where it lives.
 *
 * No database and no HTTP: the gates store the handle at construction and
 * only touch it once a request arrives, so a bare object stands in.
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type RouteOptions } from 'fastify';
import type { Database } from '../../db/connection.js';
import { createAuthMiddleware, requirePermission, requireRole, requireSession } from '../auth.js';

const db = {} as Database;

describe('access gate metadata', () => {
  it('createAuthMiddleware tags its preHandler as a session gate', () => {
    expect(createAuthMiddleware(db).requiresSession).toBe(true);
  });

  it('requirePermission carries every key it accepts', () => {
    expect(requirePermission('project:read').requiredPermissions).toEqual(['project:read']);
    expect(requirePermission('invoice:read', 'invoice:write').requiredPermissions).toEqual([
      'invoice:read',
      'invoice:write',
    ]);
  });

  it('requireRole carries every role it accepts', () => {
    expect(requireRole('owner').requiredRoles).toEqual(['owner']);
  });

  it('requireSession marks the routes it protects, and only those', async () => {
    const app = Fastify({ logger: false });
    const routes = new Map<string, RouteOptions>();
    app.addHook('onRoute', (routeOptions) => {
      routes.set(`${String(routeOptions.method)} ${routeOptions.url}`, routeOptions);
    });

    await app.register(async (plugin) => {
      requireSession(plugin, db);
      plugin.get('/gated', async () => 'ok');
    });
    // Outside that plugin's encapsulation context — the marker must not
    // leak here, or every public endpoint would publish as protected.
    app.get('/public', async () => 'ok');
    await app.ready();

    expect(routes.get('GET /gated')?.config?.auth).toBe('session');
    expect(routes.get('GET /public')?.config?.auth).toBeUndefined();

    await app.close();
  });
});
