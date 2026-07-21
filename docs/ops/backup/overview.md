# Layer 2 Backup — Overview

Operator navigation page for the Layer 2 full-state backup feature ([ADR-0020](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)). Design rationale and alternatives live in the ADR; this runbook is procedures only. The big-picture map across all three data layers lives in the root [DATA.md](../../../DATA.md).

## What Layer 2 is

A `backup` compose service that, on every scheduled tick, produces three R2 objects and updates a status row in the application database:

```
┌──────────────────────┐   pg_dump -Fc + manifest   ┌──────────────────────────┐
│  backup container    │ ─────────────────────────▶ │  Cloudflare R2 bucket    │
│  croner schedule     │  age-encrypt (recipient)   │  projekt-manager-backups │
│  Tier 1 verify       │                            │                          │
│   (ephemeral pg)     │ ─── status/latest.json ──▶ │  ├ daily/*.dump.age      │
│  Tier 2 verify       │                            │  ├ daily/*.manifest.age  │
│   (if key loaded)    │                            │  └ status/latest.json    │
└──────────────────────┘                            └──────────────────────────┘
           │
           │ upsert meta_backup_status
           ▼
┌──────────────────────┐
│  app DB              │   GET /api/backup/status   ┌──────────────────────────┐
│  meta_backup_status  │ ─────────────────────────▶ │  login-screen + owner    │
│  (single row)        │                            │  landing view — badge    │
└──────────────────────┘                            └──────────────────────────┘
```

Every backup is verified immediately after creation (**Tier 1**). Whenever the operator's decryption key is loaded into the VPS tmpfs, every backup is also verified end-to-end from the encrypted R2 artifact (**Tier 2**). A missing key makes Tier 2 skip gracefully; it is not a failure.

**Retention is linear.** R2 bucket lock on `daily/` + R2 lifecycle rule give a rolling window of encrypted history. No GFS (grandfather-father-son tiered promotion), no rotation script. Canonical values and rationale: [ADR-0020 §Retention](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention); the GFS alternative and why it was ruled out: [ADR-0020 §GFS-style rotation](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#gfs-style-rotation-7-daily-4-weekly-12-monthly).

## When to use this runbook

| Situation                                                                                | Start here                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| Bring Layer 2 up on a fresh VPS, or re-issue R2 credentials / age keys                   | [setup.md](setup.md)                     |
| Production DB is lost, corrupt, or diverged — restore from R2                            | [recovery.md](recovery.md)               |
| Load the drill key on the VPS, or run the monthly workstation-side verify                | [drills.md](drills.md)                   |
| `meta_backup_status.lastBackupOk` stays `false`, service crash-loops, manifests mismatch | [troubleshooting.md](troubleshooting.md) |

## Cadence

The in-process `croner` (npm in-process cron scheduler) schedule registered by `src/server/backup-runner.ts` (`schedule` subcommand — the container's PID 1) runs the backup five times on weekdays (09:00, 12:00, 15:00, 18:00, 21:00 Europe/Berlin) and once on weekends (12:00). The drill service follows the same schedule, offset by 2 minutes so it never starts in the same second as the backup it verifies. Interval is a **[C]** value per [spec architecture.md §11.10](../../spec/architecture.md#1110-full-state-backup-layer-2).

croner reads `timezone: 'Europe/Berlin'` explicitly, so the schedule stays correct across DST regardless of the container's `TZ` env var. `TZ=Europe/Berlin` is still set on the service for human-readable log timestamps.

## References

- [ADR-0020](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) — design, alternatives, consequences.
- [ADR-0018](../../adr/0018-data-persistence-and-recovery-layered-strategy.md) — the three-layer persistence model.
- [spec architecture.md §11.10](../../spec/architecture.md#1110-full-state-backup-layer-2) — contract.
- [spec verification.md §15.22](../../spec/verification.md#1522-backup-and-recovery) — acceptance criteria.
- [DATA.md](../../../DATA.md) — bird's-eye map across all three data layers.
