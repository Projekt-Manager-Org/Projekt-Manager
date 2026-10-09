-- Pre-seed the single meta_backup_status row so the app always upserts
-- on the fixed singleton key (data-model.md §5.9, ADR-0020). Avoids a
-- first-write vs nth-write distinction in the repository layer.
INSERT INTO "meta_backup_status" ("singleton", "last_backup_ok") VALUES (TRUE, FALSE)
	ON CONFLICT ("singleton") DO NOTHING;
--> statement-breakpoint
-- Pre-seed the single company_profile row (data-model.md §5.17,
-- ADR-0026). The API exposes upsert (`PUT`) only — no `POST` /
-- `DELETE` path — so the row MUST exist before the first write.
-- Mandatory fields land empty; the issuance gate (AC-289 /
-- COMPANY_PROFILE_REQUIRED) refuses to issue until the owner fills
-- them via `PUT /api/company-profile`. The `id` defaults to
-- gen_random_uuid() so audit_log.entity_id (uuid NOT NULL, AC-302)
-- has a stable target without a hard-coded seed UUID. `singleton`
-- defaults to TRUE; the UNIQUE constraint on it caps the table at one
-- row.
INSERT INTO "company_profile" DEFAULT VALUES
	ON CONFLICT ("singleton") DO NOTHING;
