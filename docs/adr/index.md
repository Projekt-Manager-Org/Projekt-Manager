# Architecture Decision Records

| ADR                                                                         | Title                                                                 | Status             | Date       |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------ | ---------- |
| [0001](0001-generalized-system-with-configurable-customer-specifics.md)     | Generalized system with configurable customer specifics               | Accepted           | 2026-04-02 |
| [0002](0002-tech-stack-typescript-react-vite-zustand.md)                    | Tech Stack — TypeScript, React 19, Vite, Zustand                      | Accepted           | 2026-04-03 |
| [0003](0003-deployment-infrastructure-vps-docker-compose-github-actions.md) | Deployment infrastructure — VPS, Docker Compose, GitHub Actions       | Accepted           | 2026-04-04 |
| [0004](0004-backend-stack-fastify-drizzle-node-postgres.md)                 | Backend stack — Fastify, Drizzle ORM, node-postgres                   | Accepted           | 2026-04-04 |
| [0005](0005-session-management-httponly-cookies.md)                         | Session management — HttpOnly cookies with SameSite=Strict            | Accepted           | 2026-04-05 |
| [0006](0006-password-policy-nist-blocklist.md)                              | Password policy — NIST SP 800-63B with local blocklist                | Accepted           | 2026-04-05 |
| [0007](0007-suppress-esbuild-dev-server-advisory.md)                        | Suppress esbuild dev-server advisory (GHSA-67mh-4wv8-2f99)            | Superseded by #195 | 2026-04-05 |
| [0008](0008-vpn-first-network-access.md)                                    | VPN-first network access                                              | Accepted           | 2026-04-08 |
| [0009](0009-pin-docker-versions-across-environments.md)                     | Pin Docker Engine and Compose versions across environments            | Accepted           | 2026-04-07 |
| [0010](0010-first-run-admin-bootstrap.md)                                   | First-run admin bootstrap from environment variables                  | Accepted           | 2026-04-08 |
| [0011](0011-build-images-in-ci-distribute-via-ghcr.md)                      | Build app images in CI, distribute via GHCR                           | Accepted           | 2026-04-09 |
| [0012](0012-manual-pull-based-deploy-over-wireguard.md)                     | Manual pull-based deploy over WireGuard                               | Accepted           | 2026-04-10 |
| [0013](0013-http-only-evaluation-mode.md)                                   | HTTP-only evaluation mode for full-stack integration testing          | Accepted           | 2026-04-10 |
| [0014](0014-ac-tier-system-critical-vs-design.md)                           | AC tier system — critical, design, and infra coverage                 | Accepted           | 2026-04-12 |
| [0015](0015-copy-paste-textarea-email-data-intake.md)                       | Copy/paste textarea for email data intake                             | Accepted           | 2026-04-13 |
| [0016](0016-llm-email-extraction-via-server-proxied-openrouter.md)          | LLM email extraction via server-proxied OpenRouter                    | Accepted           | 2026-04-13 |
| [0017](0017-soft-delete-as-board-archive.md)                                | Project soft-delete as board archive, not audit trail                 | Accepted           | 2026-04-13 |
| [0018](0018-data-persistence-and-recovery-layered-strategy.md)              | Data persistence and recovery — layered strategy                      | Accepted           | 2026-04-15 |
| [0019](0019-worker-data-scoping-repository-layer-predicate.md)              | Worker data scoping — repository-layer predicate                      | Accepted           | 2026-04-16 |
| [0020](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)    | Layer 2 — encrypted R2 backups with operator-loaded drills            | Accepted           | 2026-04-17 |
| [0021](0021-audit-log-and-notifications-single-write-path.md)               | Audit log and notifications — single write path, publisher-over-audit | Accepted           | 2026-04-19 |
| [0022](0022-binary-storage-b2-compliance-object-lock.md)                    | Binary storage on Backblaze B2 with Compliance Object Lock            | Accepted           | 2026-04-22 |
| [0023](0023-notification-rules-db-stored-closed-event-catalog.md)           | Notification rules as DB-stored configuration with a closed catalog   | Accepted           | 2026-04-20 |
| [0024](0024-binary-attachment-e2e-encryption.md)                            | End-to-end encryption of binary attachments                           | Accepted           | 2026-04-30 |
| [0025](0025-realtime-ui-invalidation-via-sse.md)                            | Realtime UI invalidation via Server-Sent Events                       | Accepted           | 2026-05-06 |
| [0026](0026-invoices-immutability-and-zugferd.md)                           | Invoices — immutable snapshot, gapless sequence, ZUGFeRD EN 16931     | Accepted           | 2026-05-12 |
| [0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md)    | Continuous dependency updates with supply-chain scanning              | Accepted           | 2026-05-15 |
| [0028](0028-dependency-ci-coverage-matrix-and-gated-deploy.md)              | Dependency CI: coverage matrix, change-scoped gates, gated deploy     | Accepted           | 2026-11-07 |
