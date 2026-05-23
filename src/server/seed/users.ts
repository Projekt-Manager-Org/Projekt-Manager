/**
 * Seed users fixture loader — fixture shape validation + id resolution.
 *
 * Issue #230: users are part of the Layer 1 envelope (data-model.md §5.8;
 * api.md §14.2.4), so the seed assembles them into the envelope alongside
 * customers / projects / company_profile and ships everything through
 * `ImportService` in a single call (see `business.ts`). This module owns
 * fixture parsing and seeded-id resolution; envelope assembly is in
 * `business.ts`.
 *
 * Parsing (`parseUsersFixture`) is pure and filesystem-free so the AT-88
 * unit path can feed it literals to assert malformed-input rejection.
 */
import { z } from 'zod';

// JSON import attribute — esbuild (build:server) and vitest both
// inline the fixture at build time, so there is no runtime fs access
// and no path-resolution dependency on the source-tree layout. The
// bundled `dist/server/start.js` used to crash with ENOENT on
// `/fixtures/seed-users.json` because `path.resolve(here, '../../../
// fixtures/…')` landed at the filesystem root under the flattened
// bundle layout; inlining sidesteps that class of bug entirely.
import rawFixture from '../../../fixtures/seed-users.json' with { type: 'json' };

/**
 * Fixture schema. `.strict()` refuses unknown keys so an accidentally
 * committed `passwordHash` / `createdAt` in the JSON fails loudly rather
 * than silently dropping. Roles are validated as a non-empty string array
 * — finer-grained role-value validation is the domain layer's job and is
 * exercised elsewhere; here we only guarantee the shape the envelope-row
 * builder needs.
 *
 * The `id` check is deliberately looser than Zod's `.uuid()` — the
 * fixture uses vanity-hex values like `11111111-...-111111111111` that
 * don't conform to RFC 4122 variant bits but are valid Postgres `uuid`
 * inputs. Postgres itself is the authoritative validator; this regex
 * only catches the obvious shape slip.
 */
const userFixtureSchema = z
  .object({
    id: z.guid(),
    username: z.string().min(1),
    displayName: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    email: z.email().nullable(),
    active: z.boolean(),
  })
  .strict();

const usersFixtureSchema = z.array(userFixtureSchema);

export type SeedUserFixture = z.infer<typeof userFixtureSchema>;

/**
 * Validate a raw fixture payload. Throws a `ZodError` on any shape
 * violation (missing required field, wrong type, unknown key, bad UUID,
 * empty roles array, malformed email). No filesystem, no DB — pure, so
 * the AT-88 unit path can exercise it with a literal value.
 *
 * ZodError is Zod's own typed error class (`instanceof ZodError`), which
 * satisfies AC-164's "typed validation error" without us minting a
 * project-specific subclass — adding one would be a new surface the
 * calling code would have to branch on with no integrity benefit.
 */
export function parseUsersFixture(raw: unknown): SeedUserFixture[] {
  return usersFixtureSchema.parse(raw);
}

/**
 * Parsed fixture array, cached on first access. Cross-package import
 * direction (server seed reads the JSON) is fine because the JSON is
 * inlined at build time — no runtime fs.
 */
let _cachedFixture: SeedUserFixture[] | undefined;
function getCachedFixture(): SeedUserFixture[] {
  if (!_cachedFixture) {
    _cachedFixture = parseUsersFixture(rawFixture);
  }
  return _cachedFixture;
}

/**
 * Seeded user IDs keyed by username — single source of truth for ID
 * references across seed modules. `business.ts` calls this to emit
 * `project_workers[].userId` values that resolve against the envelope's
 * users; `invoices.ts` calls it to look up the owner id.
 *
 * The fixture is inlined at build time (JSON import attribute above),
 * so this is a cheap object lookup with no filesystem access. Lazy
 * caching avoids re-parsing on repeated calls.
 */
let _cachedSeededUserIds: Readonly<Record<string, string>> | undefined;
export function getSeededUserIds(): Readonly<Record<string, string>> {
  if (!_cachedSeededUserIds) {
    _cachedSeededUserIds = Object.freeze(
      Object.fromEntries(getCachedFixture().map((u) => [u.username, u.id])),
    );
  }
  return _cachedSeededUserIds;
}

/**
 * Parsed user records as read from the fixture. Consumed by
 * `business.ts` to populate `envelope.users` — every field comes from
 * the fixture except `passwordHash` (hashed once by the orchestrator
 * and threaded through `buildBusinessEnvelope`).
 */
export function getSeededUserRecords(): SeedUserFixture[] {
  return getCachedFixture();
}
