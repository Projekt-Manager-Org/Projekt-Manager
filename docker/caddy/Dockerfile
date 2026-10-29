# syntax=docker/dockerfile:1.24@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

# Custom Caddy build with the caddy-dns/cloudflare DNS provider plugin.
# Required for DNS-01 ACME challenges per ADR-0008 §Network topology.
#
# Pinning policy:
# - Caddy version pinned to a specific tag (xcaddy build vN.N.N).
# - Both base images digest-pinned to defeat retag-under-known-good-label attacks.
# - The caddy-dns/cloudflare plugin pinned to a specific git SHA, so each build is
#   reproducible from source.
# - golang.org/x/net and go-jose/v4 pinned above Caddy's own requirement (see the build step).
#
# Renovate tracks all four (Caddy releases, base-image digests, plugin master SHA,
# the Go module pins) and
# auto-merges patch/minor/digest bumps on green CI; majors get a manual-review PR.
# See ADR-0027 + docs/ops/dep-management.md.

FROM caddy:2.11.7-builder@sha256:c2fc374fd352439d76e1777b28d97d9f6d9c1dd86116db9227460374d46097d5 AS builder

# The first two `--with` lines raise Go modules above what Caddy 2.11.7
# (latest on 2026-10-27) requires, because only a Caddy release would
# otherwise move them: golang.org/x/net v0.59.0 → v0.60.0 (five HIGH
# advisories) and go-jose/v4 v4.1.5 → v4.1.6 (GHSA-mgcc-cww5-fp2q).
# xcaddy blank-imports each `--with` path, so it names a package Caddy
# already links (x/net's module root has none). xcaddy runs one
# `go get <module> caddy@<version>` per `--with`, in order: a later Caddy
# requiring a newer version fails the build rather than downgrade, and
# listing them before the plugin lets its own `go get` raise them instead
# of being downgraded to fit. Renovate bumps both (go datasource,
# customManager in renovate.json).
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    xcaddy build v2.11.7 \
        --with golang.org/x/net/http2@v0.62.0 \
        --with github.com/go-jose/go-jose/v4@v4.1.6 \
        --with github.com/caddy-dns/cloudflare@a8737d095ad5a48ca031cea6ab704057dbc2d250

# Source of the runtime's few files, not the runtime itself. Kept as a
# digest-pinned stage so Renovate's `caddy` group still moves it in
# lockstep with the builder and the xcaddy version, and the CA bundle
# below rides those bumps.
FROM caddy:2.11.7@sha256:504a44d7d74bd2bc28a66afc4774912fc21223ca8a67734af1c54ab2f999b489 AS base

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# CAP_NET_BIND_SERVICE as a file capability lets the unprivileged binary
# bind :443 (the only published port — docker-compose.yml services.caddy)
# without relying on the daemon's unprivileged-port sysctl. Set here
# because scratch has no setcap; the COPY below carries the xattr.
RUN setcap cap_net_bind_service=+ep /usr/bin/caddy

# Runtime: the static Caddy binary, a CA bundle (ACME and the Cloudflare
# API) and its two state directories — no OS packages. Caddy links no
# system library and the stack runs nothing else in this container (no
# healthcheck; the deploy smoke probes from the host), so a package
# layer was pure attack surface that went stale: #637 measured
# brotli-libs and curl HIGHs in it, unfixed by the upstream rebuild.
# Without it there are no OS packages to patch. The binary itself is
# reproducible (measured: a cached host-style build and a no-cache CI
# build give the same sha256), so the nightly scans what the host runs.
FROM scratch

COPY --from=base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
# UID 1000 so Docker's empty-named-volume initialization stamps caddy_data
# and caddy_config with the runtime user's ownership on a fresh `compose up`.
COPY --from=base --chown=1000:1000 /data /data
COPY --from=base --chown=1000:1000 /config /config
COPY --from=base /usr/bin/caddy /usr/bin/caddy

# The base image's environment, which scratch does not inherit: XDG_* is
# where Caddy keeps certificates and autosaved config (the two volumes).
ENV PATH=/usr/bin \
    XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data

# Non-root runtime (Trivy DS-0002).
USER 1000:1000

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
