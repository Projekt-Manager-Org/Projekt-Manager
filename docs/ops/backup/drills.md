# Layer 2 Backup — Drills

Tier 2 drills prove the encrypted round-trip on the real R2 endpoint. There are two kinds:

- **Tier 2 in-container drill** — runs on every backup tick (offset +2 min), unattended, but only when the operator's private identity is loaded into the VPS tmpfs. See [§ Loading the drill key](#loading-the-drill-key-on-the-vps).
- **Monthly operator-workstation drill** — a manual end-to-end restore the operator performs on their own machine. Closes the gap Tier 2 cannot see. See [§ Monthly drill](#monthly-operator-workstation-drill).

Concept map: [overview.md](overview.md). Design rationale: [ADR-0020 §Decision](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#decision).

## Loading the drill key on the VPS

Tier 2 needs the private identity on the VPS. `load-drill-key.sh` writes it to a tmpfs mount inside the `backup` container and never anywhere else ([AC-175](../../spec/verification.md#1522-backup-and-recovery)).

**Location:** `scripts/backup/load-drill-key.sh` in the repo. `Dockerfile.backup` copies it into the image at `/usr/local/bin/load-drill-key` (no `.sh`) — that is the only path the operator ever invokes, via `docker exec` into the running backup container. The tmpfs target inside the container is `/run/drill-key/identity` (file mode 0400, owned by the container's non-root `postgres` user (UID 70); the tmpfs mount itself is mode 0700 uid=70 gid=70).

**Deploy auto-prompt:** `scripts/deploy.sh` checks `/run/drill-key/identity` after `docker compose --profile backup up -d` and invokes `load-drill-key` interactively when the tmpfs is empty (the common case after a deploy that recreated the backup container). Have `~/secrets/age-backup.key` ready on the operator workstation when running a deploy — that's the single intended trigger for the steps below in normal operation. The standalone invocation documented here remains the recovery path for ad-hoc reloads (operator-initiated rotation, post-VPS-reboot without a redeploy, container restart triggered outside the deploy flow).

You are about to write private key material into RAM on the VPS; this is cleared on reboot or on container recreation, and can be overwritten by rerunning the script.

1. Have `~/secrets/age-backup.key` open on the operator workstation. Copy its full contents (including the comment lines and the `AGE-SECRET-KEY-1...` body) to the clipboard.
2. SSH to the VPS as the admin user. Use `docker exec` directly, not `docker compose exec`. The compose path re-parses `docker-compose.yml`, which requires the full set of interpolation vars (`POSTGRES_PASSWORD`, `CLOUDFLARE_API_TOKEN`, etc.) in shell env; a bare sudo shell doesn't have them sourced, so parse aborts with `CLOUDFLARE_API_TOKEN must be declared`. Same class of problem fixed in `server-setup.md` Phase 8.1 (commit 5484903). `-it` allocates a pseudo-TTY so the script's `read -s` actually suppresses echo during the paste:

   ```bash
   sudo -u deploy docker exec -it projekt-manager-backup-1 load-drill-key
   ```

3. The script prompts with `read -s` ("Paste age identity, finish with Ctrl-D:"). Paste the clipboard contents, press Enter, then Ctrl-D. The script:
   - Validates the first line is `# public key: age1...` and that it matches `AGE_RECIPIENT`.
   - Writes the identity to `/run/drill-key/identity` (tmpfs, mode 0400, owned by `postgres` UID 70).
   - Zeros its own buffer before exit.

4. Verify the key is loaded without exposing it:

   ```bash
   sudo -u deploy docker exec projekt-manager-backup-1 \
     test -s /run/drill-key/identity && echo "drill key loaded"
   ```

   The next cron tick picks it up: `meta_backup_status.lastDrillAt` advances, `lastDrillOk = true`, the badge flips green.

5. **After every VPS reboot or container recreate, the key is gone.** Reload by repeating steps 2–3. Until you do, Tier 2 is skipped (not failed — [AC-168](../../spec/verification.md#1522-backup-and-recovery)), but the badge turns amber ("Drill-Schlüssel neu laden") after the staleness threshold **[C]**.

**Never** write the identity to any path other than `/run/drill-key/identity`. Specifically: not to a bind mount, not to `/opt/projekt-manager`, not to an env var in `secrets.env.age`, not to `docker compose exec backup sh -c 'echo ... >'`. A persisted copy on the VPS disk defeats the entire threat model ([AC-175](../../spec/verification.md#1522-backup-and-recovery)).

## Triggering a drill manually

The backup image's `node /app/dist/server/backup-runner.js drill` subcommand runs the same code path the in-container croner schedule fires — so an operator can trigger a one-shot drill without waiting for the next scheduled tick. Common reasons: verifying a freshly-loaded drill key, reproducing a failure seen in the scheduler logs, closing "Drill: noch nie ausgeführt" immediately after setup.

From the admin ssh session:

```bash
sudo -u deploy docker exec projekt-manager-backup-1 node /app/dist/server/backup-runner.js drill
```

Expected one-liners on stdout:

- `backup-runner: drill ok` — full Tier 2 round-trip succeeded. `meta_backup_status.lastDrillAt` advanced and `lastDrillOk` is true.
- `backup-runner: drill skipped reason=key-absent` — no identity at `/run/drill-key/identity`. Load the key via [§Loading](#loading-the-drill-key-on-the-vps) and retry. Skip is not a failure ([AC-168](../../spec/verification.md#1522-backup-and-recovery)), so the status row is not mutated.
- `backup-runner: drill failed reason=...` — something between download, decrypt, and verify broke. `lastDrillOk=false` and `lastError` carries the cue; see [troubleshooting.md](troubleshooting.md).

> A drill verifies the **latest** backup. After a deploy that adds a table, no existing dump has it yet, so the drill fails (`verify: Failed query: ... FROM "<new_table>"`) until a backup runs against the new schema. Take one `run` first:
>
> ```bash
> sudo -u deploy docker exec projekt-manager-backup-1 node /app/dist/server/backup-runner.js run
> ```

croner's `protect: true` prevents two scheduled drill ticks from overlapping within the schedule process. A manual `docker exec … drill` runs in a separate Node process and is NOT serialised against the scheduled tick — operators who fire a manual drill during a scheduled tick may see two drills run in parallel. In practice the artifacts are independent (different ephemeral pg instances, same R2 artifact under verification) so the worst case is a duplicate "drill ok" log line and a status-mirror overwrite of the slower one's row by the faster.

**Badge refresh caveat:** the login-screen freshness badge reads from `status/latest.json` in R2, which is written by the **backup** runner (not the drill). A successful drill updates `meta_backup_status` in the app DB but does NOT refresh the R2 mirror — the badge picks up the new `lastDrillAt` / `lastDrillOk` on the next scheduled backup tick, or sooner if you trigger a backup immediately after:

```bash
sudo -u deploy docker exec projekt-manager-backup-1 node /app/dist/server/backup-runner.js drill
sudo -u deploy docker exec projekt-manager-backup-1 node /app/dist/server/backup-runner.js run
```

## Monthly operator-workstation drill

Tier 2 in-container drills exercise encrypt → upload → download → decrypt against the VPS-side `age` binary and R2 endpoint. They catch pipeline and provider drift as seen from that host. The monthly workstation-side drill closes the gap between the VPS and the operator toolchain:

- Tooling drift between operator workstation and VPS — e.g., a workstation running a newer `age` version that reads the VPS-produced header fine today but changes output next month, or a `pg_restore` major-version gap that only surfaces on the workstation path during a real DR.
- OS/libc gap between the two environments, invisible to Tier 2 because Tier 2 never exercises the workstation toolchain.

**Procedure:** run [recovery.md steps 1–5](recovery.md) (download, decrypt, scratch restore, manifest verify) — **stop before step 6.** No production changes.

Record the result in `~/ops-log/backup-drill-YYYY-MM.md` (create if absent) or in your operations calendar entry. Include: dump timestamp, pass/fail, any mismatch details, workstation `age --version`.

Cadence: first working day of each month. A missed month is not a failure — run it as soon as noticed.
