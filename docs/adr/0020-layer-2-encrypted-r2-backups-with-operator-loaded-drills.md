# ADR-0020: Layer 2 — encrypted R2 backups with operator-loaded drills

- **Status:** Accepted
- **Date:** 2026-04-17
- **Confidence:** Medium

## Context

[ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) defines three persistence layers. Layer 1 (app-level business-data export/import) ships and verifies; Layer 3 (binary attachments) is deferred. Layer 2 — full-state PostgreSQL covering users, sessions, schema, audit FKs that Layer 1 omits — has strategy but no implementation. Iteration 7 needs the shape: "a backup that is never restored is not a backup" ([ADR-0018 §Context](0018-data-persistence-and-recovery-layered-strategy.md#context)), and until Layer 2 runs, DR is hypothetical.

Forces:

- **Off-site is non-negotiable.** The VPS is a single physical failure point; a dump on the same host is not a backup ([ADR-0018 §Consequences](0018-data-persistence-and-recovery-layered-strategy.md#consequences)).
- **Destination is untrusted.** A storage-provider token leak, provider insider, or bucket misconfiguration must not expose customer and user data in plaintext.
- **Restore must be continuously verified.** A restore that has never succeeded on this data shape cannot be relied on under pressure.
- **Compose is the source of truth** for deployment ([ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md)). A host-managed scheduler splits that across two surfaces.
- **No human at every backup.** A live operator per run defeats the schedule.
- **Operator workstation is the one trusted enclave** for long-lived decrypt material — VPS and CI are not.
- **Scope is mitigation, not archaeology.** Kickoff commits to "automated DB backup at regular intervals" (line 72) but declares "a backup concept and a backup system beyond that" out of scope (line 80). Multi-month restore points are out of this project's goals.

## Decision

Add a dedicated **`backup` compose service** that runs on a configurable interval and produces, per run, three R2 objects in the `projekt-manager-backups` bucket: an encrypted `pg_dump -Fc` artifact at `daily/<iso-timestamp>.dump.age`, an encrypted per-table manifest sidecar at `daily/<iso-timestamp>.manifest.json.age` (row count + deterministic content checksum), and an unencrypted `status/latest.json` mirror of the in-DB backup-status row.

- **Encryption** uses **age asymmetric**: the public recipient ships in container env; the private identity lives only on the operator workstation. For drills, the operator loads the identity into a tmpfs mount on the VPS via a helper script; it never persists to disk and is lost on reboot.
- **Storage** uses R2. A bucket lock scoped to the `daily/` prefix enforces immutability on historical artifacts; a bucket-wide lifecycle rule deletes objects after a total retention window (values in §Retention below). `status/latest.json` is intentionally outside the lock scope — it is a fixed key overwritten every cycle, and an immutability rule on it would permanently break the freshness badge after the first write. R2 object versioning is not used — each `daily/*` run writes a uniquely timestamped filename, no version chain to manage.
- <a id="retention"></a>**Retention is linear.** Bucket lock (14 days on `daily/`) + lifecycle (delete at 90 days, bucket-wide) produce a 14–90 day rolling window of encrypted history — immutable for the first 14 days, deletable for the next 76. No in-container rotation, no weekly/monthly promotion. Deliberate scope call — see "GFS-style rotation" alternative. **These values are the canonical source**; every other doc (architecture, setup, overview, verification, etc.) cites this section rather than restating the numbers.
- **Verification every backup**, two tiers:
  - **Tier 1 — verify-on-create** (unattended): restore the fresh plaintext dump into an ephemeral Postgres inside the backup container (initdb + postgres binary over a unix socket — not a sibling container), recompute the per-table manifest, compare. Mismatch fails the run — no upload, status reports failure.
  - **Tier 2 — verify-on-cycle** (needs operator key): download the just-uploaded encrypted dump, decrypt with the tmpfs identity, restore into ephemeral Postgres, compare manifest. Key absent = drill skipped with a distinct log line; not a failure, but freshness surfaces through status.
- **Status surface is dual-write.** Primary: `meta_backup_status` single-row table, read on the owner landing view and the login screen. Mirror: `status/latest.json` in R2 (unencrypted), readable without the app — so operators can check backup health while the DB is down.
- **Freshness badge**, owner-only, on the owner landing view and the login screen. Green = backup and drill both fresh; amber = backup fresh but drill stale ("Drill-Schlüssel neu laden"); red = backup stale or last run failed. DB unreachable = neutral "status unknown" — silent disappearance is a misleading-state defect class ([ADR-0014](0014-ac-tier-system-critical-vs-design.md)).
- **Manifest checksum** per table: `SELECT md5(string_agg(md5(row(t.*)::text), '' ORDER BY <pk>)) FROM <table> t`, computed in the same transactional snapshot pg_dump uses. Deterministic PK ordering is load-bearing — two runs on the same data must produce the same checksum.
- **Runbook** at `docs/ops/backup/` (entry `overview.md`) covers end-to-end setup from zero so throwaway R2 credentials can be rotated safely: bucket creation with lock and lifecycle, token creation, age key generation, secrets, first deploy, `load-drill-key.sh`, DR restore, and a monthly operator-side full-cycle drill on the operator workstation. Concept-level map across all three layers lives at `DATA.md`.

## Alternatives Considered

### Object versioning plus true Object Lock (Compliance Mode)

S3/R2 object versioning with a Compliance-mode lock — no principal, including root, can delete within the retention window. Strongest ransomware/misconfiguration protection. Ruled out: R2 does not currently support native versioning or Object Lock Compliance Mode. Bucket locks + unique timestamped filenames cover our actual threats (accidents, data-plane S3 token leaks) without emulating a missing feature. Management-plane compromise (CF dashboard or R2-edit API token) can shorten the rule and bypass the lock retroactively, but is outside this ADR's threat model — those credentials never reach the VPS.

### Dual R2 tokens — PUT-only for VPS, full for operator

Scope the VPS credential so a compromise cannot delete history. Ruled out: R2 token permissions are coarse, no native PUT-only tier at required granularity. Bucket locks give equivalent practical protection — within the window, no destructive op on locked-prefix keys succeeds via the data-plane S3 token (DeleteObject, PutObject overwrite, DeleteObjects, CopyObject self-overwrite all blocked) — with less operational complexity.

### Host systemd timer as the cron trigger

Trigger from a systemd timer on the VPS instead of cron-in-container. Ruled out: splits "what runs on this host" across compose and host config, breaking the source-of-truth rule in [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md). Missed-run recovery is not worth the drift; a subsequent run catches up because the artifact is self-contained.

### Passphrase-based age encryption

age's passphrase mode instead of asymmetric. Ruled out: passphrase-based age needs interactive input every backup — defeats automation. Asymmetric allows unattended encryption (public recipient in env) and keeps the private identity entirely off the server.

### Automated CI-based drill

Full restore drill from CI on a schedule. Ruled out: CI would need persistent decrypt-key access, which becomes the whole-history compromise vector — the exact threat encryption is meant to mitigate. Operator-loaded tmpfs isolates the decrypt path to a trusted enclave.

### Dumping the full DB via app-level export instead of pg_dump

Extend the Layer 1 envelope so one artifact captures everything. Ruled out: Layer 1 is portability-first, not DR. It carries the user-meaningful business state (including `users` and `passwordHash` — see [ADR-0018 §Decision](0018-data-persistence-and-recovery-layered-strategy.md#decision)) but deliberately omits the instance-bound surface — `sessions`, `audit_log`, schema, indices, derived rows. Layer 2's `pg_dump` retains all of it. The two layers are complementary; merging re-introduces the confusion ADR-0018 removed.

### GFS-style rotation (7 daily, 4 weekly, 12 monthly)

Classic grandfather-father-son: promote a daily to weekly on Sundays and monthly on the 1st, prune per-tier (7/4/12). Ruled out this iteration on two counts: (1) kickoff scopes the feature to mitigation, not long-term history — expansion beyond is explicitly out of scope ([kickoff line 80](../project/kickoff.md)); (2) R2's free-tier lifecycle rule is bucket-wide (no per-prefix scope), so a promoted monthly would be deleted at day 30 alongside its source daily — "12 monthly" is unreachable without a paid plan or a secondary bucket. The linear 14–30 day window is honest about what the provider actually delivers. Revisit when multi-month archaeology becomes a project goal.

## Consequences

### Positive

- Off-site encrypted full-state backups exist for the first time, covering what Layer 1 cannot (users, sessions, schema, audit FKs).
- Every backup is immediately verified via Tier 1 — silent corruption fails the run before it reaches R2.
- Tier 2 proves the encrypted round-trip continuously whenever the operator is engaged, without a standing decrypt key on the server.
- Bucket locks make the destination resistant to accidental and data-plane-S3-token-leak-driven deletion or overwrite within the retention window.
- Restore runs from the operator workstation with only the envelope file and the private identity — no VPS required.
- The compose-owned `backup` service keeps the deployment topology consistent with [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md).
- The badge's misleading-state-free behaviour (explicit "status unknown" when the DB is unreachable) aligns Layer 2 with the critical-AC tier rules in [ADR-0014](0014-ac-tier-system-critical-vs-design.md).

### Negative

- **New external trust boundary (R2)** — tokens, bucket policy, and provider insider risk now sit inside the security perimeter.
- **New long-lived encryption keys** — the age recipient is embedded in container env; the private identity must be backed up by the operator on their own schedule, outside the system.
- **New tmpfs-resident secret handling** — `load-drill-key.sh` introduces an operator procedure whose correctness is not fully mechanically enforceable; a procedural error (e.g., writing to a non-tmpfs path) would persist the identity to disk.
- **A security audit is required** before release — new external trust boundary, new encryption keys, new tmpfs private-key handling meet the trigger in [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit).
- Operator must maintain the private identity off-system; losing it forfeits Tier 2 drills and every DR restore from encrypted archives.
- Linear retention keeps a rolling window of encrypted objects (see §Retention for the current window length), by design — acceptable on the free tier at the current cadence, but the operator must monitor bucket size if the schedule tightens or the window extends.
- Drill-staleness amber depends on the operator keeping the key loaded after reboots; documented in the runbook but not system-enforceable.
- **`status/latest.json` is forge-able by the same data-plane S3 token.** The mirror sits outside the lock by design (see Amendment 2026-04-23) so the freshness badge can update; a `secrets.env.age` leak lets an attacker overwrite it with fake-OK content. Operators relying on the mirror as an out-of-band signal must cross-check `meta_backup_status` in the DB rather than trusting the mirror alone.
- **Unbounded PUT cost-attack vector.** R2 token permissions allow PUT to any prefix without an object-count cap; a leaked credential supports a cost-attack until lifecycle reaps at day 90. Mitigated only by R2 free-tier limits and operator billing alerts, not by the lock.

## Dep lifecycle health (as of 2026-05-18)

| Dep                  | Status                                                                          | Notes                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare R2 (SaaS) | Active, GA since 2022                                                           | S3-compat (subset — no native versioning or per-version Object Lock, the gap pushed binaries to B2 in [ADR-0022](0022-binary-storage-b2-compliance-object-lock.md)). Zero-egress pricing model; used here for backups only. Exit ramp: any S3-compatible provider. |
| `age`                | see [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md) lifecycle entry | Same upstream, independent identity from binaries ([ADR-0024](0024-binary-attachment-e2e-encryption.md)).                                                                                                                                                          |
| `@aws-sdk/client-s3` | 3.1047.0 (2026-05-14), Apache-2.0, AWS very active                              | S3 client driving R2's S3 API. [deps.dev](https://deps.dev/npm/%40aws-sdk%2Fclient-s3)                                                                                                                                                                             |
| `croner`             | 10.0.1 (2026-02-01), MIT, `hexagon/croner` active                               | In-process cron scheduler (`backup-runner.ts`). Adopted in #199 to replace `dcron`; `protect: true` provides intra-process serialisation only — trade-off documented in the 2026-05-18 amendment below. [deps.dev](https://deps.dev/npm/croner)                    |

## References

- [Kickoff](../project/kickoff.md) — automated DB backup as a goal (line 72); backup-system expansion as non-goal (line 80) — the scope anchor for the linear retention choice
- [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md) — compose is the source of truth
- [ADR-0014](0014-ac-tier-system-critical-vs-design.md) — misleading state is a critical defect class
- [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) — the three-layer persistence model; this ADR is the Layer 2 implementation
- [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — trigger satisfied

## Amendments

### 2026-04-19 — Retention extended from 30 to 90 days

Lifecycle rule changed from "delete 30 days after upload" to "delete 90 days after upload." Effective window: 14 days immutable (unchanged) + 76 days deletable (was 16). Rationale: a 30-day window only catches damage detected within a month; silent data corruption and delayed-detection bugs can take longer to surface. Storage cost impact is negligible at `pg_dump -Fc` compressed sizes. The kickoff line-80 scope anchor ("backup system beyond that is out of scope") still holds — 90 days remains mitigation, not archaeology. GFS-style rotation stays ruled out.

### 2026-04-23 — Bucket-lock prefix narrowed to `daily/`

Originally specified with prefix scope "all objects" (setup.md §1.2). The status-mirror key (`status/latest.json`, see §Decision) is a fixed well-known name overwritten every backup cycle — a bucket-wide lock accepted the first write and rejected every subsequent one with "The object is locked by the bucket policy." Result: `last_backup_ok=true` on every cycle (daily artifacts land fine) but `last_error` perpetually populated with the mirror failure and `status/latest.json` frozen at its day-1 value, breaking the login-screen freshness badge. Fix: narrow the bucket lock's prefix scope to `daily/` so historical dumps and their manifests stay tamper-resistant while the status mirror remains writable. No change to the lifecycle rule (stays bucket-wide — the mirror is idempotent under delete; the next cycle rewrites it). Decision text above updated in-place; §Retention values unchanged.

### 2026-04-29 — Threat-model scope tightened to data-plane after empirical testing

Tested against the live bucket: within the immutability window, R2 bucket lock blocks DeleteObject, PutObject overwrite, DeleteObjects, and CopyObject self-overwrite via the data-plane S3 token. The design's protection holds for `secrets.env.age` exfiltration. Two gaps surfaced and were added to §Consequences: `status/latest.json` is forge-able with the same token, and unbounded PUT permits a cost-attack until lifecycle reaps at day 90. Also confirmed: rule changes apply retroactively in both directions — shortening the rule's `maxAgeSeconds` unlocks already-stored objects whose age exceeds the new threshold. Only management-plane credentials (CF dashboard, R2-edit API token) can change the rule, and those never reach the VPS, so retroactive shortening is outside the data-plane threat model. §Alternatives and §Consequences wording tightened accordingly.

### 2026-05-18 — Scheduler rearchitected to in-process croner; container runs non-root (#199)

The container's PID 1 was `dcron` (Alpine package) execing four bash scripts (`run-backup.sh`, `run-drill.sh`, weekday + weekend lines in `scripts/backup/crontab`). The container had to run as root because dcron's per-entry `fork()+setpgid()` needs `CAP_SETUID`, and the postgres binary's refusal-to-run-as-uid-0 forced an `su-exec`-based demotion every Tier 1 verify cycle.

Two issues compounded:

1. **`dcron` upstream is effectively dead.** Alpine ships ptchinster/dcron, whose only releases are v4.5 and v4.6; last commit 2025-03-18 (~14 months stale at adoption time of this amendment) and last typo-fix-only activity. The Alpine `dcron-4.6-r0` package itself was built 2024-05-30 (~24 months stale). For a service holding encryption keys + DR tooling, an un-triaged-for-CVE OS daemon is a real liability.
2. **Trivy DS-0002** flagged the lack of a `USER` directive on `Dockerfile.backup` (enabled by [ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md)). The clean fix is an architectural one: non-root, no dcron.

**What changed:**

- Schedule moved into the backend bundle. `src/server/backup-runner.ts` gained a `schedule` subcommand that registers four `croner@10` jobs (backup weekday/weekend × drill weekday/weekend) with `timezone: 'Europe/Berlin'` and `protect: true` (croner's in-process equivalent of the former `flock -n` in `run-backup.sh`). The container's `ENTRYPOINT` is `["node", "/app/dist/server/backup-runner.js"]`, `CMD` is `["schedule"]`.
- Container runs as `USER postgres` (UID 70, from the `postgresql17` apk package). The tmpfs at `/run/drill-key` is mounted `uid=70,gid=70,mode=0700` to match.
- `ephemeralPg.ts` simplified: the root → postgres demotion path (`findDemoter`, `chownRecursiveToPostgres`, `su-exec` / `gosu` detection) was deleted. The verify Postgres spawns directly under UID 70.
- `apk add` shrank from 11 packages to 6: dropped `dcron`, `tzdata`, `su-exec`, `jq`, `coreutils` (no more bash flock/date/stat callers after the script layer collapsed). croner reads timezones via the JS runtime's IANA `Intl` API; `node:22-alpine` bundles full ICU + tzdata so no OS package is required (a future runtime swap to a slim image without ICU would silently fall back to UTC — guard noted in `Dockerfile.backup`).
- Startup R2 `HeadBucket` probe (formerly `scripts/backup/probe-r2.mjs` invoked by `entrypoint.sh`) folded into `scheduleSubcommand` so a stale credential surfaces as a fast container restart, not a missed cron tick an hour later.
- `init: true` removed from compose. Node-as-PID-1 handles SIGTERM in `scheduleSubcommand` for a graceful drain (stop jobs → wait up to 9s for in-flight ticks → close DB pool → exit 0); libuv reaps the awaited subprocesses (initdb, postgres, pg_restore).

**Trade-off acknowledged:** the former bash flock provided inter-process serialization between the cron-fired tick and an operator's manual `docker exec ... run-backup.sh`. croner's `protect: true` is intra-process only — a manual `docker exec ... node backup-runner.js run` while a scheduled tick is in flight runs in parallel. Artifacts are independent (distinct ISO-timestamp keys, separate ephemeral pg instances); worst case is a duplicate log line and a status-mirror "last writer wins." Documented in `docs/ops/backup/troubleshooting.md`. If operationally needed, a Postgres advisory lock at the top of `runBackup` would restore the cross-process guarantee; not added now because the manual-run-during-scheduled-tick scenario is rare and the consequences are bounded.

The Alpine OS-package coverage gap that hid dcron's stagnation (Renovate's `dockerfile` manager tracks base-image tags, not `apk add` packages on top) was closed in parallel by the [ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md) work — `docs/ops/dep-management.md` now enumerates apk-installed packages per Dockerfile and requires per-package upstream-health checks at the quarterly review.
