import { test, expect } from '@playwright/test';

/**
 * The local dev stack starts (README.md § Run locally).
 *
 * API-level checks — no browser needed. Proves the backend is running,
 * connected to the database, migrations applied, and seed data loaded.
 */
test.describe('local dev stack startup', () => {
  test('health endpoint responds', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    // #48 upgraded the probe: it now reports per-dependency state.
    // The shape is { status, checks: { db, storage } } — in the local
    // dev stack both should report `ok`.
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ db: 'ok', storage: 'ok' });
  });

  test('seed user can log in', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { username: 'inhaber', password: 'changeme' },
    });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.user.username).toBe('inhaber');
    expect(body.user.roles).toContain('owner');
  });
});
