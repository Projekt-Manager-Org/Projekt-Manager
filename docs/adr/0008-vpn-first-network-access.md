# ADR-0008: VPN-first network access

- **Status:** Accepted
- **Date:** 2026-04-08

## Context

The application is LLM-generated and not independently security-reviewed. Until code-level hardening lands, every access path must sit behind a trust wrapper strong enough to face the public internet in its place.

The wrapper must be **auditable, open-source, and actively maintained**. Auditable-but-unmaintained is a decaying foundation; maintained-proprietary is a blind-trust update channel.

## Decision

**VPN-first network access.** The application is reachable only through a VPN tunnel. Public ports on the server are limited to SSH (22/TCP) and WireGuard (51820/UDP).

**VPN implementation: plain WireGuard** (Linux kernel module, mainlined since kernel 5.6).

**TLS terminates at Caddy regardless of VPN status.** Defense in depth: the VPN restricts _who_ reaches the server, TLS protects _what_ they transmit. Caddy obtains a Let's Encrypt certificate via DNS-01 ACME (Cloudflare provider), so no public port is needed for issuance.

**Client scope: Windows, Android, and desktop Linux.** Windows is the primary office platform per kickoff (`docs/project/kickoff.md` § Target environment — office PCs and laptops run Windows), via the official `wireguard-windows` client, actively maintained. Android is the pilot smartphone platform per kickoff, via `wireguard-android`. Desktop Linux via the official client covers the VPS (Ubuntu) and Linux-based dev machines, not office end users. macOS and iOS are out of scope — no Apple devices in the target company's fleet.

**Single-tenant by design.** If multi-tenancy ever becomes a requirement, the answer is one WireGuard server per tenant (separate VPS, `wg0`, keys, DNS name) — not a retrofit of a shared subnet. Plain WireGuard has no per-peer ACLs beyond `AllowedIPs`, so a shared subnet gives every peer L3 access to every other peer.

### Network topology

- Subnet: `10.213.0.0/22` allocated, `10.213.17.0/24` routed initially
- Server `wg0` at `10.213.17.1/32`, up at boot via `wg-quick@wg0.service`
- Peers at `10.213.17.10+` (one `/32` per peer)
- Caddy binds `10.213.17.1:443` only
- `docker.service` ordered after `wg-quick@wg0.service` via `/etc/systemd/system/docker.service.d/wait-for-wireguard.conf` (`Requires=` + `After=`). Without this, Caddy can race ahead of the interface and fail to bind.

### Trust framing

Three independent layers:

- **Protocol.** WireGuard is audited; multiple formal verifications cover the core construction (Noise IK + Curve25519 + ChaCha20-Poly1305 + BLAKE2).
- **Kernel module.** `wireguard-linux` is in mainline since 5.6; reviewed through the kernel upstream process with fast security-patch pipeline via Ubuntu.
- **Client applications.** Open-source but not independently audited. `wireguard-android` (pilot), `wireguard-linux-tools` (VPS + dev machines), and `wireguard-windows` (primary office platform) are all actively maintained.

Tailscale's clients are also not independently audited, so "audited clients" is not the differentiator. The real differences: Tailscale ships client updates through proprietary app stores we do not review and operates a proprietary coordination server. Plain WireGuard has neither dependency.

## Alternatives considered

- **Tailscale.** Rejected. Proprietary client update path + proprietary coordination server = two production-critical components we cannot inspect.
- **Headscale.** Rejected. Self-hosted server is auditable, but clients are still Tailscale's.
- **Cloudflare Tunnel + Access.** Rejected. TLS terminates at Cloudflare's edge — the browser sees Cloudflare's cert, and Cloudflare decrypts every request. Contradicts the TLS-terminates-at-Caddy principle.
- **Self-signed / `tls internal`.** Rejected. Browser warnings train users to bypass cert warnings — the opposite of what the trust wrapper exists to support.
- **OpenVPN, strongSwan (IPsec).** Rejected. Larger userspace attack surface, slower data plane, worse mobile onboarding, no advantage over WireGuard.
- **Netbird.** Noted as a possible future path if SSO becomes a requirement; younger codebase, thinner audit history than plain WireGuard.

## Consequences

### Positive

- Protocol audited, kernel module mainlined and patched, Android and Windows clients maintained — all four pass the bar.
- Public attack surface is two ports. WireGuard is stealth by default (no response to unauthenticated packets).
- TLS at Caddy with a real Let's Encrypt cert — `HSTS`, `Secure` cookies, and browser security controls all work.
- Reversible. Removing the VPN gate later is a firewall rule + Caddy bind change, not an architectural rewrite.

### Negative

- Plain WireGuard has no PKI or revocation primitive. Removing a peer = edit `wg0.conf` + `wg syncconf`.
- Peer management is manual at pilot scale. Admin web app (tracked separately) automates this above the manual ceiling.
- Mobile friction: the Android client has no trusted-Wi-Fi auto-connect; users toggle the tunnel manually.

### Residual risks (accepted)

- **Hetzner single-box blast radius.** Server WG key, peer keys, Cloudflare token, LE account key, DB/MinIO creds, and session secrets are co-located. Root on the box = full compromise. Same blast radius as any single-VPS deployment; not worsened by the WG choice. Per-service secret separation and multi-host isolation are post-pilot tasks.
- **Cloudflare as CA-equivalent trust root.** A Cloudflare account compromise permits legitimate Let's Encrypt issuance via `_acme-challenge` TXT. CAA pinning does not defend (attacker uses LE legitimately). This is the residual cost of DNS-01 via any public DNS provider. Mitigation: CAA drift alerts, scoped API tokens (`Zone:DNS:Edit` + `Zone:Zone:Read`, never Global API Key), rotation cadence.
- **Manual peer management until admin web app ships.** Offboarding manual; audit trail is `wg0.conf` git history.

## Dep lifecycle health (as of 2026-05-15)

The "Trust framing" section above is the primary lifecycle source. Summarized:

| Dep                     | Status                                       | License                 | Notes                                                                                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WireGuard protocol      | Audited; mainlined in Linux kernel since 5.6 | GPL-2.0 (kernel module) | Multiple formal verifications cover the core construction                                                                                                                                                                                                                                     |
| `wireguard-linux-tools` | Active                                       | GPL-2.0                 | Distro security pipeline tracks it (Ubuntu `unattended-upgrades`)                                                                                                                                                                                                                             |
| `wireguard-android`     | Active (pilot client)                        | Apache-2.0              | Play Store + F-Droid; current release recent. Source: [github.com/WireGuard/wireguard-android](https://github.com/WireGuard/wireguard-android)                                                                                                                                                |
| `wireguard-windows`     | Active                                       | MIT                     | Primary office client — Windows is the target company's office OS per kickoff. Commits as recent as 2026-07-13 (verified 2026-07-15 via `gh api repos/WireGuard/wireguard-windows/commits`). Source: [github.com/WireGuard/wireguard-windows](https://github.com/WireGuard/wireguard-windows) |

## References

- [docs/project/kickoff.md](../project/kickoff.md) § Target environment — source of truth for the target company's device fleet (Windows office PCs, Android smartphones)
- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md)
- [ADR-0005: Session management — HttpOnly cookies](0005-session-management-httponly-cookies.md) — `Secure` flag requires TLS in all deployments
- [ADR-0009: Pin Docker versions across environments](0009-pin-docker-versions-across-environments.md) — related dependency-pin tracking problem
- [docs/ops/server-setup.md](../ops/server-setup.md) — current server configuration and firewall rules
