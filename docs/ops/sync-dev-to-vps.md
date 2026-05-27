# Sync Dev → VPS

Destructively overwrites the VPS's Postgres database and object-storage bucket with whatever is in the operator's local dev stack. Useful while the VPS holds no production data and the iteration requires quickly mirroring local state (seed users, demo customers/projects, attachments) to a live deployment for end-to-end validation.

The local dev mirror is MinIO (via `docker-compose.minio.yml`); the VPS bucket is Backblaze B2 since the ddff944 topology switch (ADR-0022). The script reads VPS B2 credentials from the running app container's env — no `secrets.env.age` decryption needed during a sync.

```
operator workstation                              VPS (over SSH)
  docker compose running (dev overlay via .env COMPOSE_FILE)  docker compose running (deploy flow)
    │                                                   │
    │  pg_dump (plain SQL) ──┐                          │
    │  mc mirror MinIO → dir │                          │
    │                        ├─ rsync ──►  /tmp/pm-sync-<ts>/
    │                                                   │
    │                           ssh bash -s ──► pause backup
    │                                           pg_terminate_backend (app pool)
    │                                           psql < db.sql
    │                                           mc mirror → B2 bucket
    │                                           unpause backup
    │                                           /api/health probe
```

## When to use

- Pushing local dev state to a VPS that has no data worth keeping.
- Reproducing a dev-only bug on the deployed stack.
- Populating a fresh VPS after initial setup (bootstrap admin → sync → done).
- Step 3 of [recover-from-schema-change.md](recover-from-schema-change.md) — after wiping VPS and local DBs.

## When NOT to use

- VPS holds production data a user has touched through the UI — the sync wipes it.
- Schema drift between local and VPS — script refuses; deploy the matching commit first.
- Layer 2 backups: this script replaces neither disaster-recovery nor drills. See [backup/overview.md](backup/overview.md).

## Preconditions

| Requirement                                | Verify                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ssh hetzner` reachable as `deploy`        | `ssh -o BatchMode=yes hetzner true`                                                                               |
| Local dev stack running (`db`, `storage`)  | `docker compose ps db storage`                                                                                    |
| Local DB populated (seeds ran)             | `docker exec projekt-manager-db-1 psql -U pm -d projekt_manager -tAc 'SELECT COUNT(*) FROM users;'` — must be ≥ 1 |
| VPS deployed at a schema-compatible commit | Hash-compared automatically (`0000_baseline.sql`)                                                                 |

The schema check is exact-match on `src/server/db/migrations/0000_baseline.sql`. If it fails, [deploy the matching commit](manual-deploy.md) first, then retry.

## Run

```bash
# Preflight only — refuses without the flag
./scripts/sync-dev-to-vps.sh

# Proceed after preflight passes
./scripts/sync-dev-to-vps.sh --i-know
```

Overrides via env:

| Variable     | Default   | Purpose                                         |
| ------------ | --------- | ----------------------------------------------- |
| `SSH_TARGET` | `hetzner` | SSH destination (host alias in `~/.ssh/config`) |

End-to-end typical timing on a small dataset: ~40 seconds. The app container stays running throughout — at most a few requests during the ~10 s restore see a transient pool error after `pg_terminate_backend` clears the connections; node-postgres reconnects on the next query. The backup container is `docker pause`d for the same window so its croner schedule can't fire mid-restore (and so its `/run/drill-key` tmpfs survives — `docker stop` would wipe it the same way it wipes the app's binary identity, ADR-0024).

## What the script does

1. Preflight — SSH, local stack, schema parity, non-empty local DB.
2. Refuses without `--i-know`; prints exactly what will be overwritten.
3. `pg_dump --clean --if-exists --no-owner --no-acl` into `/tmp/pm-sync-<ts>/db.sql`.
4. `mc mirror --overwrite --remove` local MinIO bucket into `/tmp/pm-sync-<ts>/bucket/`.
5. `rsync -az` the temp directory to the VPS.
6. On VPS: read STORAGE\_\* from the running `app` container's env → pause `backup` if running → `pg_terminate_backend` on the app's connections to `projekt_manager` → `psql -v ON_ERROR_STOP=1 < db.sql` → `mc mirror` onto the B2 bucket → unpause `backup` → poll `/api/health` for 60s.
7. Trap-based cleanup: unpauses `backup` even on failure; removes `/tmp/pm-sync-<ts>/` on both ends.

Credentials on both ends are read from the running containers' env: local MinIO via `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` on the `storage` container; VPS B2 via `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` (and the bucket name + endpoint) on the `app` container. Neither side needs `secrets.env.age` decrypted during the sync.

## What gets overwritten

- Postgres database `projekt_manager` — every table is dropped and recreated from the dump, including `users`, `sessions`, `audit_log`, `customers`, `projects`, `attachments`, etc.
- VPS object-storage bucket (configured as `STORAGE_BUCKET` in the app env — typically `prmng-object-storage` on B2) — keys absent locally get a delete-marker, keys present locally are written as new versions. Per ADR-0022's Compliance Object Lock + capability split, no underlying versions are destroyed; lifecycle reaps them after the configured retention + hide-to-delete window.

Untouched: VPS filesystem, `secrets.env.age`, Caddy config, VAPID private key under `data/.vapid/`, R2 backup archives, B2 bucket configuration (versioning, Object Lock, lifecycle, CORS — none of those are mc-writable with the bucket-scoped app key).

## Failure modes

| Symptom                                    | Cause / Fix                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema hash mismatch`                     | VPS is on a different commit's schema. Deploy the matching commit first.                                                                                                                                                                                            |
| `local service 'db' is not running`        | Start the dev stack: `docker compose up -d`.                                                                                                                                                                                                                        |
| `local users table is empty`               | Start the app once (`npm run dev`) so migrations + seed run, then retry.                                                                                                                                                                                            |
| `health check failed after 60s`            | Check `ssh hetzner 'docker logs --tail=80 projekt-manager-app-1'`. DB restore may have partially applied — inspect tables and re-run.                                                                                                                               |
| Sync aborts mid-way, `backup` stays paused | The trap unpauses on exit regardless of failure; confirm with `ssh hetzner 'docker ps'` (paused containers show `(Paused)`). If still paused, `docker unpause projekt-manager-backup-1` by hand. The app container is never paused or stopped, so it stays running. |

## Post-sync checklist

- Log in with a seed user (e.g. `inhaber` / `changeme`) — confirm session works.
- Open one project with an attachment — confirm the thumbnail renders (proves bucket + DB are in sync on attachment keys).
- If `backup` profile is active, let it ride to the next scheduled tick and confirm it completes — the restore rewrites `meta_backup_status`, so the first post-sync backup starts from a fresh cursor.

## Relationship to other workflows

- [manual-deploy.md](manual-deploy.md) — runs first to get the VPS onto a compatible schema.
- [backup/overview.md](backup/overview.md) — unrelated; Layer 2 encrypted backup is for disaster recovery, not dev→prod mirroring.
- The business-data export→import flow (`ExportService` / `ImportService`) — business-data-only, validates user refs, requires matching user UUIDs on the target. This script subsumes that use case by carrying the entire DB.
