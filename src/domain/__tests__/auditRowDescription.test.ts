/**
 * Tests for `describeAuditRow` — the one-line German description of an
 * audit row shown in the project detail feed and the global Aktivität
 * view (ui/workflow-views.md §8.4.1, ui/management.md §8.13.1).
 *
 * Pins the three exemplars listed in the spec:
 *   - "Status geändert: Geplant → In Arbeit"
 *   - "Termine aktualisiert"
 *   - "Mitarbeiter zugewiesen: Jan Nowak"
 * plus the mirror-case "Zuweisung aufgehoben: ..." and the generic
 * fallback (unknown action, non-payload-carrying rows).
 */

import { describe, it, expect } from 'vitest';
import { describeAuditRow } from '../auditRowDescription';
import { labelForAuditAction } from '@/config/auditActionLabels';

describe('describeAuditRow', () => {
  it('renders a forward transition as "Status geändert: From → To"', () => {
    const out = describeAuditRow({
      action: 'transition:forward',
      entityType: 'project',
      payload: {
        before: { status: 'geplant', statusChangedAt: '2026-04-01T10:00:00.000Z' },
        after: { status: 'in_arbeit', statusChangedAt: '2026-04-20T10:00:00.000Z' },
      },
    });
    expect(out).toBe('Status geändert: Geplant → In Arbeit');
  });

  it('renders a backward transition with arrow in forward-order reading direction', () => {
    const out = describeAuditRow({
      action: 'transition:backward',
      entityType: 'project',
      payload: {
        before: { status: 'in_arbeit' },
        after: { status: 'geplant' },
      },
    });
    // Direction is "before → after" regardless of forward/backward — the
    // arrow represents the state change, not the workflow direction.
    expect(out).toBe('Status geändert: In Arbeit → Geplant');
  });

  it('falls back to the generic label when a transition payload is malformed', () => {
    const out = describeAuditRow({
      action: 'transition:forward',
      entityType: 'project',
      payload: { before: {}, after: {} },
    });
    expect(out).toBe('Status weiter');
  });

  it('renders a project update touching plannedStart/plannedEnd as "Termine aktualisiert"', () => {
    const out = describeAuditRow({
      action: 'update',
      entityType: 'project',
      payload: {
        before: { plannedStart: '2026-04-01' },
        after: { plannedStart: '2026-04-10' },
      },
    });
    expect(out).toBe('Termine aktualisiert');
  });

  it('renders a project update touching only plannedEnd as "Termine aktualisiert"', () => {
    const out = describeAuditRow({
      action: 'update',
      entityType: 'project',
      payload: {
        before: { plannedEnd: null },
        after: { plannedEnd: '2026-05-01' },
      },
    });
    expect(out).toBe('Termine aktualisiert');
  });

  it('does NOT render "Termine aktualisiert" when the update touches non-date fields only', () => {
    // Rationale: a notes-only change must not pretend to be a date
    // change. The generic label is the correct fallback.
    const out = describeAuditRow({
      action: 'update',
      entityType: 'project',
      payload: {
        before: { notes: 'old' },
        after: { notes: 'new' },
      },
    });
    expect(out).toBe('Aktualisiert');
  });

  it('renders project_worker create with displayName as "Mitarbeiter zugewiesen: <name>"', () => {
    const out = describeAuditRow({
      action: 'create',
      entityType: 'project_worker',
      payload: {
        before: {},
        after: { projectId: 'p-1', userId: 'u-1', displayName: 'Jan Nowak' },
      },
    });
    expect(out).toBe('Mitarbeiter zugewiesen: Jan Nowak');
  });

  it('renders project_worker delete with displayName as "Zuweisung aufgehoben: <name>"', () => {
    const out = describeAuditRow({
      action: 'delete',
      entityType: 'project_worker',
      payload: {
        before: { projectId: 'p-1', userId: 'u-1', displayName: 'Jan Nowak' },
        after: {},
      },
    });
    expect(out).toBe('Zuweisung aufgehoben: Jan Nowak');
  });

  it('renders project_worker create without displayName as the bare label', () => {
    // Null payload is the defensive branch — an import or legacy row
    // may omit the displayName. The description must still render
    // something meaningful; the bare German label is that fallback.
    const out = describeAuditRow({
      action: 'create',
      entityType: 'project_worker',
      payload: null,
    });
    expect(out).toBe('Mitarbeiter zugewiesen');
  });

  it('renders a project archive (soft-delete) via the generic label', () => {
    // The `archive` action is distinct from `delete` and `purge` — the
    // generic label from auditActionLabels carries the correct copy.
    const out = describeAuditRow({
      action: 'archive',
      entityType: 'project',
      payload: { before: { number: 'P-1', title: 'X' }, after: {} },
    });
    expect(out).toBe(labelForAuditAction('archive'));
  });

  it('falls back to labelForAuditAction for known non-enriched actions', () => {
    const out = describeAuditRow({
      action: 'purge',
      entityType: 'project',
      payload: null,
    });
    expect(out).toBe(labelForAuditAction('purge'));
  });

  it('renders an attachment:add row via the config-layer label', () => {
    // Attachment is a first-class member of AuditEntityType (data-model.md
    // §5.10). No enriched rendering is wired for attachment yet, so the
    // generic label from auditActionLabels carries the copy.
    const out = describeAuditRow({
      action: 'attachment:add',
      entityType: 'attachment',
      payload: {
        after: {
          projectId: 'p-1',
          attachmentId: 'a-1',
          label: 'rechnung',
          mimeType: 'application/pdf',
          sizeBytes: 1234,
        },
      },
    });
    expect(out).toBe(labelForAuditAction('attachment:add'));
  });

  it('renders an attachment:hide row via the config-layer label', () => {
    const out = describeAuditRow({
      action: 'attachment:hide',
      entityType: 'attachment',
      payload: {
        before: {
          projectId: 'p-1',
          attachmentId: 'a-1',
          label: 'rechnung',
          mimeType: 'application/pdf',
          sizeBytes: 1234,
        },
      },
    });
    expect(out).toBe(labelForAuditAction('attachment:hide'));
  });

  it('returns the raw action string for unknown actions (forward-compat)', () => {
    // data-model.md §5.10 pins action as free-text; the UI must render
    // something for an action it has not learned yet. Sample action is
    // deliberately absent from AUDIT_ACTION_LABELS.
    const out = describeAuditRow({
      action: 'supplier:add',
      entityType: 'project',
      payload: null,
    });
    expect(out).toBe('supplier:add');
  });

  // -------------------------------------------------------------------
  // data_import / import_restored — single deployment-event row whose
  // payload carries the per-slot row counts. Renders inline so the
  // operator sees the breakdown without expanding the JSON drawer
  // (whose dump shows English column keys).
  // -------------------------------------------------------------------
  describe('data_import / import_restored', () => {
    it('renders a multi-slot import as a comma-separated German list', () => {
      const out = describeAuditRow({
        action: 'import_restored',
        entityType: 'data_import',
        payload: {
          counts: {
            users: 3,
            company_profile: 1,
            customers: 5,
            projects: 7,
            project_workers: 2,
            invoices: 12,
            invoice_sequence: 2,
            attachments: 0,
          },
        },
      });
      expect(out).toBe(
        'Daten importiert: 3 Benutzer, Firmenprofil, 5 Kunden, 7 Projekte, 2 Zuweisungen, 12 Rechnungen, 2 Rechnungs-Sequenzen',
      );
    });

    it('uses German singular forms when a slot has exactly one row', () => {
      const out = describeAuditRow({
        action: 'import_restored',
        entityType: 'data_import',
        payload: {
          counts: {
            users: 1,
            company_profile: 0,
            customers: 1,
            projects: 1,
            project_workers: 1,
            invoices: 1,
            invoice_sequence: 1,
            attachments: 0,
          },
        },
      });
      expect(out).toBe(
        'Daten importiert: 1 Benutzer, 1 Kunde, 1 Projekt, 1 Zuweisung, 1 Rechnung, 1 Rechnungs-Sequenz',
      );
    });

    it('omits zero-count slots from the rendered list', () => {
      const out = describeAuditRow({
        action: 'import_restored',
        entityType: 'data_import',
        payload: {
          counts: {
            users: 2,
            company_profile: 0,
            customers: 0,
            projects: 0,
            project_workers: 0,
            invoices: 0,
            invoice_sequence: 0,
            attachments: 0,
          },
        },
      });
      expect(out).toBe('Daten importiert: 2 Benutzer');
    });

    it('falls back to the bare prefix when counts are missing or all zero', () => {
      // Defense: an envelope that imported nothing (or a hand-edited
      // audit row without counts) still renders something meaningful.
      const noCounts = describeAuditRow({
        action: 'import_restored',
        entityType: 'data_import',
        payload: null,
      });
      expect(noCounts).toBe('Daten importiert');

      const allZero = describeAuditRow({
        action: 'import_restored',
        entityType: 'data_import',
        payload: {
          counts: {
            users: 0,
            company_profile: 0,
            customers: 0,
            projects: 0,
            project_workers: 0,
            invoices: 0,
            invoice_sequence: 0,
            attachments: 0,
          },
        },
      });
      expect(allZero).toBe('Daten importiert: keine Datensätze');
    });
  });
});
