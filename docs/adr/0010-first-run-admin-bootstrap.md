# ADR-0010: First-run admin bootstrap from environment variables

- **Status:** Accepted
- **Date:** 2026-04-08
- **Confidence:** High

## Context

The walking-skeleton deploy exposed a gap between spec and production startup. Spec §4.5 states "Default admin account — created during seed data loading", but `src/server/start.ts` correctly refuses to run `seed()` when `NODE_ENV=production` (seed plants 19 demo projects, five fake users with real German names, and an inactive user — none belong in real data). Result: production DB is schema-migrated but empty, and every login returns `INVALID_CREDENTIALS`.

Constraints on the fix:

- Must not weaken the `NODE_ENV=production → skip seed()` guard.
- Must not require a manual ritual that re-creates the bug on every fresh deploy or `pgdata` rebuild.
- Must fail closed on half-configuration (username without password → loud error, not silent empty DB).
- Must be idempotent under restart — same env vars, container restart = safe no-op.
- Credentials handling should minimise plaintext-on-disk window.

## Decision

Add an **opt-in, env-var-driven first-run admin bootstrap** to the startup sequence in `src/server/start.ts`.

When the `users` table is empty AND both `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` are set, startup (after `migrate()`, before `app.listen()`) inserts a single `owner`-role user: configured username, bcrypt hash of the password, `display_name = BOOTSTRAP_ADMIN_DISPLAY_NAME ?? username`.

Rules:

- Users table non-empty → bootstrap is a no-op regardless of env vars.
- Exactly one of the two required vars set → startup exits non-zero naming the missing var.
- Password must pass the standard policy (length, common-password blocklist) → otherwise startup fails with a policy-violation message.
- One `warn` log line on successful insert telling the operator to log in, change the password immediately, and remove `BOOTSTRAP_ADMIN_*` from `.env` before the next deploy.
- Password never logged at any level.

The pairing rule and the password-policy → message mapping live in one shared check (`src/server/config/bootstrap-credentials.ts`, over the shared `password-policy.ts` core) and are enforced at **two points** that cannot diverge:

| Point                | Trigger                              | Failure mode                                        | Rationale                                                                                                                                                          |
| -------------------- | ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Deploy preflight** | vars _present_ in the deploy env     | non-destructive — aborts before `docker compose up` | The preflight has no DB to gate on, so it enforces validate-if-present. A weak/half-config never reaches container recreation.                                     |
| **Boot**             | vars present _and_ users table empty | startup exits non-zero                              | DB-gated (validate-if-used). A populated table short-circuits before validation, so leftover/invalid vars after the first-run ritual stay a safe no-op on restart. |

The asymmetry is deliberate: the strict check belongs at the non-destructive deploy gate. Putting it unconditionally on the boot path would make a leftover invalid value crash a restart of an already-bootstrapped instance — the opposite of the "removal is hygiene, not correctness" property below.

## Alternatives Considered

### A — Manual `psql` insert after each deploy

Operator SSHes in, runs `docker exec ... psql`, inserts a row with a pre-hashed password. Rejected: reproduces the problem on every fresh deploy and `pgdata` rebuild; requires a separate bcrypt tool; zero audit trail; invites copy-paste errors in production.

### B — Reuse `seed()` in production

Drop the `isProduction` guard. Rejected: seed is a dev fixture — 19 demo projects ("Familie Müller", "Café Sonnenschein") and fake users contaminate real data. Tearing down the guard to fix an adjacent problem is a downgrade.

### C — Interactive CLI script (`npm run create-admin`)

TTY-prompted username/password. Rejected for this iteration: adds a manual step; typed creds land in bash history and tmux scrollback. The env-var approach concentrates plaintext in the already-locked-down `/opt/projekt-manager/secrets.env.age` (decrypted only at deploy via process substitution per [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md)). Revisit with a secret manager.

### D — External identity provider (SSO)

Skip admin-in-DB by delegating auth. Rejected: scope is explicitly single-tenant and pre-SSO (spec §4.5 out-of-scope list). Meaningful architectural change for a later iteration.

## Consequences

### Positive

- Self-serviceable fresh deploys: set two env vars, deploy, log in, rotate password, scrub vars, redeploy clean.
- Seed guard stays intact; dev and prod do not share a convenient-but-unsafe user-creation path.
- Fail-closed partial-config prevents the silent-empty-DB mode that triggered this investigation.
- A weak password or half-config in the deploy environment fails the deploy preflight non-destructively (before container recreation), rather than crash-looping the just-recreated app container after the previous good replica is already gone.
- Idempotent by row count — container restarts with vars still set are safe no-ops, so removal is hygiene, not correctness.
- No new dependency or runtime surface — one `count(*)` + one conditional `INSERT` at startup.
- Works identically on first deploy and on future `pgdata` rebuilds (e.g., restore-to-fresh-volume).

### Negative

- Credentials live in `secrets.env.age`, decrypted only at deploy via process substitution (see [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md)). Plaintext never on disk, but the operator must remove the bootstrap vars from the encrypted file after first login.
- "Remove vars after first login" is a human protocol, not enforced. Forgetting leaves dormant credentials in the file — no-op if users exist, but still a leak surface if the passphrase is later compromised. Documented in `.env.example` and `docs/ops/server-setup.md`.
- Forced password rotation on first login is not implemented — the warning log + docs are the enforcement. Future iteration may add a "must change on first login" flag.
- Walking-skeleton-scoped. A multi-operator production wants a user-management UI or SSO; this is a successor path, not a permanent answer.
- One more env-var pair to cover in onboarding docs.

## References

- [ADR-0005](0005-session-management-httponly-cookies.md) — session cookies (requires a user to exist before login works)
- [ADR-0006](0006-password-policy-nist-blocklist.md) — password policy the bootstrap password must pass
- [spec/index.md §4.5](../spec/index.md#45-authentication) — "Default admin account" specification
- [spec/data-model.md §7.2](../spec/data-model.md#72-user-dataset) — seed user records (dev-only)
- `src/server/start.ts` — `NODE_ENV=production → skip seed()` guard that this ADR preserves
