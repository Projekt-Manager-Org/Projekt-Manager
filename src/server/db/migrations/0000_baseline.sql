-- Enables the GIN trigram index on audit_log.entity_label below
-- (ui/management.md §8.13.2 Aktivität substring search). Drizzle-kit
-- does not emit CREATE EXTENSION statements; added by hand at baseline
-- regen time, same mechanism as the meta_backup_status pre-seed INSERT
-- and the project_storage_usage trigger DDL.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"original_key" text NOT NULL,
	"thumb_key" text,
	"thumb_size_bytes" bigint,
	"has_thumbnail" boolean DEFAULT false NOT NULL,
	"ciphertext_size_bytes" bigint,
	"ciphertext_thumb_size_bytes" bigint,
	"version_id" text,
	"thumb_version_id" text,
	"wrapped_dek" text,
	"wrapped_thumb_dek" text,
	"wrapped_dek_version" smallint NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "attachments_valid_status" CHECK ("attachments"."status" IN ('pending', 'ready', 'hidden')),
	CONSTRAINT "attachments_valid_kind" CHECK ("attachments"."kind" IN ('photo', 'binary')),
	CONSTRAINT "attachments_valid_label" CHECK ("attachments"."label" IN ('angebot', 'auftragsbestaetigung', 'rechnung', 'aufmass', 'foto', 'sonstiges')),
	CONSTRAINT "attachments_valid_mime_type" CHECK ("attachments"."mime_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
	CONSTRAINT "attachments_wrapped_dek_required_when_ready" CHECK ("attachments"."status" != 'ready' OR ("attachments"."wrapped_dek" IS NOT NULL AND "attachments"."ciphertext_size_bytes" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_reason" text,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_label" text,
	"ancestor_entity_type" text,
	"ancestor_entity_id" uuid,
	"ancestor_entity_label" text,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text,
	CONSTRAINT "audit_log_actor_kind_valid" CHECK ("audit_log"."actor_kind" IN ('user', 'system')),
	CONSTRAINT "audit_log_entity_type_valid" CHECK ("audit_log"."entity_type" IN ('project', 'customer', 'user', 'project_worker', 'attachment', 'invoice', 'company_profile', 'data_import')),
	CONSTRAINT "audit_log_ancestor_type_valid" CHECK ("audit_log"."ancestor_entity_type" IS NULL
          OR "audit_log"."ancestor_entity_type" IN ('project', 'customer', 'user', 'project_worker', 'attachment', 'invoice', 'company_profile', 'data_import')),
	CONSTRAINT "audit_log_ancestor_pair" CHECK (("audit_log"."ancestor_entity_type" IS NULL AND "audit_log"."ancestor_entity_id" IS NULL)
          OR ("audit_log"."ancestor_entity_type" IS NOT NULL AND "audit_log"."ancestor_entity_id" IS NOT NULL)),
	CONSTRAINT "audit_log_actor_shape" CHECK ((
        ("audit_log"."actor_kind" = 'user'
          AND "audit_log"."actor_reason" IS NULL)
        OR
        ("audit_log"."actor_kind" = 'system'
          AND "audit_log"."actor_id" IS NULL
          AND "audit_log"."actor_reason" IS NOT NULL
          AND length(trim("audit_log"."actor_reason")) > 0)
      ))
);
--> statement-breakpoint
CREATE TABLE "company_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"address" jsonb DEFAULT '{"street":"","zip":"","city":""}'::jsonb NOT NULL,
	"tax_id" text DEFAULT '' NOT NULL,
	"ust_id" text,
	"iban" text,
	"accent_color" text,
	"footer_text" text,
	"logo_binary_descriptor_id" uuid,
	"default_tax_mode" text DEFAULT 'standard' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "company_profile_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "company_profile_singleton" CHECK ("company_profile"."singleton" = true),
	CONSTRAINT "company_profile_default_tax_mode_valid" CHECK ("company_profile"."default_tax_mode" IN ('standard', 'kleinunternehmer', 'reverse_charge'))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"phone" varchar(100),
	"email" varchar(255),
	"address" jsonb,
	"ust_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "data_exchange_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"files_total" bigint DEFAULT 0 NOT NULL,
	"files_done" bigint DEFAULT 0 NOT NULL,
	"bytes_total" bigint DEFAULT 0 NOT NULL,
	"bytes_done" bigint DEFAULT 0 NOT NULL,
	"current_item" text,
	"archive_ref" text,
	"error_detail" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "data_exchange_job_kind_valid" CHECK ("data_exchange_job"."kind" IN ('export', 'import')),
	CONSTRAINT "data_exchange_job_status_valid" CHECK ("data_exchange_job"."status" IN ('pending', 'running', 'ready', 'failed')),
	CONSTRAINT "data_exchange_job_counts_non_negative" CHECK ("data_exchange_job"."files_total" >= 0 AND "data_exchange_job"."files_done" >= 0 AND "data_exchange_job"."bytes_total" >= 0 AND "data_exchange_job"."bytes_done" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_sequence" (
	"year" smallint NOT NULL,
	"kind" text NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_sequence_year_kind_pk" PRIMARY KEY("year","kind"),
	CONSTRAINT "invoice_sequence_kind_valid" CHECK ("invoice_sequence"."kind" IN ('invoice', 'storno'))
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"number" text,
	"issue_date" date,
	"performance_date" date,
	"tax_mode" text DEFAULT 'standard' NOT NULL,
	"profile" text DEFAULT 'zugferd-en16931' NOT NULL,
	"issuer" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipient" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cancellation_of" uuid,
	"cancellation_reason" text,
	"rendered_pdf_binary_descriptor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "invoices_status_valid" CHECK ("invoices"."status" IN ('draft', 'issued', 'cancelled')),
	CONSTRAINT "invoices_tax_mode_valid" CHECK ("invoices"."tax_mode" IN ('standard', 'kleinunternehmer', 'reverse_charge')),
	CONSTRAINT "invoices_profile_valid" CHECK ("invoices"."profile" IN ('zugferd-en16931')),
	CONSTRAINT "invoices_number_format" CHECK ("invoices"."number" IS NULL
          OR "invoices"."number" ~ '^(RE|ST)-[0-9]{4}-[0-9]{4,}$'),
	CONSTRAINT "invoices_number_required_when_not_draft" CHECK (("invoices"."status" = 'draft' AND "invoices"."number" IS NULL)
          OR ("invoices"."status" IN ('issued', 'cancelled') AND "invoices"."number" IS NOT NULL)),
	CONSTRAINT "invoices_cancellation_pair" CHECK (("invoices"."cancellation_of" IS NULL AND ("invoices"."number" IS NULL OR "invoices"."number" LIKE 'RE-%'))
          OR ("invoices"."cancellation_of" IS NOT NULL AND "invoices"."number" LIKE 'ST-%'))
);
--> statement-breakpoint
CREATE TABLE "meta_backup_status" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"last_backup_at" timestamp with time zone,
	"last_backup_ok" boolean DEFAULT false NOT NULL,
	"last_drill_at" timestamp with time zone,
	"last_drill_ok" boolean,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_backup_status_singleton" CHECK ("meta_backup_status"."singleton" = true)
);
--> statement-breakpoint
CREATE TABLE "notification_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_class" text NOT NULL,
	"state_filter" text,
	"recipient_spec" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "project_storage_usage" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"space_ready_bytes" bigint DEFAULT 0 NOT NULL,
	"space_hidden_bytes" bigint DEFAULT 0 NOT NULL,
	"ciphertext_ready_bytes" bigint DEFAULT 0 NOT NULL,
	"ciphertext_hidden_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "project_storage_usage_non_negative" CHECK ("project_storage_usage"."space_ready_bytes" >= 0 AND "project_storage_usage"."space_hidden_bytes" >= 0 AND "project_storage_usage"."ciphertext_ready_bytes" >= 0 AND "project_storage_usage"."ciphertext_hidden_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_workers" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "project_workers_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(20) NOT NULL,
	"title" varchar(500) NOT NULL,
	"status" varchar(50) DEFAULT 'anfrage' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_address" jsonb,
	"planned_start" date,
	"planned_end" date,
	"estimated_value" numeric(12, 2),
	"notes" text,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "projects_number_unique" UNIQUE("number"),
	CONSTRAINT "projects_end_requires_start" CHECK ("projects"."planned_end" IS NULL OR "projects"."planned_start" IS NOT NULL),
	CONSTRAINT "projects_end_not_before_start" CHECK ("projects"."planned_end" IS NULL OR "projects"."planned_start" IS NULL OR "projects"."planned_end" >= "projects"."planned_start"),
	CONSTRAINT "projects_valid_status" CHECK ("projects"."status" IN ('anfrage', 'angebot', 'beauftragt', 'geplant', 'in_arbeit', 'abnahme', 'rechnung_faellig', 'abgerechnet', 'erledigt'))
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"email" varchar(255),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"theme_preference" text DEFAULT 'system' NOT NULL,
	"push_muted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_valid_theme_preference" CHECK ("users"."theme_preference" IN ('light', 'dark', 'system'))
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exchange_job" ADD CONSTRAINT "data_exchange_job_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cancellation_of_invoices_id_fk" FOREIGN KEY ("cancellation_of") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rule" ADD CONSTRAINT "notification_rule_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rule" ADD CONSTRAINT "notification_rule_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_storage_usage" ADD CONSTRAINT "project_storage_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workers" ADD CONSTRAINT "project_workers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workers" ADD CONSTRAINT "project_workers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_project_id_idx" ON "attachments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "attachments_created_by_idx" ON "attachments" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_original_key_uq" ON "attachments" USING btree ("original_key");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_ancestor_idx" ON "audit_log" USING btree ("ancestor_entity_type","ancestor_entity_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_label_trgm_idx" ON "audit_log" USING gin ("entity_label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_data_exchange_job_status" ON "data_exchange_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_data_exchange_job_created_at" ON "data_exchange_job" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "invoices_project_id_idx" ON "invoices" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoices_cancellation_of_idx" ON "invoices" USING btree ("cancellation_of");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("number") WHERE "invoices"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_project_workers_user_id" ON "project_workers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_projects_status" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_projects_status_changed_at" ON "projects" USING btree ("status_changed_at");--> statement-breakpoint
CREATE INDEX "idx_projects_customer_id" ON "projects" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_user_endpoint_uq" ON "push_subscriptions" USING btree ("user_id","endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires_at" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "sessions" USING btree ("user_id");
-- Pre-seed the single row so the app always upserts on the fixed singleton
-- key (data-model.md §5.9, ADR-0020). Avoids a first-write vs nth-write
-- distinction in the repository layer.
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
--> statement-breakpoint
-- ---------------------------------------------------------------
-- Project storage usage — trigger-maintained side table
-- (data-model.md §5.14, ARCHITECTURE.md "Storage usage —
-- trigger-maintained side table", AC-263).
--
-- Drizzle-kit does not emit CREATE FUNCTION / CREATE TRIGGER; both
-- pairs below are appended by hand at baseline regen time, same
-- mechanism as the pg_trgm extension and the meta_backup_status
-- seed INSERT. A contributor who regenerates the baseline must
-- reapply this block alongside the others — the convention is
-- documented in ARCHITECTURE.md and the regression class is "missed
-- to reapply hand-edited tail content."
-- ---------------------------------------------------------------

-- Trigger 1: seed a zero usage row for every new project so the
-- delta trigger only ever issues UPDATEs (no upsert path needed).
CREATE OR REPLACE FUNCTION projects_storage_usage_init_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO project_storage_usage (project_id) VALUES (NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER projects_storage_usage_init
AFTER INSERT ON projects
FOR EACH ROW
EXECUTE FUNCTION projects_storage_usage_init_fn();
--> statement-breakpoint
-- Trigger 2: maintain the four-bucket view in lockstep with the
-- attachment lifecycle. Every transition (init pending, complete to
-- ready, hide ready→hidden, restore hidden→ready, orphan-reaper
-- delete pending, hidden-reaper delete hidden) lands on the
-- attachments table; a single AFTER row trigger covers all of them
-- by computing OLD-vs-NEW deltas and applying them in one UPDATE.
--
-- Cascade short-circuit: a project hard-delete cascades to
-- attachments via FK. While that cascade runs, this trigger fires
-- with TG_OP='DELETE' at depth 2 (the projects DELETE is at depth
-- 1, the cascaded attachments DELETE is the nested call). The
-- side-table row is being cascade-removed in the same transaction,
-- so the UPDATE would target a row that no longer exists; skip it.
-- Narrowed to TG_OP='DELETE' so any future nested non-DELETE
-- context still updates the counter — drift on a missed nested
-- update is recoverable via reconciliation; silent corruption on a
-- nested update we tried to skip is not.
CREATE OR REPLACE FUNCTION attachments_storage_usage_delta_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  d_space_ready bigint := 0;
  d_space_hidden bigint := 0;
  d_ciphertext_ready bigint := 0;
  d_ciphertext_hidden bigint := 0;
  old_plain bigint := 0;
  new_plain bigint := 0;
  old_cipher bigint := 0;
  new_cipher bigint := 0;
  target_project uuid;
BEGIN
  -- Cascade short-circuit: project DELETE → cascades to attachments.
  -- The side-table row is being removed via FK cascade in the same
  -- transaction, so the UPDATE is wasted work and would fail to
  -- match. Pinned at TG_OP='DELETE' (data-model.md §5.14).
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  -- OLD-side contribution (status before the change). Pending rows
  -- contribute zero on every axis; only ready/hidden carry bytes.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.status IN ('ready', 'hidden') THEN
      old_plain := OLD.size_bytes + COALESCE(OLD.thumb_size_bytes, 0);
      old_cipher := COALESCE(OLD.ciphertext_size_bytes, 0)
                  + COALESCE(OLD.ciphertext_thumb_size_bytes, 0);
      IF OLD.status = 'ready' THEN
        d_space_ready := d_space_ready - old_plain;
        d_ciphertext_ready := d_ciphertext_ready - old_cipher;
      ELSE
        d_space_hidden := d_space_hidden - old_plain;
        d_ciphertext_hidden := d_ciphertext_hidden - old_cipher;
      END IF;
    END IF;
  END IF;

  -- NEW-side contribution (status after the change). Same exclusion
  -- of pending rows as the OLD branch.
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.status IN ('ready', 'hidden') THEN
      new_plain := NEW.size_bytes + COALESCE(NEW.thumb_size_bytes, 0);
      new_cipher := COALESCE(NEW.ciphertext_size_bytes, 0)
                  + COALESCE(NEW.ciphertext_thumb_size_bytes, 0);
      IF NEW.status = 'ready' THEN
        d_space_ready := d_space_ready + new_plain;
        d_ciphertext_ready := d_ciphertext_ready + new_cipher;
      ELSE
        d_space_hidden := d_space_hidden + new_plain;
        d_ciphertext_hidden := d_ciphertext_hidden + new_cipher;
      END IF;
    END IF;
  END IF;

  -- No-op statements (label rename, pending insert, pending delete)
  -- compute zero deltas across all four counters; skip the UPDATE.
  IF d_space_ready = 0 AND d_space_hidden = 0
     AND d_ciphertext_ready = 0 AND d_ciphertext_hidden = 0 THEN
    RETURN NULL;
  END IF;

  -- INSERT/UPDATE keys on NEW.project_id; DELETE keys on OLD. The
  -- single UPDATE atomically applies all four deltas — partial
  -- application is impossible (data-model.md §5.14).
  IF TG_OP = 'DELETE' THEN
    target_project := OLD.project_id;
  ELSE
    target_project := NEW.project_id;
  END IF;

  UPDATE project_storage_usage
  SET space_ready_bytes = space_ready_bytes + d_space_ready,
      space_hidden_bytes = space_hidden_bytes + d_space_hidden,
      ciphertext_ready_bytes = ciphertext_ready_bytes + d_ciphertext_ready,
      ciphertext_hidden_bytes = ciphertext_hidden_bytes + d_ciphertext_hidden
  WHERE project_id = target_project;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attachments_storage_usage_delta
AFTER INSERT OR UPDATE OR DELETE ON attachments
FOR EACH ROW
EXECUTE FUNCTION attachments_storage_usage_delta_fn();
--> statement-breakpoint
-- ---------------------------------------------------------------
-- Invoices — issued-row immutability (data-model.md §6.14, AC-294).
--
-- Persistence-layer backstop on direct SQL writes that bypass the
-- route layer (seed scripts, migrations, manual SQL). The route
-- layer rejects with INVOICE_FROZEN; this trigger is the
-- defense-in-depth layer ADR-0026 names as impl-defined.
--
-- Permitted mutations on an issued row:
--   - status: 'issued' → 'cancelled'  (the cancellation flip)
--   - updated_at, updated_by          (audit metadata bump)
--
-- `cancellation_reason` is NOT in the allow-list. Per
-- data-model.md §5.15 ("null on non-Storno rows; frozen on the
-- Storno row at issuance of the cancellation") and
-- `invoices-cancel.test.ts:313` (`cancellation_reason` is listed in
-- the original's `immutableFields` set), the original invoice's
-- `cancellation_reason` stays NULL forever. The reason text is
-- carried by the Storno sibling row, which is a fresh INSERT — this
-- trigger fires only on UPDATE, so the Storno's `cancellation_reason`
-- is set without touching the trigger.
--
-- Every other column UPDATE on an issued row is rejected. A
-- 'cancelled' row is fully frozen — no further UPDATEs at all.
-- Drafts are unconstrained; the route layer manages their lifecycle.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoices_enforce_immutability_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Drafts: every column is mutable; the route layer is the only
  -- gate. Short-circuit before the per-column comparisons.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Cancelled rows: write-once, no further mutation. The cancel
  -- transaction flips status on the original; once cancelled, the
  -- row is fully frozen.
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'invoices: cancelled rows are write-once at the persistence layer (data-model.md §6.14)',
      ERRCODE = 'P0001';
  END IF;

  -- Issued rows: only the cancellation-flip path (status, updated_at,
  -- updated_by) may mutate. Every other column must be byte-equal
  -- between OLD and NEW.
  IF OLD.status = 'issued' THEN
    -- Status: must stay 'issued' OR flip to 'cancelled'.
    IF NEW.status NOT IN ('issued', 'cancelled') THEN
      RAISE EXCEPTION USING
        MESSAGE = 'invoices: issued rows may only transition status to cancelled (data-model.md §6.14)',
        ERRCODE = 'P0001';
    END IF;

    -- Pin every snapshot column. A regression that adds a new
    -- snapshot column without listing it here would silently
    -- mutate; the column-by-column equality check is the strictest
    -- shape the mechanism can take.
    IF NEW.id              <> OLD.id              THEN RAISE EXCEPTION 'invoices: id frozen on issued rows'              USING ERRCODE = 'P0001'; END IF;
    IF NEW.project_id      <> OLD.project_id      THEN RAISE EXCEPTION 'invoices: project_id frozen on issued rows'      USING ERRCODE = 'P0001'; END IF;
    IF NEW.number          <> OLD.number          THEN RAISE EXCEPTION 'invoices: number frozen on issued rows'          USING ERRCODE = 'P0001'; END IF;
    IF NEW.issue_date      <> OLD.issue_date      THEN RAISE EXCEPTION 'invoices: issue_date frozen on issued rows'      USING ERRCODE = 'P0001'; END IF;
    IF NEW.performance_date IS DISTINCT FROM OLD.performance_date
       THEN RAISE EXCEPTION 'invoices: performance_date frozen on issued rows' USING ERRCODE = 'P0001'; END IF;
    IF NEW.tax_mode        <> OLD.tax_mode        THEN RAISE EXCEPTION 'invoices: tax_mode frozen on issued rows'        USING ERRCODE = 'P0001'; END IF;
    IF NEW.profile         <> OLD.profile         THEN RAISE EXCEPTION 'invoices: profile frozen on issued rows'         USING ERRCODE = 'P0001'; END IF;
    IF NEW.issuer::text    <> OLD.issuer::text    THEN RAISE EXCEPTION 'invoices: issuer frozen on issued rows'          USING ERRCODE = 'P0001'; END IF;
    IF NEW.recipient::text <> OLD.recipient::text THEN RAISE EXCEPTION 'invoices: recipient frozen on issued rows'       USING ERRCODE = 'P0001'; END IF;
    IF NEW.lines::text     <> OLD.lines::text     THEN RAISE EXCEPTION 'invoices: lines frozen on issued rows'           USING ERRCODE = 'P0001'; END IF;
    IF NEW.totals::text    <> OLD.totals::text    THEN RAISE EXCEPTION 'invoices: totals frozen on issued rows'          USING ERRCODE = 'P0001'; END IF;
    IF NEW.cancellation_of IS DISTINCT FROM OLD.cancellation_of
       THEN RAISE EXCEPTION 'invoices: cancellation_of frozen on issued rows' USING ERRCODE = 'P0001'; END IF;
    IF NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
       THEN RAISE EXCEPTION 'invoices: cancellation_reason frozen on the original (written only on the Storno sibling, a fresh INSERT)' USING ERRCODE = 'P0001'; END IF;
    IF NEW.rendered_pdf_binary_descriptor_id IS DISTINCT FROM OLD.rendered_pdf_binary_descriptor_id
       THEN RAISE EXCEPTION 'invoices: rendered_pdf_binary_descriptor_id frozen on issued rows' USING ERRCODE = 'P0001'; END IF;
    IF NEW.created_at      <> OLD.created_at      THEN RAISE EXCEPTION 'invoices: created_at frozen on issued rows'      USING ERRCODE = 'P0001'; END IF;
    IF NEW.created_by      IS DISTINCT FROM OLD.created_by
       THEN RAISE EXCEPTION 'invoices: created_by frozen on issued rows' USING ERRCODE = 'P0001'; END IF;
    -- updated_at, updated_by are the only mutable columns on the
    -- issued→cancelled path; status is checked above.
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_enforce_immutability
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION invoices_enforce_immutability_fn();
--> statement-breakpoint
-- ---------------------------------------------------------------
-- Company profile — singleton DELETE guard (AC-300).
--
-- The CHECK on (singleton = true) plus the UNIQUE on `singleton`
-- caps the row count at one, but a DELETE leaves zero rows — also
-- not a valid state for the singleton invariant (data-model.md
-- §5.17). The application API exposes only GET + PUT; this trigger
-- is the DB-layer backstop on direct DELETEs (seed scripts,
-- migrations, manual SQL).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION company_profile_block_delete_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = 'company_profile: the singleton row cannot be deleted (data-model.md §5.17, ADR-0026)',
    ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_profile_block_delete
BEFORE DELETE ON company_profile
FOR EACH ROW
EXECUTE FUNCTION company_profile_block_delete_fn();
