/**
 * First-run admin bootstrap.
 *
 * Inserts an initial `owner`-role user when the users table is empty and
 * the `BOOTSTRAP_ADMIN_USERNAME` + `BOOTSTRAP_ADMIN_PASSWORD` environment
 * variables are both set. Opt-in, idempotent, fail-closed on half-config.
 *
 * Called from start.ts after migrate() and before app.listen() — see
 * AC-B7 in issue #57. Any thrown error aborts startup via the existing
 * start().catch(…) handler.
 *
 * See ADR-0010 for the architectural rationale and the "first-deploy
 * ritual" that operators follow: set env vars, deploy, log in, change
 * password, remove env vars, redeploy clean.
 */

import { sql } from 'drizzle-orm';
import type { Database } from './db/connection.js';
import { users } from './db/schema.js';
import { createUser as createUserRepo } from './repositories/user.js';
import { hashPassword } from './password.js';
import { checkBootstrapCredentialPair } from './config/bootstrap-credentials.js';
import { mutate } from './services/mutate.js';

export interface BootstrapAdminConfig {
  username: string | undefined;
  password: string | undefined;
  displayName: string | undefined;
}

/**
 * Minimal logger shape for startup code. Intentionally narrower than the
 * service-layer `ServiceLogger` (which is structured pino-style): bootstrap
 * runs before the Fastify app exists (and therefore before `app.log`), so
 * it cannot depend on Fastify's logger and uses plain string messages that
 * map naturally to `console.warn` / `console.error` in start.ts. Keeping
 * the interface narrow also keeps the tests trivially mockable with
 * `vi.fn()` without needing a full pino double.
 */
export interface BootstrapAdminLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface BootstrapAdminResult {
  inserted: boolean;
}

/**
 * Sentinel thrown from inside the `mutate()` callback when the
 * transactional re-check finds that another process has inserted a user
 * in the race window. The throw rolls back both the would-be `users`
 * insert and the audit row, then bootstrap catches this specific type
 * and reports `{ inserted: false }` to the caller.
 */
class BootstrapRaceError extends Error {
  constructor() {
    super('bootstrap_race');
    this.name = 'BootstrapRaceError';
  }
}

/**
 * Bootstrap the first-run admin user if the users table is empty and
 * the required env vars are present.
 *
 * Order of operations (AC cross-reference in square brackets):
 *
 *   1. Count users → non-empty DB short-circuits BEFORE env-var
 *      validation [AC-B2]. This ensures leftover weak or partial
 *      `BOOTSTRAP_ADMIN_*` values from a previous bootstrap do not
 *      crash the service on restart.
 *
 *   2. Normalize env-var inputs. Undefined, empty, and whitespace-only
 *      are all treated as "not set" [AC-B6].
 *
 *   3. Neither var set → silent no-op [AC-B4]. Dev workflows using
 *      `SEED=true` are not disturbed.
 *
 *   4. Exactly one var set → throw, naming the missing var [AC-B3].
 *
 *   5. Password policy: length (8..72) and common-password blocklist
 *      [AC-B5]. Error messages must not contain the password itself
 *      [AC-B8].
 *
 *   6. Insert inside a transaction with an in-transaction re-check.
 *      This closes the race window between the initial count and the
 *      insert. A Postgres unique-violation (code 23505) at this point
 *      is treated as "another process beat us" — equivalent to a
 *      no-op, not an error [AC-B6 defensive handling].
 *
 *   7. Emit a single warn-level log naming the user and instructing
 *      the operator to rotate the password and remove the env vars
 *      [AC-B9]. The password and hash are never logged [AC-B8].
 */
export async function bootstrapAdminIfEmpty(
  db: Database,
  config: BootstrapAdminConfig,
  logger: BootstrapAdminLogger,
): Promise<BootstrapAdminResult> {
  // ---------------------------------------------------------------
  // Step 1: non-empty DB short-circuit [AC-B2]. If the DB is already
  // populated AND the operator left BOOTSTRAP_ADMIN_* env vars set,
  // emit a warning: the first-run ritual in ADR-0010 explicitly
  // requires removing the vars after the initial login + password
  // change, and leftover vars would otherwise persist silently across
  // every deploy. The short-circuit itself still happens — we never
  // re-insert — but the warning reminds the operator to clean up.
  // See consolidation review G F-6.
  // ---------------------------------------------------------------
  const [countRow] = await db.select({ count: sql<number>`cast(count(*) as int)` }).from(users);
  const initialCount = countRow?.count ?? 0;
  if (initialCount > 0) {
    const leftoverUsername = (config.username?.trim() ?? '').length > 0;
    const leftoverPassword = (config.password ?? '').length > 0;
    if (leftoverUsername || leftoverPassword) {
      logger.warn(
        'BOOTSTRAP_ADMIN_* env vars are still set but the users table is not empty. ' +
          'Remove BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD, and ' +
          'BOOTSTRAP_ADMIN_DISPLAY_NAME from the deploy environment to prevent ' +
          'leftover credentials persisting across deploys (see ADR-0010).',
      );
    }
    return { inserted: false };
  }

  // ---------------------------------------------------------------
  // Step 2: normalize inputs [AC-B6].
  // ---------------------------------------------------------------
  const username = config.username?.trim() ?? '';
  const password = config.password ?? '';
  const usernameProvided = username.length > 0;
  const passwordProvided = password.length > 0;

  // ---------------------------------------------------------------
  // Step 3: opt-in check [AC-B4].
  // ---------------------------------------------------------------
  if (!usernameProvided && !passwordProvided) {
    return { inserted: false };
  }

  // ---------------------------------------------------------------
  // Steps 4 + 5: fail closed on half-config [AC-B3], then enforce the
  // password policy [AC-B5]. Both the pairing rule and the policy →
  // message mapping live in config/bootstrap-credentials.ts so this boot
  // path and the deploy-preflight guard (config/env.ts) cannot diverge on
  // what "configured" means or on the operator-facing text. Messages name
  // the missing var and MUST NOT include the password itself [AC-B8] — the
  // shared validator never echoes it.
  // ---------------------------------------------------------------
  const credentialError = checkBootstrapCredentialPair(config);
  if (credentialError) {
    throw new Error(credentialError);
  }

  // ---------------------------------------------------------------
  // Step 6: hash and insert via the single-write-path `mutate()` helper.
  // Per ADR-0021, every domain-entity write — including the first-run
  // admin — must emit an atomic audit row. The `system` actor kind with
  // `first-run-bootstrap` reason makes the bootstrap visible in the
  // activity feed (AC-178). The DB CHECK constraint rejects an empty
  // `actor_reason` for safety in depth.
  // ---------------------------------------------------------------
  const displayName = config.displayName?.trim() || username;
  const passwordHash = await hashPassword(password);

  let didInsert = false;
  try {
    await mutate(
      db,
      {
        actorKind: 'system',
        actorId: null,
        actorReason: 'first-run-bootstrap',
        correlationId: null,
      },
      {
        entityType: 'user',
        action: 'create',
        run: async (tx) => {
          // Re-check inside the transaction — closes the window between
          // the initial count and the insert.
          const [recount] = await tx
            .select({ count: sql<number>`cast(count(*) as int)` })
            .from(users);
          if ((recount?.count ?? 0) > 0) {
            // Another process bootstrapped. We still need to return a
            // MutateResult — the caller will see `didInsert === false`
            // and an audit row will land for this race. To avoid
            // inserting a spurious audit row when nothing changed, we
            // throw a sentinel and catch it outside the helper.
            throw new BootstrapRaceError();
          }

          const inserted = await createUserRepo(tx, {
            username,
            displayName,
            passwordHash,
            roles: ['owner'],
            email: null,
            createdBy: null,
            updatedBy: null,
          });
          didInsert = true;
          return {
            entityId: inserted.id,
            entityLabel: inserted.displayName,
            value: inserted,
            before: {},
            after: {
              username: inserted.username,
              displayName: inserted.displayName,
              roles: inserted.roles,
              email: inserted.email,
              active: inserted.active,
            },
          };
        },
      },
    );
  } catch (err) {
    if (err instanceof BootstrapRaceError) {
      return { inserted: false };
    }
    // Postgres unique_violation: another process inserted a user with
    // the same username between the transactional re-check and the
    // INSERT. Equivalent to AC-B2 — "another process bootstrapped".
    // Never re-throw with the password or hash attached.
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      return { inserted: false };
    }
    throw err;
  }

  if (!didInsert) {
    // Unreachable given the sentinel above, but defensive.
    return { inserted: false };
  }

  // ---------------------------------------------------------------
  // Step 7: loud warn log [AC-B9]. Password and hash are NOT included.
  // ---------------------------------------------------------------
  logger.warn(
    `Bootstrap admin user "${username}" created. ` +
      'Log in now, change the password, and remove BOOTSTRAP_ADMIN_* ' +
      'from .env before the next deploy (see ADR-0010).',
  );

  return { inserted: true };
}
