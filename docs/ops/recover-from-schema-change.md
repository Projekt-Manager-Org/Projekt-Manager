# Recover from a Schema Change

`0000_baseline.sql` edits do not reach existing databases. `migrate()` applies a migration only when its `_journal.json` `when` is newer than the last row in `drizzle.__drizzle_migrations`; it records each file's sha256 but never compares it. An edited baseline keeps its `when`, so `migrate()` silently skips it. The live DB stays on the previous schema while `schema.ts` and the SQL describe the new one.

Project policy is to wipe and reseed; no incremental migrations.

## Symptom

Both deploy and boot now refuse to proceed when this state is detected — `scripts/deploy.sh` aborts pre-flight (`Baseline schema mismatch …`) and `npm run dev` / production boot throws the same error from `src/server/db/baseline-guard.ts`. The runbook below applies whether you hit the abort or the older 500-after-boot symptom:

```
column "<X>" of relation "<T>" does not exist
```

## 1. Wipe and redeploy VPS

On the VPS, as a privileged operator user:

```bash
sudo -u deploy docker rm -f projekt-manager-app-1 projekt-manager-db-1
sudo -u deploy docker volume rm projekt-manager_pgdata
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh
```

Fresh DB; baseline applies; live schema = `schema.ts`.

## 2. Reset local stack and reseed

`down -v` removes both named volumes (`pgdata`, `miniodata`); `npm run dev` migrates + reseeds (`SEED=true` in `.env`):

```bash
docker compose down -v
docker compose up -d
npm run dev
```

Both volumes go: `pgdata` carries the stale schema; `miniodata` carries orphan objects from prior runs that the sync's pollution gate (`2 × rows + 2`) would reject.

See [local-dev.md](local-dev.md) for the local stack overview.

## 3. Sync local → VPS

```bash
scripts/sync-dev-to-vps.sh --i-know
```

See [sync-dev-to-vps.md](sync-dev-to-vps.md) for preflight gates and failure modes.
