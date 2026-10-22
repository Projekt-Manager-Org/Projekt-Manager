/**
 * Shared bulk-download cap defaults.
 *
 * Single source of truth for the 20-files / 20-MB twin-cap documented in
 * architecture.md §12.2 and pinned by verification.md AC-415 and AC-435. Imported by
 * both the client-facing pipeline config (`attachmentPipeline.ts`,
 * consumed by `BinaryList.tsx` for the UX pre-check) and the server-facing
 * config (`attachmentConfig.ts`, which layers env overrides on top for
 * deployment-time tuning).
 *
 * Server is authoritative: it enforces via env override
 * (`ATTACHMENT_BULK_MAX_FILES`, `ATTACHMENT_BULK_MAX_BYTES`) in
 * `AttachmentService.resolveCaps()` and returns 422 on breach. Client
 * imports these for UX-side pre-checks only; a client-side mismatch on
 * overridden deployments is cosmetic, not a safety gap.
 *
 * Layer note: lives in config (not domain) so both `attachmentPipeline.ts`
 * and `attachmentConfig.ts` can import it without crossing the
 * config→domain boundary blocked by eslint CONFIG_BANNED.
 */

/** Bulk-download cap (file count). [C] */
export const BULK_DOWNLOAD_MAX_FILES_DEFAULT = 20;

/** Bulk-download cap (summed byte size). [C] */
export const BULK_DOWNLOAD_MAX_BYTES_DEFAULT = 20 * 1024 * 1024;
