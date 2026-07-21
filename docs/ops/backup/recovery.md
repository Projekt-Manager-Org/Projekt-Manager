# Layer 2 Backup — Disaster Recovery

Restore the production database from the most recent encrypted R2 backup. Run when production PostgreSQL is lost, corrupt, or diverged. The operator workstation is the trusted enclave; the VPS is not involved until the final step.

Concept map: [overview.md](overview.md). Design rationale: [ADR-0020](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md).

## 1. Pick the dump

If the app is still partially up, check via the owner's authenticated view — the backup-freshness badge in the header ([AC-170](../../spec/verification.md#1522-backup-and-recovery)). Otherwise pull the unencrypted status mirror (`status/latest.json`) from R2:

```bash
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3 cp "s3://projekt-manager-backups/status/latest.json" - \
  --endpoint-url "$R2_ENDPOINT" | jq .
```

List the daily artifacts and pick the newest `lastBackupOk = true` timestamp:

```bash
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3 ls "s3://projekt-manager-backups/daily/" \
  --endpoint-url "$R2_ENDPOINT"
```

## 2. Download

```bash
TS='2026-04-17T02:00:12.345Z'   # replace with the selected timestamp — must match a key from §1's daily/ listing exactly (colons, three-digit ms)
mkdir -p ~/restore && cd ~/restore

AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3 cp "s3://projekt-manager-backups/daily/${TS}.dump.age" . \
  --endpoint-url "$R2_ENDPOINT"

AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3 cp "s3://projekt-manager-backups/daily/${TS}.manifest.json.age" . \
  --endpoint-url "$R2_ENDPOINT"
```

## 3. Decrypt

```bash
age -d -i ~/secrets/age-backup.key "${TS}.dump.age"         > "${TS}.dump"
age -d -i ~/secrets/age-backup.key "${TS}.manifest.json.age" > "${TS}.manifest.json"
```

If either decrypt fails with `no identity matched any of the recipients`, the dump was encrypted to a different public key. You are either holding the wrong identity file, or the key was rotated (see [setup.md § Push R2 credentials + recipient to the VPS](setup.md#3-push-r2-credentials--recipient-to-the-vps)) and these objects predate the current pair.

## 4. Restore into a scratch Postgres

You are about to start a throwaway container. This is fully reversible — it touches no production data.

```bash
docker run --rm -d \
  --name pm-restore-scratch \
  -e POSTGRES_PASSWORD=scratch \
  -e POSTGRES_DB=projekt_manager \
  -e POSTGRES_USER=pm \
  -p 55432:5432 \
  postgres:17-alpine

# Wait for readiness
until docker exec pm-restore-scratch pg_isready -U pm -d projekt_manager >/dev/null 2>&1; do sleep 1; done

# Restore
docker exec -i pm-restore-scratch pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  -U pm -d projekt_manager < "${TS}.dump"
```

## 5. Verify against the manifest

The manifest is the per-table row count + deterministic checksum computed at backup time ([ADR-0020 §Decision](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#decision), [AC-174](../../spec/verification.md#1522-backup-and-recovery)). Recomputing against the scratch DB and comparing proves the encrypted round-trip end-to-end.

PK ordering is load-bearing — the checksum is order-sensitive. `pk_for` queries `pg_index` on the restored scratch DB so every manifest table is covered without per-table maintenance; an unknown table (or a table missing from the restored dump) returns empty and is reported as a fatal finding.

The outer `md5(…)` wraps a `COALESCE(string_agg(…), '')` so an empty table hashes to `md5('')` — the fixed constant `d41d8cd98f00b204e9800998ecf8427e`. The query below mirrors [services/backup.ts::computeManifest](../../../src/server/services/backup.ts) exactly; a divergence here would produce false mismatches.

```bash
# Manifest fields are `rowCount` and `checksum`, at the top level
# (no `.tables` wrapper).
jq -r 'to_entries[] | "\(.key)\t\(.value.rowCount)\t\(.value.checksum)"' "${TS}.manifest.json" \
  > expected.tsv

# PK columns for `table`, in declared order, comma-separated. Reads from
# pg_index on the restored scratch DB so every manifest table is covered
# automatically.
pk_for() {
  docker exec pm-restore-scratch psql -U pm -d projekt_manager -tAc "
    SELECT string_agg(quote_ident(a.attname), ', '
                      ORDER BY array_position(i.indkey, a.attnum))
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = '$1'::regclass AND i.indisprimary;
  "
}

while IFS=$'\t' read -r table count checksum; do
  order_by=$(pk_for "$table")
  if [ -z "$order_by" ]; then
    echo "MISSING TABLE in restored DB: ${table} — manifest claims this table but the restored dump has no such table (or it has no primary key)"
    continue
  fi
  actual_count=$(docker exec pm-restore-scratch psql -U pm -d projekt_manager -tAc \
    "SELECT count(*) FROM ${table};")
  actual_checksum=$(docker exec pm-restore-scratch psql -U pm -d projekt_manager -tAc \
    "SELECT md5(coalesce(string_agg(md5(row(t.*)::text), '' ORDER BY ${order_by}), '')) FROM ${table} t;")
  if [ "$actual_count" != "$count" ] || [ "$actual_checksum" != "$checksum" ]; then
    echo "MISMATCH on ${table}: expected ${count}/${checksum}, got ${actual_count}/${actual_checksum}"
  fi
done < expected.tsv
```

Any `MISMATCH` line is a fatal finding — stop, escalate per [troubleshooting.md](troubleshooting.md). A clean pass means the encrypted archive round-trips against the manifest — the restore is trustworthy.

Tear down the scratch container:

```bash
docker stop pm-restore-scratch
```

## 6. Restore into production

Two paths exist; this runbook supports **(a) only**. Path (b) — targeted table-level restore — is out of scope for this iteration.

**(a) Rebuild the VPS DB volume (maintenance window, downtime).** You are about to destroy the current `pgdata` volume and replace it with the restored state. This is irreversible on the live volume.

1. Announce the maintenance window.
2. SSH to the VPS as the admin user. All subsequent VPS-side steps run via `sudo -u deploy`. Use `docker` directly, not `docker compose`. The compose path re-parses `docker-compose.yml`, which requires the full set of interpolation vars (`POSTGRES_PASSWORD`, `CLOUDFLARE_API_TOKEN`, etc.) in shell env; a bare sudo shell doesn't have them sourced, so parse aborts with `CLOUDFLARE_API_TOKEN must be declared`. Same class of problem fixed in `server-setup.md` Phase 8.1 (commit 5484903).

   Stop every DB client — `app`, `caddy`, and `backup`. Leaving `backup` up would keep a live connection to `projekt_manager`, which makes the `DROP DATABASE` in step 4 fail with "database is being accessed by other users":

   ```bash
   sudo -u deploy docker stop projekt-manager-app-1 projekt-manager-caddy-1 projekt-manager-backup-1
   ```

3. Copy the decrypted dump from the operator workstation to the VPS, then fix ownership on the VPS:
   ```bash
   # workstation
   scp "${TS}.dump" <admin-username>@<vps-hostname>:/tmp/
   # VPS (back in the ssh session)
   sudo chown deploy:deploy /tmp/${TS}.dump
   ```
4. On the VPS: drop and recreate the DB, then restore. `DROP DATABASE … WITH (FORCE)` (Postgres 13+) terminates any stray connection Postgres itself holds — defensive even after step 2, since an internal autovacuum or orphaned session can still hold a connection for a beat. `docker exec -i` pipes the local dump file into `pg_restore`'s stdin inside the container:
   ```bash
   sudo -u deploy docker exec projekt-manager-db-1 \
     psql -U pm -d postgres -c 'DROP DATABASE projekt_manager WITH (FORCE); CREATE DATABASE projekt_manager;'
   sudo -u deploy docker exec -i projekt-manager-db-1 \
     pg_restore --clean --if-exists --no-owner --no-privileges -U pm -d projekt_manager < /tmp/${TS}.dump
   ```
5. On the VPS: shred the plaintext dump.
   ```bash
   sudo shred -u /tmp/${TS}.dump
   ```
6. On the VPS: restart the stack and verify. `scripts/deploy.sh` already includes `--profile backup` so this also brings the backup service back up:
   ```bash
   sudo -u deploy /opt/projekt-manager/scripts/deploy.sh
   ```

**(b) Targeted restore.** Not in scope. If a partial restore is required, open an issue with the affected tables and timestamp; do not attempt without a new runbook entry.

## 7. Post-restore checklist

- [ ] `curl https://${DOMAIN}/api/health` returns 200 from a WireGuard client.
- [ ] Log in as the owner; confirm project counts match the manifest expectations.
- [ ] `meta_backup_status` row exists and is fresh (the first post-restore scheduled tick will overwrite it).
- [ ] Freshness badge renders green after the next backup run.
- [ ] Shred local copies: `shred -u ~/restore/${TS}.dump ~/restore/${TS}.manifest.json`.
- [ ] Rotate any credentials that may have been exposed during the incident ([setup.md § Push R2 credentials + recipient to the VPS](setup.md#3-push-r2-credentials--recipient-to-the-vps)).
