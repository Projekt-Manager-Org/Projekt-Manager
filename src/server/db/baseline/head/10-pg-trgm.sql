-- Enables the GIN trigram index audit_log_entity_label_trgm_idx
-- (ui/management.md §8.13.2 Aktivität substring search).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
