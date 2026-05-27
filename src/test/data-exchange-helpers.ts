/**
 * Direct-service test helpers for the unified data-exchange surface.
 *
 * The text-leg HTTP routes (`GET /api/export`, `POST /api/import`) were
 * removed once the operator UI moved to the export/import JOB endpoints
 * (PR #235): nothing in production reached them — the import-job runner,
 * the export-job builder, and the seed all call `ExportService` /
 * `ImportService` directly. These helpers test the same live services the
 * jobs use, without a dead HTTP hop.
 *
 * Because the calls hit the service rather than a route, the service throws
 * on failure (the error carries `.code` / `.statusCode`) instead of
 * returning an HTTP envelope — failure cases assert via
 * `await expect(importEnvelope(...)).rejects.toMatchObject({ code, statusCode })`.
 * Success returns the `Envelope` / `ImportResult` / `DryRunPreview` directly.
 */

import type { AuthUser } from '../server/middleware/auth.js';
import type {
  Envelope,
  ImportOptions,
  ImportResult,
  DryRunPreview,
} from '../domain/dataExchange.js';
import type { AttachmentStorageClient } from '../server/storage/client.js';
import type { ServiceLogger } from '../server/services/Logger.js';
import { ExportService } from '../server/services/ExportService.js';
import { ImportService } from '../server/services/ImportService.js';
import { createStorageClient } from '../server/storage/client.js';
import { getEnv } from '../server/config/env.js';
import { getDb } from './api-helpers.js';

/**
 * Default operator identity for data-exchange service calls — an unscoped
 * owner, mirroring `request.user!` on the removed routes. `ExportService`
 * fail-fasts on a scoped caller (ADR-0019 tripwire); `ImportService` only
 * logs `caller.id`. The id is synthetic — no path persists the caller now
 * (the import-token machinery was removed in cc58946), so a well-formed
 * unscoped `AuthUser` is all that is required.
 */
export const TEST_OWNER: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'inhaber',
  displayName: 'Thomas Berger',
  roles: ['owner'],
  email: null,
  themePreference: 'system',
  pushMuted: false,
};

/** Silent logger — the routes passed `request.log`; tests don't assert on it. */
const SILENT_LOG: ServiceLogger = { info() {}, error() {} };

/**
 * Lazily-built storage client mirroring the route construction. Cached so
 * repeated imports in a file don't reopen a client per call. The override
 * attachment-hide path (issue #163) requires a non-null storage client; the
 * dry-run / empty-target paths never touch it.
 */
let cachedStorage: AttachmentStorageClient | null = null;
function defaultStorage(): AttachmentStorageClient {
  if (!cachedStorage) {
    const env = getEnv();
    cachedStorage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
      region: env.STORAGE_REGION,
    });
  }
  return cachedStorage;
}

/** Export the full business envelope (was `GET /api/export`). */
export async function exportEnvelope(caller: AuthUser = TEST_OWNER): Promise<Envelope> {
  return new ExportService(getDb()).export(caller);
}

/**
 * Restore an envelope (was `POST /api/import[?dry_run=&override=]`). Supplies a
 * real storage client + logger by default so the override path works without
 * per-test wiring; pass `storage` explicitly to inspect storage side effects
 * (issue #163), or `storage: null` to exercise the missing-collaborator guard.
 * Failure cases throw the service error — assert with `expect(...).rejects`.
 */
export async function importEnvelope(
  envelope: Envelope,
  opts: ImportOptions,
  options: {
    storage?: AttachmentStorageClient | null;
    log?: ServiceLogger;
    caller?: AuthUser | null;
  } = {},
): Promise<ImportResult | DryRunPreview> {
  const storage = options.storage !== undefined ? options.storage : defaultStorage();
  const log = options.log ?? SILENT_LOG;
  const caller = options.caller !== undefined ? options.caller : TEST_OWNER;
  return new ImportService(getDb(), storage).import(envelope, opts, log, caller);
}
