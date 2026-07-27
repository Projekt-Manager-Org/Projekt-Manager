# Layer 2 Backup — Overview

Operator navigation page for the Layer 2 full-state backup feature ([ADR-0020](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)). Design rationale and alternatives live in the ADR; this runbook is procedures only. The big-picture map across all three data layers lives in the root [DATA.md](../../../DATA.md).

## What Layer 2 is

A `backup` compose service that, on every scheduled tick, produces three R2 objects and updates a status row in the application database:

```
┌──────────────────────┐   pg_dump -Fc + manifest   ┌──────────────────────────────┐
│  backup container    │ ─────────────────────────▶ │  Cloudflare R2 bucket        │
│  croner schedule     │  age-encrypt (recipient)   │  projekt-manager-backups     │
│  Tier 1 verify       │                            │                              │
│   (ephemeral pg)     │ ─── status/latest.json ──▶ │  ├ daily/*.dump.age          │
│  Tier 2 verify       │                            │  ├ daily/*.manifest.json.age │
│   (if key loaded)    │                            │  └ status/latest.json        │
└──────────────────────┘                            └──────────────────────────────┘
           │
           │ upsert meta_backup_status
           ▼
┌──────────────────────┐
│  app DB              │   GET /api/backup/status   ┌──────────────────────────┐
│  meta_backup_status  │ ─────────────────────────▶ │  login-screen + owner    │
│  (single row)        │                            │  landing view — badge    │
└──────────────────────┘                            └──────────────────────────┘
```

Every backup is verified before it is uploaded (**Tier 1**). A separate drill re-verifies the _newest_ R2 artifact whenever the operator's key is loaded (**Tier 2**) — see [Verify tiers](#verify-tiers).

**Retention is linear.** R2 bucket lock on `daily/` + R2 lifecycle rule give a rolling window of encrypted history. No GFS (grandfather-father-son tiered promotion), no rotation script. Canonical values and rationale: [ADR-0020 §Retention](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention); the GFS alternative and why it was ruled out: [ADR-0020 §GFS-style rotation](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#gfs-style-rotation-7-daily-4-weekly-12-monthly).

## When to use this runbook

| Situation                                                                                | Start here                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| Bring Layer 2 up on a fresh VPS, or re-issue R2 credentials / age keys                   | [setup.md](setup.md)                     |
| Production DB is lost, corrupt, or diverged — restore from R2                            | [recovery.md](recovery.md)               |
| Load the drill key on the VPS, or run the monthly workstation-side verify                | [drills.md](drills.md)                   |
| `meta_backup_status.lastBackupOk` stays `false`, service crash-loops, manifests mismatch | [troubleshooting.md](troubleshooting.md) |

## Cadence

The in-process `croner` (npm in-process cron scheduler) schedule registered by `src/server/backup-runner.ts` (`schedule` subcommand — the container's PID 1) runs the backup five times on weekdays (09:00, 12:00, 15:00, 18:00, 21:00 Europe/Berlin) and once on weekends (12:00). The drill follows the same schedule, offset by 2 minutes so it never starts in the same second as the backup tick. Interval is a **[C]** value per [spec architecture.md §11.10](../../spec/architecture.md#1110-full-state-backup-layer-2) — the `SCHEDULES` constant in that file, not an env var. Changing the cadence is a code edit plus a redeploy, not an operator setting.

croner reads `timezone: 'Europe/Berlin'` explicitly, so the schedule stays correct across DST regardless of the container's `TZ` env var. `TZ=Europe/Berlin` is still set on the service for human-readable log timestamps.

## Verify tiers

A weekday 09:00 tick, end to end:

```
09:00  manifest   REPEATABLE READ, read-only, TimeZone UTC — snapshot exported
       pg_dump -Fc   separate connection, --snapshot=<id> → same view
       └─ Tier 1  pg_restore into an ephemeral Postgres (initdb, socket in /tmp)
                  inside this container → recompute manifest → compare
          ✗ mismatch → nothing is uploaded; lastBackupOk=false, lastError names the table
          ✓ → age-encrypt → PUT daily/* → meta_backup_status → status/latest.json

09:02  Tier 2 drill  GET newest daily/*.dump.age → age -d (tmpfs identity)
                     → ephemeral Postgres → compare against the decrypted sidecar
```

Four consequences that change how the status row reads:

- **Tier 1 is a gate, not a receipt.** It runs _before_ the upload, so a corrupt dump never reaches R2 ([AC-165](../../spec/verification.md#1522-backup-and-recovery)).
- **A Tier 1 mismatch means the dump diverged, not that traffic was busy.** The manifest transaction exports its snapshot and `pg_dump` imports it, so ordinary writes during the tick land on both sides or neither ([AC-344](../../spec/verification.md#1522-backup-and-recovery)). Treat a mismatch as a data-integrity event: [troubleshooting.md](troubleshooting.md).
- **Tier 2 is decoupled from the tick before it.** It verifies the lexically-newest `daily/` key, which is the 09:00 artifact only if 09:00 succeeded. `lastDrillOk=true` does not imply `lastBackupOk=true` — read both.
- **Tier 2 is off until the key is loaded.** The identity lives in tmpfs and dies with the container, so every deploy or restart disables drills until it is re-pasted ([drills.md](drills.md)). A skip writes no status at all; it is not a failure.

## Exercising Tier 1 outside production

`scripts/backup/verify-roundtrip.sh` runs one full cycle against the real
`initdb` / `pg_dump` / `pg_restore` — the binaries that ship in the backup
image and nowhere else, which is why this is not part of `npm run test`. CI
runs it in the `docker` job; locally it needs a prebuilt image:

```bash
docker compose build app && docker compose --profile backup build backup
BACKUP_IMAGE=ghcr.io/projekt-manager-org/projekt-manager-backup:dev \
  scripts/backup/verify-roundtrip.sh
```

It owns its own Postgres and MinIO with no published ports, so it needs no
dev stack and does not disturb a running one. Build order matters — see
[docker-compose.dev.yml](../../../docker-compose.dev.yml). What it asserts,
and why each assertion is non-vacuous, is in the script header.

## References

- [ADR-0020](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) — design, alternatives, consequences.
- [ADR-0018](../../adr/0018-data-persistence-and-recovery-layered-strategy.md) — the three-layer persistence model.
- [spec architecture.md §11.10](../../spec/architecture.md#1110-full-state-backup-layer-2) — contract.
- [spec verification.md §15.22](../../spec/verification.md#1522-backup-and-recovery) — acceptance criteria.
- [DATA.md](../../../DATA.md) — bird's-eye map across all three data layers.
