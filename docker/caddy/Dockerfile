# syntax=docker/dockerfile:1.24@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

# Custom Caddy build with the caddy-dns/cloudflare DNS provider plugin.
# Required for DNS-01 ACME challenges per ADR-0008 §Network topology.
#
# Pinning policy (ADR-0008 + #52):
# - Caddy version is pinned to a specific tag
# - Both base images are also digest-pinned to defeat retag-under-known-good-label attacks
# - The caddy-dns/cloudflare plugin is pinned to a specific git SHA, not a moving tag,
#   so the build is fully reproducible from source
#
# Bumping any of the three pins is a manual review gate per #52.

FROM caddy:2.11.3-builder@sha256:aa338f10bbce3e395b6f57061b1c3c53d1e54b83e10ce2395420d1e60f3f6819 AS builder

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    xcaddy build v2.11.4 \
        --with github.com/caddy-dns/cloudflare@a8737d095ad5a48ca031cea6ab704057dbc2d250

FROM caddy:2.11.3@sha256:ec18ee54aab3315c22e25f3b2babda73ff8007d39b13b3bd1bfffa2f0444c7d9

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Non-root runtime (Trivy DS-0002). Caddy needs to bind :443 (the only
# published port — see docker-compose.yml services.caddy); CAP_NET_BIND_SERVICE
# as a file capability lets the unprivileged binary do that without root.
# Standard rootless web-server hardening (cf. nginx-unprivileged, Bitnami).
#
# UID 1000 is chosen so Docker's empty-named-volume initialization stamps
# caddy_data and caddy_config with caddy:caddy ownership on a fresh `compose
# up`.
RUN addgroup -S -g 1000 caddy \
 && adduser  -S -D -H -u 1000 -G caddy -s /sbin/nologin caddy \
 && setcap   cap_net_bind_service=+ep /usr/bin/caddy \
 && chown -R caddy:caddy /data /config

USER caddy
