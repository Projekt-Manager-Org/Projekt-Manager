/**
 * Architecture-level invariants for the attachment subsystem.
 *
 *   - AC-179 Part 2: the attachment table is in the audited-table set
 *     the CI check (`scripts/check-audit-mutations.sh`) scans. The
 *     check derives its set from `AUDIT_ENTITY_TO_TABLE` via
 *     `scripts/print-audited-tables.ts`. `attachment` is a first-class
 *     member of `AuditEntityType` (data-model.md §5.10), so the map
 *     entry + derivation carry the table into the scan automatically —
 *     no special-case append needed. A new audited table that ships
 *     without observing the mutation surface is exactly the fail-open
 *     that AC-179 forbids.
 *
 *   Design-conformance gates for ADR-0024 / ADR-0022 (the VPS stays
 *   out of the attachment bytes path; no AC — the property is not
 *   observable at the product boundary):
 *
 *   - No attachment route handler accepts a raw/multipart
 *     body. The upload path is presigned-PUT direct-to-storage; the
 *     only attachment endpoints on the app are init, complete, delete,
 *     list, download-url, bulk-fetch — all JSON control plane.
 *     "No byte traffic through the app" is load-bearing for module
 *     scalability and is pinned by a structural assertion parallel to
 *     AC-179.
 *
 *   - No attachment route handler streams ciphertext bytes
 *     to or from object storage. Under e2e (ADR-0024) the server
 *     handles only metadata, the wrapped envelope, and the unwrapped
 *     DEK during `download-url` / `bulk-fetch`. A handler that
 *     proxied ciphertext (e.g. `GetObjectCommand` → response.Body →
 *     reply.send) would put the VPS back in the data path and undo
 *     the e2e refactor. Parallel to the inbound gate; together
 *     they pin "the app handles only the control plane".
 *
 * Both assertions are structural, not behavioral. They run without
 * startApp() — both inspect source / config directly.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

// ---------------------------------------------------------------------
// AC-179 Part 2 — attachment table in the audited-table surface.
// ---------------------------------------------------------------------

describe('AC-179: attachment table wired into the audit-mutation architecture check', () => {
  it('the AuditEntityType enum includes `attachment` as a first-class member', async () => {
    // Promoting `attachment` into the enum is what drives the audited-
    // table derivation in scripts/print-audited-tables.ts. Prior to this
    // promotion the table was appended by hand in check-audit-mutations.sh —
    // a workaround the enum change eliminates.
    const schemaModule = (await import('../db/schema.js')) as Record<string, unknown>;
    const entityTypes = schemaModule.AUDIT_ENTITY_TYPES as readonly string[];
    expect(entityTypes).toContain('attachment');
  });

  it('the audited-table set exposed to scripts/check-audit-mutations.sh includes `attachments`', async () => {
    // The audit check derives its scan set from the AUDIT_ENTITY_TO_TABLE
    // map. With `attachment` in AuditEntityType, the Record<AuditEntityType, …>
    // satisfies clause forces the map entry — the `attachments` table is
    // picked up automatically. A new audited table that ships without
    // observing its mutation surface is the fail-open this check forbids.
    const schemaModule = (await import('../db/schema.js')) as Record<string, unknown>;
    const map = schemaModule.AUDIT_ENTITY_TO_TABLE as Record<
      string,
      { sqlName: string; drizzleExport: string }
    >;
    const sqlNames = Object.values(map).map((v) => v.sqlName);
    expect(sqlNames).toContain('attachments');
  });

  it('the Drizzle export set exposed to the check includes the `attachments` table', async () => {
    const schemaModule = (await import('../db/schema.js')) as Record<string, unknown>;
    const map = schemaModule.AUDIT_ENTITY_TO_TABLE as Record<
      string,
      { sqlName: string; drizzleExport: string }
    >;
    const drizzleExports = Object.values(map).map((v) => v.drizzleExport);
    expect(drizzleExports).toContain('attachments');
  });

  it('the reaper path (src/server/services/attachment-orphan-reaper.ts) is allowlisted in check-audit-mutations.sh', () => {
    // The spec names the reaper as an allowlisted bypass (it deletes
    // attachment rows outside mutate() — pending orphans never entered
    // the domain, so there is no audit event to emit). An allowlist
    // entry must land with the reaper.
    const scriptSrc = readSource('scripts/check-audit-mutations.sh');
    expect(scriptSrc).toContain('src/server/services/attachment-orphan-reaper.ts');
  });
});

// ---------------------------------------------------------------------
// No byte proxy through the app (inbound; ADR-0024).
// ---------------------------------------------------------------------

describe('no attachment route accepts a raw/multipart body', () => {
  const ROUTES_SRC = readSource('src/server/routes/attachments.ts');

  it('the attachment routes file imports no multipart parser', () => {
    // @fastify/multipart would register parsers for multipart/form-data
    // and turn Fastify into a byte proxy for upload payloads. This gate
    // bans any such dependency on the attachment surface.
    expect(ROUTES_SRC).not.toContain('@fastify/multipart');
    expect(ROUTES_SRC).not.toContain('fastify-multipart');
    expect(ROUTES_SRC).not.toContain('fastify-formidable');
    expect(ROUTES_SRC).not.toContain('busboy');
  });

  it('the attachment routes file does not register a raw or octet-stream content-type parser', () => {
    // addContentTypeParser with octet-stream or wildcard would accept
    // arbitrary request bodies. The JSON control plane is the only
    // admissible surface.
    expect(ROUTES_SRC).not.toMatch(/addContentTypeParser\s*\(\s*['"]application\/octet-stream/);
    expect(ROUTES_SRC).not.toMatch(/addContentTypeParser\s*\(\s*['"]multipart\//);
    expect(ROUTES_SRC).not.toMatch(/addContentTypeParser\s*\(\s*['"]\*\/\*/);
    // `addContentTypeParser` with the first argument being a plain
    // bare "'*'" wildcard is equally broad — catch that too.
    expect(ROUTES_SRC).not.toMatch(/addContentTypeParser\s*\(\s*'\*'/);
  });

  it('only the eight documented endpoints are registered under /api/projects/:id/attachments', () => {
    // The control plane per ADR-0024:
    //   GET    /api/projects/:id/attachments                             (list — ready only)
    //   POST   /api/projects/:id/attachments/init                        (init)
    //   POST   /api/projects/:id/attachments/:attId/complete             (complete)
    //   DELETE /api/projects/:id/attachments/:attId                      (soft-hide)
    //   GET    /api/projects/:id/attachments/:attId/download-url         (download URL + DEK material)
    //   POST   /api/projects/:id/attachments/bulk-fetch                  (per-file URLs + DEK material)
    //   GET    /api/projects/:id/attachments/trash                       (Papierkorb listing)
    //   POST   /api/projects/:id/attachments/:attId/restore              (Papierkorb restore)
    //
    // The pre-e2e `bulk-download` route is gone (single zip URL, server-
    // side archive). It is replaced by `bulk-fetch` per ADR-0024 — the
    // browser receives per-file presigned-GETs + DEK material and
    // assembles the streaming zip locally.
    //
    // Pinning the registrations here prevents a subsequent PR from
    // adding a 9th route that quietly accepts bytes.
    const methodPathRegistrations = [
      /app\.get\s*\(\s*['"]\/api\/projects\/:id\/attachments['"]/,
      /app\.post\s*\(\s*['"]\/api\/projects\/:id\/attachments\/init['"]/,
      /app\.post\s*\(\s*['"]\/api\/projects\/:id\/attachments\/:attId\/complete['"]/,
      /app\.delete\s*\(\s*['"]\/api\/projects\/:id\/attachments\/:attId['"]/,
      /app\.get\s*\(\s*['"]\/api\/projects\/:id\/attachments\/:attId\/download-url['"]/,
      /app\.post\s*\(\s*['"]\/api\/projects\/:id\/attachments\/bulk-fetch['"]/,
      /app\.get\s*\(\s*['"]\/api\/projects\/:id\/attachments\/trash['"]/,
      /app\.post\s*\(\s*['"]\/api\/projects\/:id\/attachments\/:attId\/restore['"]/,
    ];
    for (const re of methodPathRegistrations) {
      expect(ROUTES_SRC).toMatch(re);
    }

    // No other verb-method combinations on an `/api/projects/:id/attachments`
    // path. A 9th endpoint is a regression — either a genuine new
    // capability (which needs its own AC + review) or a byte-proxy slip.
    const attachmentRegistrationCount = (
      ROUTES_SRC.match(
        /app\.(get|post|put|patch|delete)\s*\(\s*['"]\/api\/projects\/:id\/attachments/g,
      ) ?? []
    ).length;
    expect(attachmentRegistrationCount).toBe(methodPathRegistrations.length);
  });

  it('the attachment routes file does not declare a raw-body route config', () => {
    // Fastify exposes a route-level `rawBody: true` or `bodyLimit: <large>`
    // that lets a handler receive arbitrary bytes. Neither is admissible
    // on the attachment surface. `bodyLimit` is a number — we check for
    // the presence of either verbatim string in the routes file.
    expect(ROUTES_SRC).not.toMatch(/rawBody\s*:\s*true/);
    // A route setting bodyLimit to an arbitrary-large number is another
    // proxy-smell; the JSON control plane never needs it.
    expect(ROUTES_SRC).not.toMatch(/bodyLimit\s*:\s*\d{7,}/);
  });

  it('the retired bulk-download route is gone (ADR-0024 — replaced by bulk-fetch)', () => {
    // The pre-e2e `bulk-download` route returned a single presigned GET
    // to a server-archived zip. Under e2e the server cannot archive
    // ciphertext (it would force an unwrap-and-handle-plaintext path)
    // — the route retires and its replacement `bulk-fetch` returns
    // per-file URLs + DEK material for the browser to assemble locally.
    // A regression that re-introduces the old route would re-introduce
    // the data-path violation ADR-0024 closed.
    expect(ROUTES_SRC).not.toMatch(/['"]\/api\/projects\/:id\/attachments\/bulk-download['"]/);
  });
});

// ---------------------------------------------------------------------
// No app-process bytes traffic for ciphertext (outbound; ADR-0024).
//
// Mirrors the inbound gate on the read side: the app must never read or proxy
// attachment ciphertext bytes. Under e2e (ADR-0024) the only data the
// server touches is the metadata row, the wrapped envelope, and the
// per-request unwrapped DEK during `download-url` / `bulk-fetch`. A
// handler that piped a `GetObjectCommand` response body into a Fastify
// reply would put the VPS back in the data path and undo the refactor.
//
// Source-text scan over `routes/attachments.ts` (parallel to the inbound gate).
// The detection is necessarily structural — a true AST-grade check
// would require resolving SDK identifiers through the import table and
// matching `pipe()` / `pipeline()` sinks; that's the version-delete
// detector's shape, but the scope of this gate is "no `GetObjectCommand` body sink
// inside the attachment routes file" which is observable via the
// imports list and call shapes in the same file.
// ---------------------------------------------------------------------

describe('no attachment route streams ciphertext bytes from object storage', () => {
  const ROUTES_SRC = readSource('src/server/routes/attachments.ts');

  it('the attachment routes file does not import GetObjectCommand', () => {
    // The routes file owns init / complete / list / hide / restore /
    // download-url / bulk-fetch. None of those need to fetch object
    // bytes — `download-url` and `bulk-fetch` issue presigned GETs
    // for the *browser* to consume, the app does not. A regression
    // that imports `GetObjectCommand` here is a tell that someone is
    // about to read a body in-process.
    expect(ROUTES_SRC).not.toMatch(/GetObjectCommand/);
  });

  it('the attachment routes file does not call pipe() / pipeline() on a body', () => {
    // Stream-piping shapes that would proxy bytes through a Fastify
    // reply: `body.pipe(reply.raw)`, `pipeline(body, reply.raw)`,
    // `Readable.from(...).pipe(...)`, etc. None are admissible on the
    // attachment routes file under this gate.
    expect(ROUTES_SRC).not.toMatch(/\.pipe\s*\(/);
    expect(ROUTES_SRC).not.toMatch(/pipeline\s*\(/);
  });

  it('the attachment routes file does not access reply.raw (low-level node socket — byte proxying surface)', () => {
    // Fastify exposes the underlying Node response as `reply.raw`.
    // Any attachment route reaching for `reply.raw` is bypassing
    // Fastify's serializer to write bytes by hand — exactly the
    // shape this gate forbids. A future need (e.g. SSE) is also
    // unwelcome on the attachment routes file specifically.
    expect(ROUTES_SRC).not.toMatch(/reply\.raw/);
  });

  it('the storage-client surface used by the attachment routes does not expose a body-fetch helper', () => {
    // The storage client (src/server/storage/client.ts) exposes
    // `headObject`, `upload`, `hide`, `copyFromVersion`, `presignPut`,
    // `presignGet`, plus the boot probes — no `fetchBytes` /
    // `getObjectBody` / `streamObject` helper. A new helper of that
    // shape would let any caller (including the attachment routes)
    // bring ciphertext into the app. Pin the absence at the client
    // level so the attachment surface inherits it transitively.
    const CLIENT_SRC = readSource('src/server/storage/client.ts');
    expect(CLIENT_SRC).not.toMatch(/\bgetObjectBody\b/);
    expect(CLIENT_SRC).not.toMatch(/\bfetchBytes\b/);
    expect(CLIENT_SRC).not.toMatch(/\bstreamObject\b/);
  });

  it('the AttachmentService does not import GetObjectCommand or call a body-fetch shape', () => {
    // Service layer parity: the routes file's cleanliness is enforced
    // above, but the service layer is the surface the routes call
    // into. A `GetObjectCommand` import on the service that the
    // routes then invoked indirectly would slip past the routes-file
    // scan. Pin the absence here too — the service must stay metadata-
    // and-DEK-only.
    const SERVICE_SRC = readSource('src/server/services/AttachmentService.ts');
    expect(SERVICE_SRC).not.toMatch(/GetObjectCommand/);
    expect(SERVICE_SRC).not.toMatch(/\.pipe\s*\(/);
    expect(SERVICE_SRC).not.toMatch(/pipeline\s*\(/);
  });
});
