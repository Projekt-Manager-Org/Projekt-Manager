# Stage 1: Build
FROM node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Production
FROM node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Copy migration SQL files (read at runtime by Drizzle migrator)
COPY --from=build /app/src/server/db/migrations ./dist/server/db/migrations

# Copy EN 16931 XSD bundle (read at issuance time by InvoiceRenderer
# for per-render schema validation — defense-in-depth against builder
# regressions; see ARCHITECTURE.md § Invoices Module). After esbuild
# bundling, the validator code is inlined into start.js; its
# `import.meta.url` resolves to `dist/server/start.js`, so the
# computed `path.resolve(__dirname, './xsd/...')` lands at
# `dist/server/xsd/` — that's why the COPY destination flattens the
# source tree's `services/invoice/` segment (same pattern as the
# migrations COPY above).
COPY --from=build /app/src/server/services/invoice/xsd ./dist/server/xsd

# `age` binary — required by KeyEnvelopeService at every download-url /
# bulk-fetch unwrap (ADR-0024). The boot probe reads age-keygen at
# startup; both must be on PATH before the process forks them.
# `findmnt` is used by load-binary-key.sh's tmpfs-invariant check;
# without it the script falls back to /proc/mounts parsing.
# `bash` is required by load-binary-key.sh's shebang. Alpine's BusyBox
# `ash` lacks the bash-isms the script relies on (`[[ ]]`, `$'\004'`,
# `read -d`, `set -o pipefail`); rather than rewrite to POSIX and lose
# byte-for-byte parity with load-drill-key.sh, install bash like the
# backup image does (Dockerfile.backup).
RUN apk add --no-cache age findmnt bash

# Remove npm + npx from the production image. The runtime invokes only
# `node dist/server/start.js` — npm is build-time tooling that, once
# baked into the production layer, becomes recurring CVE surface (e.g.
# CVE-2026-33671 in bundled picomatch). The node binary works without
# npm; nothing in the production code path shells out to `npm`/`npx`.
# Removing them shrinks the image and eliminates this CVE class
# permanently. Aligns with ADR-0027 §Decision.2 + the project's
# refuse-or-block-never-downgrade principle.
#
# Post-rm assertion (`! command -v`) catches regressions where a future
# base-image bump reintroduces npm through a different path (e.g. an
# alpine variant that puts npm under /usr/bin); the build fails loudly
# instead of silently re-surfacing the CVE class. Same RUN to keep the
# invariant atomic with the removal.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
 && ! command -v npm \
 && ! command -v npx

# Operator helper: load the binary `age` private identity into tmpfs
# (ADR-0024 §Operator workflow). Mirrors how Dockerfile.backup installs
# load-drill-key — script lives in repo as *.sh, container path drops
# the suffix so the runbook command stays short.
COPY scripts/binary-key/load-binary-key.sh /usr/local/bin/load-binary-key
RUN chmod +x /usr/local/bin/load-binary-key

# Pinned UID/GID 1001 so the `app` user has a stable, deterministic id
# across image rebuilds. The compose `app` service tmpfs at
# /run/binary-key matches `uid=1001,gid=1001` so the boot probe
# (running as `app`) can read the operator-loaded identity, and
# `load-binary-key` (also running as `app` via `docker exec`) can write
# it. UID 1000 is taken by the upstream node:alpine `node` user; 1001
# leaves room for that without a collision.
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app \
 && chown -R app:app /app

USER app

EXPOSE 3000

CMD ["node", "dist/server/start.js"]
