/**
 * pushPayloadComposer unit tests — AC-211, AT-110.
 *
 * Pin the wire format the service worker reads back. The composer is
 * pure (no I/O), so each event class gets a dedicated case plus a
 * fallback case for the missing-audit-row branch (system events).
 */

import { describe, it, expect } from 'vitest';
import { composePushPayload } from '../services/pushPayloadComposer.js';
import type { AuditLogRow } from '../services/audit-publisher.js';
import { ROUTES } from '../../config/routes.js';

function row(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: 'audit-1',
    createdAt: new Date('2026-04-26T10:00:00Z'),
    actorId: 'user-1',
    actorKind: 'user',
    actorReason: null,
    entityType: 'project',
    entityId: 'project-42',
    entityLabel: '2026-002 Innenraumgestaltung Weber',
    ancestorEntityType: 'project',
    ancestorEntityId: 'project-42',
    ancestorEntityLabel: '2026-002 Innenraumgestaltung Weber',
    action: 'transition:forward',
    payload: { before: { status: 'anfrage' }, after: { status: 'beauftragt' } },
    correlationId: null,
    ...overrides,
  };
}

describe('composePushPayload — AC-211', () => {
  it('renders project.transition_forward with entityLabel and target status', () => {
    const out = composePushPayload('project.transition_forward', row(), null);
    expect(out.title).toBe('Projekt-Statuswechsel vorwärts');
    expect(out.body).toBe('2026-002 Innenraumgestaltung Weber → Beauftragt');
    expect(out.url).toBe('/projects/project-42');
  });

  it('renders project.transition_backward with the resolved status label', () => {
    const out = composePushPayload(
      'project.transition_backward',
      row({
        action: 'transition:backward',
        payload: { before: { status: 'beauftragt' }, after: { status: 'angebot' } },
      }),
      null,
    );
    expect(out.title).toBe('Projekt-Statuswechsel zurück');
    expect(out.body).toBe('2026-002 Innenraumgestaltung Weber → Angebot');
  });

  it('falls back to entityLabel only when the after.status is missing', () => {
    const out = composePushPayload(
      'project.transition_forward',
      row({ payload: { before: {}, after: {} } }),
      null,
    );
    expect(out.body).toBe('2026-002 Innenraumgestaltung Weber');
  });

  it('renders project.archived with entityLabel as the body', () => {
    const out = composePushPayload(
      'project.archived',
      row({ action: 'archive', payload: { before: {}, after: { deleted: true } } }),
      null,
    );
    expect(out.title).toBe('Projekt archiviert');
    expect(out.body).toBe('2026-002 Innenraumgestaltung Weber');
    expect(out.url).toBe('/projects/project-42');
  });

  it('renders project.assignment_changed with entityLabel as the body', () => {
    const out = composePushPayload(
      'project.assignment_changed',
      row({
        entityType: 'project_worker',
        action: 'create',
        // entityId remains the projectId — see ProjectCrudService convention.
        entityId: 'project-42',
      }),
      null,
    );
    expect(out.title).toBe('Mitarbeiter-Zuweisung geändert');
    expect(out.body).toBe('2026-002 Innenraumgestaltung Weber');
    expect(out.url).toBe('/projects/project-42');
  });

  it('renders project.attachment_added with the project-label snapshot from ancestorEntityLabel and an ancestor-resolved url', () => {
    // AC-211 for this class: the body names the affected project via the
    // row-level `ancestorEntityLabel` snapshot AND indicates a file was
    // added; the click target is `/projects/:id` resolved from the
    // audit row's ANCESTOR link, NOT `entityId` — an `attachment` row's
    // `entityId` is the attachment, the ancestor is the project. Distinct
    // ids for entityId vs ancestorEntityId so an entityId-based
    // regression on the url fails here. The payload-side projectLabel
    // duplicate (legacy AC-219 shape) is no longer rendered, ensuring
    // ancestorEntityLabel is the single source of the project name.
    const out = composePushPayload(
      'project.attachment_added',
      row({
        entityType: 'attachment',
        action: 'attachment:add',
        entityId: 'attachment-77',
        ancestorEntityType: 'project',
        ancestorEntityId: 'project-42',
        ancestorEntityLabel: '2026-002 Innenraumgestaltung Weber',
        entityLabel: 'ancestor.pdf',
        payload: {
          after: {
            projectId: 'project-42',
            attachmentId: 'attachment-77',
            label: 'rechnung',
            mimeType: 'application/pdf',
            sizeBytes: 123,
          },
        },
      }),
      null,
    );
    expect(out.title).toBe('Datei hinzugefügt');
    expect(out.body).toBe('Neue Datei in 2026-002 Innenraumgestaltung Weber');
    // Url comes from the ancestor's project id, NOT the attachment id —
    // the load-bearing distinction for this class. A regression that
    // resolved the url from `entityId` would land `/projects/attachment-77`.
    expect(out.url).toBe('/projects/project-42');
    expect(out.url).not.toBe('/projects/attachment-77');
  });

  it('falls back to "Neue Datei hinzugefügt" when attachment_added row has no ancestor label', () => {
    // Defensive branch: every `attachment:add` row is supposed to carry
    // a project ancestor (AC-219), but the composer falls back gracefully
    // when the snapshot is absent — e.g. a future top-level attachment
    // class, or a buggy write path. Pins the fallback string so a
    // regression that drops the conditional surfaces here instead of
    // emitting a confusing "Neue Datei in null".
    const out = composePushPayload(
      'project.attachment_added',
      row({
        entityType: 'attachment',
        action: 'attachment:add',
        entityId: 'attachment-77',
        ancestorEntityType: null,
        ancestorEntityId: null,
        ancestorEntityLabel: null,
        entityLabel: 'orphan.pdf',
        payload: { after: { attachmentId: 'attachment-77' } },
      }),
      null,
    );
    expect(out.title).toBe('Datei hinzugefügt');
    expect(out.body).toBe('Neue Datei hinzugefügt');
    // Url fallback: no ancestor → `/`, not `/projects/null`.
    expect(out.url).toBe('/');
  });

  it('renders backup.failed system event without an audit row', () => {
    const out = composePushPayload('backup.failed', null, {});
    // Title is deliberately broader than the class id — the threshold
    // monitor fires this class for any non-green badge state, not only
    // a failed run (#122).
    expect(out.title).toBe('Backup-Warnung');
    // Empty payload → generic fallback sentence.
    expect(out.body).toBe('Backup konnte nicht abgeschlossen werden.');
    expect(out.url).toBe('/kanban');
  });

  it('renders the badge reason into the backup.failed body when the monitor supplies one', () => {
    // Each reason maps to the badge's own German label so the push and
    // the badge the owner lands on cannot disagree (#122).
    const cases: ReadonlyArray<[string, string]> = [
      ['last-run-failed', 'Backup: fehlgeschlagen'],
      ['backup-never-run', 'Backup: noch nie ausgeführt'],
      ['drill-never-run', 'Drill: noch nie ausgeführt'],
      ['backup-stale', 'Backup: veraltet'],
      ['backup-aging', 'Backup: wird alt'],
      ['drill-stale', 'Backup: aktuell, Drill-Schlüssel neu laden'],
    ];
    for (const [reason, expected] of cases) {
      const out = composePushPayload('backup.failed', null, { reason });
      expect(out.body, `reason=${reason}`).toBe(expected);
    }
  });

  it('falls back to the generic backup body on an unknown reason', () => {
    const out = composePushPayload('backup.failed', null, { reason: 'not-a-real-reason' });
    expect(out.body).toBe('Backup konnte nicht abgeschlossen werden.');
  });

  it('renders disk.threshold_reached system event without an audit row', () => {
    const out = composePushPayload('disk.threshold_reached', null, {});
    expect(out.title).toBe('Speichergrenze erreicht');
    expect(out.body).toBe('Speichernutzung über Schwellwert.');
    expect(out.url).toBe('/daten');
  });

  it('points both system events at paths the route table actually serves', () => {
    // These URLs went to `/verwaltung` and `/verwaltung/backups`, which
    // no route defines. Nothing 404s — `viewFromPath` falls back to
    // kanban and the SPA handler serves index.html — so the only
    // symptom was the owner tapping a backup warning and landing on the
    // board. Asserted against the live route table so a future edit
    // cannot reintroduce a path that does not exist.
    const systemUrls = [
      composePushPayload('backup.failed', null, {}).url,
      composePushPayload('disk.threshold_reached', null, {}).url,
    ];
    for (const url of systemUrls) {
      expect(
        ROUTES.some((r) => r.path === url),
        `${url} is not a declared route`,
      ).toBe(true);
    }
  });

  it('renders the fill percentage into the disk.threshold_reached body', () => {
    const out = composePushPayload('disk.threshold_reached', null, {
      percent: 82,
      usedBytes: 1,
      quotaBytes: 2,
    });
    expect(out.body).toBe('Speicher zu 82% belegt.');
  });

  it('ignores a non-numeric percent and falls back to the generic disk body', () => {
    const out = composePushPayload('disk.threshold_reached', null, { percent: '82' });
    expect(out.body).toBe('Speichernutzung über Schwellwert.');
  });

  it('never produces an empty title or body — every code path renders strings', () => {
    // Defensive: the SW falls back to "Projekt-Manager" / "" when keys
    // are missing. AC-211 pins that the server always sends both, so a
    // regression that drops one would surface as an empty assertion
    // here rather than a silent UI fallback.
    const out = composePushPayload(
      'project.transition_forward',
      row({ entityLabel: null, payload: null }),
      null,
    );
    expect(out.title.length).toBeGreaterThan(0);
    expect(out.body.length).toBeGreaterThan(0);
  });
});
