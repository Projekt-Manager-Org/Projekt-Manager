# Layer 2 Backup — Troubleshooting and Escalation

When `meta_backup_status.lastBackupOk` stays `false`, the service crash-loops, or manifests don't match.

Concept map: [overview.md](overview.md). Setup / rotation: [setup.md](setup.md). DR: [recovery.md](recovery.md).

## First-deploy failure modes

Symptoms that appear during or right after [setup.md §4](setup.md#4-first-deploy):

| Symptom                                                                                        | Likely cause                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccessDenied` writing to R2                                                                   | Token scoped to the wrong bucket                                                                                                                                                                               | Recreate token per [setup.md §1.4](setup.md#14-create-the-api-token), rerun [§3](setup.md#3-push-r2-credentials--recipient-to-the-vps), redeploy.                                                                                                                                                                                                                                             |
| `SignatureDoesNotMatch` (HTTP 403) from R2                                                     | `R2_SECRET_ACCESS_KEY` stale relative to `R2_ACCESS_KEY_ID` (rolled token, pasted old secret), or token was minted via Profile → API Tokens instead of the R2 dashboard (only the R2 flow emits S3 creds)      | Recreate the token via the R2 dashboard per [setup.md §1.4](setup.md#14-create-the-api-token), capture both AKID and Secret in one pass, rerun [§3](setup.md#3-push-r2-credentials--recipient-to-the-vps), redeploy.                                                                                                                                                                          |
| `Key not recognised` / `no valid recipient`                                                    | `AGE_RECIPIENT` is the private identity, not `age1...`                                                                                                                                                         | Rerun [setup.md §2](setup.md#2-generate-the-age-key-pair) extraction with `age-keygen -y`, rerun §3.                                                                                                                                                                                                                                                                                          |
| `meta_backup_status.lastBackupOk = false`                                                      | Tier 1 mismatch or upload failure                                                                                                                                                                              | See "First-line diagnostics" below.                                                                                                                                                                                                                                                                                                                                                           |
| `pg_dump: error: invalid snapshot identifier`                                                  | `idle_in_transaction_session_timeout` set on the `db` container below the dump duration — it kills the manifest transaction while that transaction waits for `pg_dump`, and the exported snapshot dies with it | Unset it (Postgres default is disabled) or raise it above the dump duration. The manifest transaction must outlive `pg_dump` ([AC-344](../../spec/verification.md#1522-backup-and-recovery)).                                                                                                                                                                                                 |
| `pg_dump: error: query failed: … canceling statement due to statement timeout` on `LOCK TABLE` | Something held an ACCESS EXCLUSIVE lock (deploy migration, `VACUUM FULL`, `REINDEX`, `TRUNCATE`) for longer than `pg_dump`'s lock wait, so the run bailed instead of wedging the schedule                      | Expected fail-safe, not a defect. Re-run once the DDL has finished: [§Second-line](#second-line-manual-one-shot-deep-dive). Repeated hits mean a long migration overlaps the tick — reschedule the deploy, don't raise the timeout.                                                                                                                                                           |
| `lastError` reads `<binary> exceeded its <n>ms runtime bound and was terminated`               | A subprocess (`pg_dump`, `age`, `initdb`, `pg_restore`) hung and was killed at its wall-clock bound                                                                                                            | Expected fail-safe ([AC-345](../../spec/verification.md#1522-backup-and-recovery)) — without it the tick would never end and croner's `protect` would suppress every later run. Investigate the named binary; check disk space on `/tmp` and connectivity to `db`.                                                                                                                            |
| `lastError` contains `canceling statement due to lock timeout`                                 | Something held ACCESS EXCLUSIVE on a manifest table (deploy migration, `VACUUM FULL`, `REINDEX`) while the run was computing the source manifest                                                               | Expected fail-safe ([AC-345](../../spec/verification.md#1522-backup-and-recovery)) — unbounded, the manifest would block forever, the tick would never finish, and croner's `protect` would suppress every later run. Same cause and same remedy as the `pg_dump` LOCK TABLE row above: re-run once the DDL has finished, and reschedule an overlapping deploy rather than raising the bound. |
| `lastError` contains `TimeoutError` / `exceeded the configured … requestTimeout`               | An R2 request (upload, status mirror, drill download) hit its wall-clock bound — endpoint unreachable, connection black-holed, or R2 degraded                                                                  | Expected fail-safe ([AC-345](../../spec/verification.md#1522-backup-and-recovery)). Check the Cloudflare status page and the endpoint host from the container; the next tick retries. Persistent hits with R2 healthy point at egress filtering on the VPS.                                                                                                                                   |
| Runner logs `canceling statement due to lock timeout` on `meta_backup_status`, no status row   | Something held ACCESS EXCLUSIVE on the status table itself (deploy migration) — the run could not write its own outcome                                                                                        | Expected fail-safe ([AC-345](../../spec/verification.md#1522-backup-and-recovery)); the reason is in the container log, since the row is exactly what could not be written. Re-run once the migration has finished. The badge reads stale — correct: this run produced nothing.                                                                                                               |
| No row in `meta_backup_status` at all                                                          | Cron never fired; service crash-looping                                                                                                                                                                        | See "First-line diagnostics" below.                                                                                                                                                                                                                                                                                                                                                           |

## First-line diagnostics (5 minutes)

SSH to the VPS as the admin user, then run these via `sudo -u deploy`. Use `docker` directly, not `docker compose`. `docker compose <cmd>` re-parses `docker-compose.yml` on every invocation, which requires every interpolation var (`POSTGRES_PASSWORD`, `STORAGE_SECRET_KEY`, `CLOUDFLARE_API_TOKEN`, …) in shell env; the admin's sudo shell doesn't have `secrets.env.age` sourced, so parse aborts with `CLOUDFLARE_API_TOKEN must be declared`. `docker ps` / `docker exec` / `docker logs` don't touch compose, so they work directly. Same class of problem fixed in `server-setup.md` Phase 8.1 (commit 5484903).

```bash
sudo -u deploy docker ps -a --filter name=projekt-manager-backup
sudo -u deploy docker logs projekt-manager-backup-1 --tail=200
sudo -u deploy docker exec projekt-manager-db-1 psql -U pm -d projekt_manager -c 'SELECT * FROM meta_backup_status;'
```

`lastError` is a short machine cue from the backup script — the log tail carries the detail.

## Second-line (manual one-shot, deep-dive)

Trigger a backup manually and read the full output. This `docker exec`s into the running backup container; the in-process croner schedule keeps running in PID 1. Note: manual one-shot runs are NOT serialised against scheduled ticks (croner's `protect: true` only covers intra-process overlap). In practice each run picks a fresh ISO-timestamped artifact key, so an accidental overlap is at most a duplicate log line — not data corruption.

```bash
sudo -u deploy docker exec projekt-manager-backup-1 node /app/dist/server/backup-runner.js run
```

If the container isn't running (e.g. crash-looping on env validation or the startup R2 HeadBucket probe), `docker logs` from First-line diagnostics is the starting point, not this — `docker exec` needs a live PID 1.

Common buckets:

- R2 credential drift — re-run [setup.md §3](setup.md#3-push-r2-credentials--recipient-to-the-vps).
- Age recipient mismatch — re-run [setup.md §3](setup.md#3-push-r2-credentials--recipient-to-the-vps) with `age-keygen -y`.
- PostgreSQL connectivity — check `db` container health.
- Manifest algorithm drift — check [AC-174](../../spec/verification.md#1522-backup-and-recovery) determinism; run the checksum query twice on the same snapshot and compare.

## Escalation threshold

If you cannot restore the most recent green-labelled backup to a scratch DB per [recovery.md steps 1–5](recovery.md), the backup is not a backup. Do not accept the system as healthy.

Next steps:

1. Step back one day and retry.
2. If every available dump fails, prepare for full reconstruction from Layer 1 business-data export ([api.md §14.2.4](../../spec/api.md#1424-unified-data-exchange)) onto a fresh admin bootstrap (see the "First-login ritual" phase in [server-setup.md](../server-setup.md)). The bootstrap-admin user is overwritten by the imported user set during the restore.

The Layer 1 envelope round-trips users, the company-profile singleton, invoices, and the invoice-number sequence. Reconstruction loses only what stays out of the envelope by design: sessions (ephemeral), push subscriptions (device-tied), trigger-maintained storage counters, Layer 2 metadata, notification rules (shipped with code), and the per-instance audit chain (the importing instance's chain starts at the import event). Operator-meaningful business state is preserved.

## Owner / escalation contact

The project is currently single-operator. The owner (Vladimir) is the escalation contact for every failure class above. If the owner is unavailable and the outage blocks business operations, follow the Layer 1 fallback procedure documented under "Escalation threshold" above.

Review this section at every staffing change.
