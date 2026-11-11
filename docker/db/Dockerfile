# The `db` image: upstream Postgres plus Alpine's current fixes.
#
# Docker Official Images rebuild `postgres` when its base image or
# Dockerfile changes, not when an Alpine package does, so the pinned digest
# can ship a package Alpine has already fixed until upstream happens to
# rebuild (#835: krb5-libs and libxslt, fixed in v3.24/main, absent from the
# image for days). `apk upgrade` takes the fix from the branch the pin
# already names, as `Dockerfile` and `Dockerfile.backup` do.
#
# The Postgres binaries, the entrypoint and its initdb behaviour are
# upstream's: they are built from source into /usr/local, which apk does
# not own.
#
# Built, pushed and smoked with the app and backup images in CI
# (.github/actions/build-scan-smoke); the push run's inventory scan scans
# it, and the deploy pulls it by `sha-<commit>`. The `runtime` stage is
# exempt from the layer cache there: a cached upgrade upgrades nothing.
#
# Base digest pinned to the linux/amd64 manifest (docs/ops/dep-management.md
# § Deploy urgency); Renovate bumps it.
FROM postgres:17.11-alpine@sha256:4717f90960a225c2d1c5dac50508c401230f693ff626e06e84e6db0a68ded508 AS runtime

RUN apk upgrade --no-cache

# Nothing runs as root. Upstream's entrypoint starts as root only to chown
# the data and socket directories, then drops to `postgres` (uid 70) via
# gosu; as `postgres` it skips both. The image's own directories are
# already uid 70, so a fresh volume inherits that, and an existing cluster
# was chowned on its first start (the VPS's: all uid 70, 2026-11-11). A
# wrong owner fails the start loudly ("data directory has wrong
# ownership"), never silently.
USER postgres
