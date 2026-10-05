# syntax=docker/dockerfile:1.24@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

# Custom Caddy build with the caddy-dns/cloudflare DNS provider plugin.
# Required for DNS-01 ACME challenges per ADR-0008 §Network topology.
#
# Pinning policy:
# - Caddy version pinned to a specific tag (xcaddy build vN.N.N).
# - Both base images digest-pinned to defeat retag-under-known-good-label attacks.
# - The caddy-dns/cloudflare plugin pinned to a specific git SHA, so each build is
#   reproducible from source.
#
# Renovate tracks all three (Caddy releases, base-image digests, plugin master SHA) and
# auto-merges patch/minor/digest bumps on green CI; majors get a manual-review PR.
# See ADR-0027 + docs/ops/dep-management.md.

FROM caddy:2.11.6-builder@sha256:f5b1a66449d305280e559dba0ab9f7ce9a2a14c527c79d7c6fb48abc8f895818 AS builder

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    xcaddy build v2.11.6 \
        --with github.com/caddy-dns/cloudflare@a8737d095ad5a48ca031cea6ab704057dbc2d250

FROM caddy:2.11.6@sha256:3422ce6de165df66534f9b9ba50efaf457114ec961763cc52f5dbdaac2972d73

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
