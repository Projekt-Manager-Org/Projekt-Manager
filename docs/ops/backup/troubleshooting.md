# Layer 2 Backup — Troubleshooting and Escalation

When `meta_backup_status.lastBackupOk` stays `false`, the service crash-loops, or manifests don't match.

Concept map: [overview.md](overview.md). Setup / rotation: [setup.md](setup.md). DR: [recovery.md](recovery.md).

## First-deploy failure modes

Symptoms that appear during or right after [setup.md §4](setup.md#4-first-deploy):

| Symptom                                     | Likely cause                                                                                                                                                                                              | Fix                                                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccessDenied` writing to R2                | Token scoped to the wrong bucket                                                                                                                                                                          | Recreate token per [setup.md §1.4](setup.md#14-create-the-api-token), rerun [§3](setup.md#3-push-r2-credentials--recipient-to-the-vps), redeploy.                                                                    |
| `SignatureDoesNotMatch` (HTTP 403) from R2  | `R2_SECRET_ACCESS_KEY` stale relative to `R2_ACCESS_KEY_ID` (rolled token, pasted old secret), or token was minted via Profile → API Tokens instead of the R2 dashboard (only the R2 flow emits S3 creds) | Recreate the token via the R2 dashboard per [setup.md §1.4](setup.md#14-create-the-api-token), capture both AKID and Secret in one pass, rerun [§3](setup.md#3-push-r2-credentials--recipient-to-the-vps), redeploy. |
| `Key not recognised` / `no valid recipient` | `AGE_RECIPIENT` is the private identity, not `age1...`                                                                                                                                                    | Rerun [setup.md §2](setup.md#2-generate-the-age-key-pair) extraction with `age-keygen -y`, rerun §3.                                                                                                                 |
| `meta_backup_status.lastBackupOk = false`   | Tier 1 mismatch or upload failure                                                                                                                                                                         | See "First-line diagnostics" below.                                                                                                                                                                                  |
| No row in `meta_backup_status` at all       | Cron never fired; service crash-looping                                                                                                                                                                   | See "First-line diagnostics" below.                                                                                                                                                                                  |

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

Issue #230 expanded the Layer 1 envelope to round-trip users, the company-profile singleton, invoices, and the invoice-number sequence. Reconstruction loses only what stays out of the envelope by design: sessions (ephemeral), push subscriptions (device-tied), trigger-maintained storage counters, Layer 2 metadata, notification rules (shipped with code), and the per-instance audit chain (the importing instance's chain starts at the import event). Operator-meaningful business state is preserved.

## Owner / escalation contact

The project is currently single-operator. The owner (Vladimir) is the escalation contact for every failure class above. If the owner is unavailable and the outage blocks business operations, the fallback plan is the Layer 1 business-data export ([ADR-0018](../../adr/0018-data-persistence-and-recovery-layered-strategy.md)) restored onto a fresh bootstrap — sessions and per-instance audit history are lost, but every user-meaningful business row (users, customers, projects, invoices, company profile) round-trips per issue #230.

Review this section at every staffing change.
