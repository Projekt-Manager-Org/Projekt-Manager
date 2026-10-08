# Ops Docs

Who does what in operations — the operating company's duties, the operator role, the system's limits: [Betriebsverantwortung](../compliance/betriebsverantwortung.md).

## Setup (one-time)

| Document                                                         | Purpose                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| [server-setup.md](server-setup.md)                               | VPS provisioning: OS, SSH, deploy user, Docker, fail2ban |
| [wireguard-setup.md](wireguard-setup.md)                         | WireGuard VPN server and peer onboarding                 |
| [dns-setup.md](dns-setup.md)                                     | Domain DNS configuration (A record → WireGuard IP)       |
| [caddy-tls-bootstrap.md](caddy-tls-bootstrap.md)                 | First-time TLS certificate provisioning via LE staging   |
| [object-storage-provisioning.md](object-storage-provisioning.md) | Backblaze B2 bucket + app key + CORS for attachments     |

## Operations (repeatable)

| Document                                                       | Purpose                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [manual-deploy.md](manual-deploy.md)                           | Deploy, rollback, secrets management                                                                   |
| [sync-dev-to-vps.md](sync-dev-to-vps.md)                       | Destructive sync of dev DB + object storage to the VPS                                                 |
| [sync-vps-to-dev.md](sync-vps-to-dev.md)                       | Destructive sync in reverse — VPS state back into dev                                                  |
| [recover-from-schema-change.md](recover-from-schema-change.md) | Wipe + reseed + sync after a `0000_baseline.sql` edit                                                  |
| [backup/](backup/overview.md)                                  | Layer 2 backup — setup, DR restore, drills, troubleshooting                                            |
| [binary-key/](binary-key/overview.md)                          | Layer 3 binary `age` identity — setup, paste-after-reboot, drills, recovery, rotation, troubleshooting |
| [local-dev.md](local-dev.md)                                   | Local development environment                                                                          |
| [http-only-evaluation.md](http-only-evaluation.md)             | Domain-less HTTP testing on a bare VPS                                                                 |
| [dep-management.md](dep-management.md)                         | Renovate cadence, CVE handling, quarterly lifecycle review                                             |
