/**
 * API integration tests: Project date updates.
 *
 * Tests AT-12 and AT-13 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * All project operations require authentication. Tests use the `login` helper
 * to obtain a session token before making requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPatch } from '../../test/api-helpers.js';

/** ISO 8601 date-time regex (loose — allows date-only or full timestamp) */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;

describe('Project Operations — Dates', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AT-12: Update dates changes plannedStart/plannedEnd and updatedAt
  //        but not statusChangedAt
  // ---------------------------------------------------------------
  describe('AT-12: Update dates', () => {
    // A single PATCH pins every AT-12 invariant in one shot:
    //   - plannedStart / plannedEnd are persisted on the row
    //   - updatedAt changes (mutation stamps audit-row time)
    //   - statusChangedAt does NOT change (date edit is not a transition)
    //   - updatedBy is the authenticated user (mutate() stamping)
    // Splitting these across three tests gave no extra coverage —
    // identical setup, identical PATCH shape, identical service path.
    it('persists dates, stamps updatedAt+updatedBy, leaves statusChangedAt', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find(
        (p: Record<string, unknown>) => p.plannedStart != null && p.plannedEnd != null,
      );
      expect(project).toBeDefined();

      const originalStatusChangedAt = project.statusChangedAt;
      const originalUpdatedAt = project.updatedAt;

      const meRes = await authGet(token, '/api/auth/me');
      const me = meRes.json().user;

      const newStart = '2026-05-01';
      const newEnd = '2026-05-10';

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: newStart,
        plannedEnd: newEnd,
      });

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.plannedStart).toContain(newStart);
      expect(updated.plannedEnd).toContain(newEnd);
      // statusChangedAt must NOT change — date edits are not state transitions.
      expect(updated.statusChangedAt).toBe(originalStatusChangedAt);
      // updatedAt MUST change.
      expect(updated.updatedAt).not.toBe(originalUpdatedAt);
      expect(updated.updatedAt).toMatch(ISO_DATE_REGEX);
      // updatedBy stamps the authenticated user.
      expect(updated.updatedBy).toBe(me.id);
    });
  });

  // ---------------------------------------------------------------
  // AT-13: Update dates with plannedEnd before plannedStart is rejected
  // ---------------------------------------------------------------
  describe('AT-13: Update dates with invalid range', () => {
    it('rejects when plannedEnd is before plannedStart', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find((p: Record<string, unknown>) => p.plannedStart != null);
      expect(project).toBeDefined();

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-06-15',
        plannedEnd: '2026-06-01', // end before start
      });

      expect(res.statusCode).toBe(422);

      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('rejects when only plannedEnd is set without plannedStart', async () => {
      // data-model.md §6.8: setting only plannedEnd without plannedStart is not valid
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      // Find a project without dates to test setting end-only
      const project = projects.find(
        (p: Record<string, unknown>) => p.plannedStart == null && p.plannedEnd == null,
      );
      expect(project).toBeDefined();

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedEnd: '2026-06-15',
        // No plannedStart
      });

      expect(res.statusCode).toBe(422);

      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('accepts plannedStart without plannedEnd (single-day block)', async () => {
      // data-model.md §6.8: plannedStart alone is valid — renders as a
      // single-day block on the calendar. Seed the precondition by
      // first clearing both dates; then PATCH plannedStart alone.
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find(
        (p: Record<string, unknown>) => p.plannedStart != null && p.plannedEnd != null,
      );
      expect(project).toBeDefined();

      const clearRes = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: null,
        plannedEnd: null,
      });
      expect(clearRes.statusCode).toBe(200);

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-09-01',
        // No plannedEnd — valid per spec (partial PATCH: end stays null)
      });

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.plannedStart).toContain('2026-09-01');
      expect(updated.plannedEnd == null).toBe(true);
    });

    it('PATCH of plannedStart alone preserves an existing plannedEnd (partial PATCH)', async () => {
      // Regression guard: before this fix the repo auto-cleared
      // plannedEnd whenever plannedStart was sent alone. That silently
      // wiped user data on every start-date edit. PATCH is partial —
      // an absent key means unchanged. If the resulting pair violates
      // the end >= start invariant, the validator rejects with
      // VALIDATION_ERROR; it does not paper over the conflict by
      // clearing end.
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find(
        (p: Record<string, unknown>) => p.plannedStart != null && p.plannedEnd != null,
      );
      expect(project).toBeDefined();

      const originalEnd = project.plannedEnd as string;

      // Move start earlier so end >= start still holds. The point of
      // this test is "end is not wiped", not "end migrates with start".
      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-03-01',
      });

      expect(res.statusCode).toBe(200);
      const updated = res.json();
      expect(updated.plannedStart).toContain('2026-03-01');
      expect(updated.plannedEnd).toContain(originalEnd.slice(0, 10));
    });

    it('clears plannedStart and plannedEnd when null values are sent explicitly', async () => {
      // AT-13 edge: frontend "clear planned dates" flow sends explicit nulls
      // (ProjectDetailPanel.tsx → `updateDates(id, val || null, ...)`).
      // Previously this returned 500 SERVER_ERROR because:
      //   1. the schema rejected `null` at ajv validation time (string only)
      //   2. the error handler rewrote the resulting FastifyError as a 500
      // Both are now fixed: schema accepts `string | null`, error handler
      // maps validation errors to 422 VALIDATION_ERROR, and the repo's
      // existing falsy→null branch (project-dates.ts:33-46) handles the
      // clear transparently.
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find(
        (p: Record<string, unknown>) => p.plannedStart != null && p.plannedEnd != null,
      );
      expect(project).toBeDefined();

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: null,
        plannedEnd: null,
      });

      expect(res.statusCode).toBe(200);
      const updated = res.json();
      expect(updated.plannedStart).toBeNull();
      expect(updated.plannedEnd).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // NOT_FOUND path: preserves coverage of ProjectNotFoundError at the
  // HTTP boundary. Was previously covered in project-dates.unit.test.ts
  // (deleted in the .unit consolidation); the HTTP layer only tested
  // 404 for GET /api/projects/:id, not for PATCH .../dates.
  // ---------------------------------------------------------------
  describe('PATCH dates on nonexistent project', () => {
    it('returns 404 NOT_FOUND for a well-formed but nonexistent UUID', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await authPatch(token, `/api/projects/${fakeId}/dates`, {
        plannedStart: '2026-06-01',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------
  // Schema validation: regression guard for the "Fastify schema errors
  // rewritten as 500" bug. Before the fix the global error handler only
  // caught AppError + 429, so any schema validation failure fell through
  // to serverError(). Now ajv failures are mapped to 422 VALIDATION_ERROR.
  // ---------------------------------------------------------------
  describe('PATCH dates with malformed body', () => {
    it('returns 422 VALIDATION_ERROR for wrong type (not 500)', async () => {
      const listRes = await authGet(token, '/api/projects');
      const project = listRes.json().data[0];

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: 42, // wrong type: number instead of date string
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });
  });
});
