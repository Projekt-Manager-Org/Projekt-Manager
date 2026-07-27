-- Fixture rows for the Tier 1 round-trip (scripts/backup/verify-roundtrip.sh).
--
-- WHY THIS FILE EXISTS AT ALL: on an empty database every manifest
-- checksum is md5('') and every rowCount is 0, so `sourceManifest ==
-- restoreManifest` holds for a restore that produced literally nothing.
-- The round-trip would pass while proving nothing. Every assertion in the
-- script rests on these rows being present on both sides.
--
-- WHY timestamptz IS THE POINT: the manifest checksum is
-- `md5(row(t.*)::text)`, which serializes `timestamptz` through the
-- session TimeZone. The backup container runs TZ=Europe/Berlin (readable
-- cron logs), so the ephemeral verify cluster would inherit that and
-- render `+02` against a source rendering `+00` — the false Tier 1
-- mismatch that `-c TimeZone=UTC` in `buildPostgresArgv` exists to
-- prevent. With no populated timestamptz column anywhere, that override
-- could be deleted and this round-trip would still pass.
--
-- Values are explicit, never `now()`: a fixture that moves makes a failure
-- unreproducible. Both DST offsets appear on purpose (January = +01,
-- July = +02 in Europe/Berlin) so the pinning is exercised on each side
-- of the transition rather than only one.
--
-- Ordinary tables only — no attachments / invoices / storage rows. Those
-- carry bytes in the object store that this script does not provision,
-- and the manifest surface they'd add is the same md5-over-rows one the
-- tables below already cover.

BEGIN;

-- Composite-PK table: computeManifest orders by ("year", "kind"), so two
-- rows differing only in `kind` pin the multi-column ORDER BY path that a
-- single-column table cannot reach.
INSERT INTO "invoice_sequence" ("year", "kind", "next_value", "updated_at")
VALUES
  (2026, 'invoice', 42, '2026-01-14 08:30:00.125+00'),
  (2026, 'storno', 7, '2026-07-14 08:30:00.125+00');

INSERT INTO "users" (
  "id", "username", "display_name", "password_hash", "roles",
  "created_at", "updated_at", "last_login_at"
)
VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'roundtrip.owner',
    'Roundtrip Owner',
    -- Not a credential: no server ever authenticates against this DB. A
    -- syntactically valid argon2 string keeps the column honest.
    '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$0000000000000000000000000000000000000000000',
    ARRAY['owner'],
    '2026-01-14 08:30:00.125+00',
    '2026-07-14 12:45:59.987+00',
    '2026-07-14 12:45:59.987+00'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'roundtrip.worker',
    'Roundtrip Worker',
    '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$1111111111111111111111111111111111111111111',
    ARRAY['worker'],
    '2026-01-14 09:00:00+00',
    '2026-01-14 09:00:00+00',
    NULL
  );

INSERT INTO "customers" (
  "id", "name", "email", "address", "created_at", "updated_at", "created_by"
)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  'Roundtrip Kunde GmbH',
  'kunde@example.invalid',
  -- jsonb alongside timestamptz: `row(t.*)::text` serializes both, so a
  -- restore that lost either shows up as a checksum divergence.
  '{"street":"Teststraße 1","city":"Berlin","zip":"10115"}'::jsonb,
  '2026-01-14 08:30:00.125+00',
  '2026-07-14 12:45:59.987+00',
  '11111111-1111-4111-8111-111111111111'
);

INSERT INTO "projects" (
  "id", "number", "title", "status", "status_changed_at", "customer_id",
  "planned_start", "planned_end", "estimated_value",
  "created_at", "updated_at", "created_by"
)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  'P-2026-0001',
  'Rundlauf-Prüfprojekt',
  'in_arbeit',
  '2026-07-14 12:45:59.987+00',
  '33333333-3333-4333-8333-333333333333',
  '2026-07-01',
  '2026-08-31',
  -- numeric(12,2): a restore that widened or truncated the scale changes
  -- the text serialization and therefore the checksum.
  12345.67,
  '2026-01-14 08:30:00.125+00',
  '2026-07-14 12:45:59.987+00',
  '11111111-1111-4111-8111-111111111111'
);

-- audit_log carries the GIN trigram index on `entity_label`, so restoring
-- these rows is what forces `CREATE EXTENSION pg_trgm` out of the dump and
-- into the ephemeral cluster — the postgresql17-contrib dependency
-- Dockerfile.backup calls out. Without a row here the index is still
-- created, but an empty one; keeping rows makes the failure mode
-- unambiguous.
-- One row per `actor_kind`, because `audit_log_actor_shape` makes them
-- structurally different: 'user' carries actor_id and forbids
-- actor_reason, 'system' forbids actor_id and requires a non-empty
-- actor_reason. Both shapes in the fixture means the dump has to carry
-- both through the restore.
INSERT INTO "audit_log" (
  "id", "created_at", "actor_id", "actor_kind", "actor_reason",
  "entity_type", "entity_id", "entity_label", "action", "payload"
)
VALUES
  (
    '55555555-5555-4555-8555-555555555555',
    '2026-01-14 08:30:00.125+00',
    '11111111-1111-4111-8111-111111111111',
    'user',
    NULL,
    'project',
    '44444444-4444-4444-8444-444444444444',
    'Rundlauf-Prüfprojekt',
    'created',
    '{"number":"P-2026-0001"}'::jsonb
  ),
  (
    '66666666-6666-4666-8666-666666666666',
    '2026-07-14 12:45:59.987+00',
    NULL,
    'system',
    'tier-1 round-trip fixture',
    'project',
    '44444444-4444-4444-8444-444444444444',
    'Rundlauf-Prüfprojekt',
    'status_changed',
    '{"from":"geplant","to":"in_arbeit"}'::jsonb
  );

COMMIT;

-- Fail loudly rather than let the script assert against a manifest of
-- empty tables. `RAISE EXCEPTION` rather than psql's `\if` + `\quit`:
-- `\quit` takes no exit-status argument, so `\quit 1` warns "extra
-- argument \"1\" ignored" and psql still exits 0 — the caller's `set -e`
-- sails past a guard that printed its own failure message. A server-side
-- error is what ON_ERROR_STOP actually acts on.
DO $$
BEGIN
  IF (SELECT count(*) FROM "audit_log") <> 2 THEN
    RAISE EXCEPTION 'seed did not land — audit_log does not hold the 2 fixture rows';
  END IF;
END $$;
