#!/usr/bin/env bash
#
# Manual pull-based deploy for Projekt-Manager.
#
# Run on the VPS by the operator over WireGuard, as the `deploy` user:
#
#   sudo -u deploy /opt/projekt-manager/scripts/deploy.sh                                  # origin/main (default)
#   sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/<branch>                  # track a feature branch
#   sudo -u deploy /opt/projekt-manager/scripts/deploy.sh 3721783abc                       # rollback to a specific SHA
#
# The script replaces .github/workflows/deploy.yml. See ADR-0012
# (docs/adr/0012-manual-pull-based-deploy-over-wireguard.md) for the
# rationale behind removing the push-based GHA deploy path. The artifact
# pipeline (CI → GHCR, ADR-0011) is unchanged — this script only replaces
# the distribution-to-host leg.
#
# Preconditions on the VPS:
#   - /opt/projekt-manager is a git clone of Projekt-Manager-Org/Projekt-Manager
#   - /opt/projekt-manager/secrets.env.age exists (age-encrypted env file)
#   - `age` is installed
#   - no GHCR credential is needed: the packages are public (ADR-0011)
#
set -euo pipefail

REF="${1:-origin/main}"
REPO_DIR="/opt/projekt-manager"
SECRETS_FILE="$REPO_DIR/secrets.env.age"

cd "$REPO_DIR"

# Two-phase structure. Phase 1 (DEPLOY_REEXEC unset) fetches, checks out
# the target SHA, and re-execs. Phase 2 (DEPLOY_REEXEC=1) is the rest of
# the deploy, and runs from the target-SHA version of this script.
#
# Why: bash parses `$0` into memory once, at invocation time. The code
# that runs after `git checkout` is still the version bash read BEFORE
# the checkout — which is the *previous* working-tree's deploy.sh, not
# the target SHA's. A roll-forward-then-rollback-then-forward sequence
# silently executes the intermediate SHA's deploy.sh logic on the
# third run (see 2026-04-17 session: first deploy at 773b2b4's
# deploy.sh pulled only `app`; target was e047704 which expected
# `--profile backup pull app backup` — backup image was never pulled
# and the backup service never started; observed as "up 5/5" vs the
# expected 6/6). Re-exec'ing with the newly-checked-out script drives
# the feature matrix from the target SHA, not from whatever happened
# to be on disk at invocation.
if [ "${DEPLOY_REEXEC:-0}" != "1" ]; then
  git fetch origin

  EXPECTED_SHA="$(git rev-parse "$REF")"
  echo "Deploying $REF -> $EXPECTED_SHA"

  # Assert the checkout landed on the expected SHA. Without this, a silently
  # failed checkout (e.g. uncommitted local changes blocking the switch)
  # would continue past with a stale working tree and deploy the wrong code —
  # the exact failure mode hit in iteration 4 (#48 comment 2026-04-08).
  git checkout "$EXPECTED_SHA"
  actual="$(git rev-parse HEAD)"
  if [ "$actual" != "$EXPECTED_SHA" ]; then
    echo "ERROR: git checkout landed at $actual, expected $EXPECTED_SHA" >&2
    exit 1
  fi

  # Hand off to Phase 2 running on the newly-checked-out script. The
  # env flag is both a circuit-breaker (no infinite re-exec loop) and
  # the signal Phase 2 uses to skip the fetch/checkout it already ran.
  export DEPLOY_REEXEC=1
  exec "$0" "$@"
fi

# --- Phase 2 -----------------------------------------------------------
# We are guaranteed to be running the target SHA's deploy.sh. HEAD was
# moved to EXPECTED_SHA in Phase 1, so `git rev-parse HEAD` recovers it
# without needing Phase 1 to thread state across the exec boundary.
EXPECTED_SHA="$(git rev-parse HEAD)"
echo "(continuing deploy at $EXPECTED_SHA)"

# Pin the exact SHA-tagged image so this deploy is reproducible and a
# rollback is just re-running with an older SHA. Both `app` and `backup`
# images are produced by this repo and share APP_IMAGE_TAG — CI pushes
# them as a pair per commit SHA (see .github/workflows/ci.yml
# publish job and ADR-0020 §Decision for the backup image).
#
# Exported HERE — before any compose invocation in Phase 2 — because
# the docker-compose.yml `image:` lines for `app` and `backup` use
# the `${APP_IMAGE_TAG:?…}` gate. Without an early export, even a
# read-only `compose ps` (used by the baseline-state pre-flight
# below) trips the gate and exits non-zero — silently, with stderr
# redirected to /dev/null — bypassing the pre-flight check it was
# meant to gate. Regression observed 2026-05-03 in the 148-binary-e2e
# deploy: a baseline-schema mismatch slipped past the guard, hit the
# in-app baseline-guard at boot, and surfaced as a smoke-probe
# timeout instead of a clean pre-flight abort.
export APP_IMAGE_TAG="sha-$EXPECTED_SHA"

# Decrypt secrets into the shell env.
#
# Two changes vs. the previous `source <(age -d …)` form:
#
# 1. Capture-then-eval instead of process substitution. The old form
#    ran age and `source` concurrently (age writing to a FIFO that
#    `source` drained); a 2026-05-03 deploy hit a state where age
#    exited with `incorrect passphrase` without ever showing the
#    prompt, and the script silently fell through to the manifest
#    pre-flight (which then reported every key as missing because
#    nothing got sourced). The exact age/tty interaction at fault
#    isn't pinned down, but command substitution runs age to
#    completion BEFORE bash touches its output, removing the
#    concurrency from the picture entirely.
#
# 2. Capture into a named variable rather than `eval "$(age -d …)"`
#    inline, so that `set -e` aborts the deploy on age failure. With
#    `eval "$(cmd)"`, a failing cmd produces empty input and eval
#    succeeds — the script would still limp into the manifest check
#    instead of stopping at the real error.
#
# Plaintext lives in `SECRETS_PLAINTEXT` for one statement and is
# unset immediately; never written to disk (same property the old
# form had).
SECRETS_PLAINTEXT="$(age -d "$SECRETS_FILE")"
set -a
# shellcheck disable=SC1090
eval "$SECRETS_PLAINTEXT"
set +a
unset SECRETS_PLAINTEXT

# --- Pre-flight: env/secrets parity check --------------------------------
# Catch operator-side drift: a new key was added to
# `.env.production.example` or `secrets.manifest.txt` since the last
# time the operator synced, but the deployed `.env` / `secrets.env.age`
# was never updated to match. Without this check the deploy proceeds,
# compose interpolates the missing var as an empty string (bare `${X}`
# has no default), and the app either crash-loops on Zod validation or
# — worse — silently runs misconfigured. Abort BEFORE touching the
# running stack: no pull, no restart, no traffic shift until the
# operator has synced.
#
# Two files, two sources of truth, one assertion each:
#   - `.env.production.example` keys ⊆ `/opt/projekt-manager/.env`
#   - `secrets.manifest.txt` keys  ⊆ (env vars exported above)
#
# The secrets check reads from the current process env (populated by
# the `source <(age -d …)` above) rather than re-parsing the encrypted
# file, so we don't prompt for the passphrase twice.

env_example_keys=""
if [ -f "$REPO_DIR/.env.production.example" ]; then
  env_example_keys=$(grep -E '^[A-Z_][A-Z0-9_]*=' "$REPO_DIR/.env.production.example" \
    | sed 's/=.*$//' | sort -u)
fi

env_actual_keys=""
if [ -f "$REPO_DIR/.env" ]; then
  env_actual_keys=$(grep -E '^[A-Z_][A-Z0-9_]*=' "$REPO_DIR/.env" | sed 's/=.*$//' | sort -u)
fi

if [ -n "$env_example_keys" ]; then
  missing_env=$(comm -23 <(echo "$env_example_keys") <(echo "$env_actual_keys") || true)
  if [ -n "$missing_env" ]; then
    echo "ERROR: $REPO_DIR/.env is missing keys declared in .env.production.example:" >&2
    echo "  - ${missing_env//$'\n'/$'\n'  - }" >&2
    echo "" >&2
    echo "Sync the keys (preserving existing values) before deploying. See" >&2
    echo "docs/ops/manual-deploy.md for the edit-in-place workflow." >&2
    exit 1
  fi
fi

missing_secrets=""
if [ -f "$REPO_DIR/secrets.manifest.txt" ]; then
  while IFS= read -r key; do
    # `${!key+x}` is bash indirection: expands to 'x' when $key names a
    # set variable (even set to empty), empty otherwise. We accept empty
    # values — the manifest only asserts declaration; Zod still rejects
    # malformed values at container start.
    if [ -z "${!key+x}" ]; then
      missing_secrets="${missing_secrets}${key}"$'\n'
    fi
  done < <(grep -E '^[A-Z_][A-Z0-9_]*$' "$REPO_DIR/secrets.manifest.txt")
fi

if [ -n "$missing_secrets" ]; then
  echo "ERROR: secrets.env.age is missing keys declared in secrets.manifest.txt:" >&2
  printf '%s' "$missing_secrets" | sed '/^$/d; s/^/  - /' >&2
  echo "" >&2
  echo "Rotate secrets.env.age to include the missing keys before deploying" >&2
  echo "(docs/ops/manual-deploy.md § Rotate a secret)." >&2
  exit 1
fi

# --- Pre-flight: baseline schema-state recurrence guard --------------
# Drizzle records baseline migrations by sha256 hash in
# `drizzle.__drizzle_migrations.hash`. An edit to 0000_baseline.sql
# produces a new hash, but `migrate()` skips re-applying it because the
# old hash is already in the ledger — the live DB stays on the previous
# schema while schema.ts and the SQL describe the new one. The first
# request that touches a new column 500s with
# `column "<X>" does not exist`.
#
# This guard compares the on-disk sha256 of the baseline file (the
# same digest drizzle-orm uses to populate the ledger — sha256 over
# the raw file content) to the recorded ledger entry, and aborts the
# deploy BEFORE `compose up` recreates app containers and starts
# routing traffic to a stale schema.
#
# Fresh-DB cases fall through cleanly: db service absent (first
# deploy / wiped container), migrations table absent (wiped volume,
# app hasn't booted yet), or ledger empty. The next `compose up`
# runs migrate() which populates the ledger.
#
# Recovery procedure: docs/ops/recover-from-schema-change.md.
echo "Pre-flight: checking baseline schema state..."
expected_baseline_hash=$(sha256sum "$REPO_DIR/src/server/db/migrations/0000_baseline.sql" \
  | awk '{print $1}')

if docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  # `2>/dev/null || true` collapses every non-success state (table
  # absent, ledger empty, transient psql error) to an empty string —
  # all interpreted as "no comparison possible, fall through". The
  # outer `compose ps` guard already proved the service is up, so the
  # table-absent path is the only legitimate empty outcome we expect
  # here.
  recorded_baseline_hash=$(docker compose exec -T db \
    psql -U pm -d projekt_manager -tAc \
    "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id ASC LIMIT 1;" \
    2>/dev/null | tr -d '[:space:]' || true)

  if [ -n "$recorded_baseline_hash" ] && \
     [ "$recorded_baseline_hash" != "$expected_baseline_hash" ]; then
    echo "ERROR: baseline schema mismatch — DB ledger does not match 0000_baseline.sql." >&2
    echo "  expected (file): $expected_baseline_hash" >&2
    echo "  recorded (db):   $recorded_baseline_hash" >&2
    echo "" >&2
    echo "Drizzle records baselines by hash; an edit to 0000_baseline.sql is" >&2
    echo "silently no-op'd against an existing ledger. Continuing this deploy" >&2
    echo "would 500 on the first request that touches a new column." >&2
    echo "" >&2
    echo "See docs/ops/recover-from-schema-change.md." >&2
    exit 1
  fi
fi

# `docker compose pull` only pulls services that declare an `image:`
# — `db` and `storage` use pinned registry images (unchanged); `app`
# and `backup` resolve via APP_IMAGE_TAG (exported in Phase 2 setup
# above). --profile backup is needed on BOTH `pull` and `up` — without
# it on pull, the backup service is filtered out of the active set and
# its image is never fetched ahead of `up -d` (which would then block
# on a registry round-trip while starting).
#
# `--policy missing` is what makes the local cache below a real rollback
# store rather than decoration. `app`/`backup` tags are immutable
# `sha-<commit>`, so "already present locally" and "identical bytes" are
# the same statement — re-pulling one buys nothing and, once GHCR
# retention has reaped that tag, the pull 404s under `set -e` and aborts
# a deploy whose image is sitting on the disk. Measured 2026-09-04: of
# the three image-sets IMAGE_RETENTION keeps, two were already gone from
# GHCR; the third held only on a GHCR_KEEP_EXTRA pin, since removed.
# Same reasoning as Kubernetes' `imagePullPolicy: IfNotPresent` for
# non-moving tags: the registry is the cold path, the host cache is the
# warm one.
docker compose --profile backup pull --policy missing app backup

# Caddy uses `build: ./docker/caddy` (locally built, not a registry
# pull), so `compose up -d` below does NOT auto-rebuild on Dockerfile
# changes — the cached `projekt-manager-caddy` image is reused even
# after a base-image or xcaddy version bump (regression observed
# 2026-05-16: a Caddy 2.11.2 → 2.11.3 bump landed in the repo but the
# VPS kept running 2.11.2 until a manual rebuild). Docker's layer cache
# makes this a near-no-op when nothing changed; on a real bump it picks
# up the new pins. Safe to run unconditionally — the env was sourced
# from secrets.env.age in Phase 2 setup, so the compose-file env
# interpolation (CLOUDFLARE_API_TOKEN, …) resolves.
docker compose build caddy

# --- Pre-flight: schema-level env validation + feature manifest ------
# Two checkpoints in one ephemeral container:
#
# 1. `validateEnvAggregated()` runs schema + every cross-field guard
#    (AC-231). The two presence checks above (env_example_keys,
#    secrets.manifest.txt) only assert that keys are *declared*; they
#    do not catch shape errors (PORT=0, NODE_ENV=staging, SEED=maybe),
#    nor the dev-default-credential check the schema folds in. A
#    misconfiguration that gets past the presence check would
#    otherwise crash-loop the freshly-recreated container — losing the
#    previous-revision's known-good replicas before the new replicas
#    are healthy. This step catches it without touching the running
#    stack.
#
# 2. `formatFeatureManifest()` prints the same per-feature manifest
#    the app emits at boot (`event = 'config-feature-manifest'`),
#    formatted for the operator's terminal so the operator sees what
#    will be enabled / disabled BEFORE `docker compose up` recreates
#    containers (AC-230). The boot-time JSON emission still lands in
#    the app's stdout for log aggregation; this is the deploy-time
#    operator mirror.
#
# Why `docker compose run --rm --no-deps app` (not `docker run`):
#   - The compose `app.environment:` block hardcodes DATABASE_URL,
#     STORAGE_*, NODE_ENV, PORT (built from operator vars via `${VAR}`
#     interpolation). A standalone `docker run` would see only the
#     operator-supplied env (POSTGRES_PASSWORD, ...) and the schema
#     would reject DATABASE_URL as missing — a false positive that
#     does not match what the actual `up` will give the container.
#     `compose run` resolves the same `environment:` block the live
#     container receives, so the validation environment matches the
#     deploy environment exactly.
#   - `--no-deps` skips starting `db` / `storage` (they may already be
#     up, and we don't need them to validate env). `--rm` removes the
#     one-shot container immediately. `-T` disables TTY allocation so
#     the call works in non-interactive deploy contexts (cron, CI).
#   - The CMD `node /app/dist/server/deploy-preflight-cli.js` runs the
#     dedicated entry built by `package.json` > `build:server` esbuild
#     target list. It prints the aggregated error and exits non-zero
#     on any validation offence; deploy.sh's `set -euo pipefail`
#     propagates the failure and aborts BEFORE `docker compose up`
#     runs. On success, it prints the feature manifest before exiting 0.
echo "Pre-flight: validating env and reporting feature manifest..."
docker compose run --rm --no-deps -T app node /app/dist/server/deploy-preflight-cli.js

# The backup service is behind a profile so local dev (no R2 creds)
# doesn't spin up a cron loop that will log AccessDenied on every
# scheduled tick. See docs/ops/backup/setup.md §4 and ADR-0020.
docker compose --profile backup up -d

# --- Binary-key reload (operator-loaded; ADR-0024 boot probe) --------
# Container recreation wipes the tmpfs at /run/binary-key. The app boot
# probe (assertBinaryIdentityLoaded) waits up to 5 minutes for the
# identity file to appear before declaring boot failure (see
# binaryIdentity.ts DEFAULT_WAIT_TIMEOUT_MS) — the immediate-throw
# version combined with `restart: unless-stopped` produced a crash-
# restart loop that killed this docker-exec'd loader mid-`read`
# (regression observed 2026-05-03 in the 148-binary-e2e deploy).
#
# We still prompt for the paste here rather than relying on the
# probe's wait window alone: (a) the paste is an operational
# acknowledgment, not just a file-write — the operator confirms they
# are present and the right keypair is loaded — and (b) the smoke
# probe (60s) downstream needs to start AFTER the paste lands so
# its window measures "did the app start?" rather than "did the
# operator paste in time?". Sequence: compose up → operator paste →
# smoke gate → caddy reload.
#
# The drill-key block (further down) runs AFTER the smoke probe because
# its container has no boot gate — backups serve in degraded mode if
# the drill key is missing.
#
# Skip when the tmpfs is still warm (compose-only changes that didn't
# recreate the app container).
if docker exec projekt-manager-app-1 test -s /run/binary-key/identity 2>/dev/null; then
  echo "Binary identity already in tmpfs — skipping reload."
else
  echo
  echo "==> Loading binary identity (operator paste; ADR-0024 tmpfs-only)"
  # `-it` allocates a pseudo-TTY so load-binary-key's `read -s` actually
  # suppresses echo. A missed paste keeps the app DOWN — the boot
  # probe is fail-closed (it eventually throws on timeout, no degraded
  # mode) — so we abort the deploy rather than pretend "verified"
  # downstream.
  if ! docker exec -it projekt-manager-app-1 load-binary-key; then
    echo "ERROR: binary identity not loaded — aborting deploy." >&2
    echo "       The app boot probe is fail-closed (ADR-0024); without the" >&2
    echo "       identity the next container start will refuse to serve." >&2
    echo "       Re-run the deploy after resolving the paste failure, or:" >&2
    echo "       docker exec -it projekt-manager-app-1 load-binary-key" >&2
    exit 1
  fi
fi

# Smoke test: probe /api/health from inside the app container, bypassing
# Caddy and the TLS chain. Verifies app + db + storage are reachable
# without depending on the network-layer topology. Single source of truth
# in scripts/smoke-app-health.sh — same probe CI and sync-restore use.
# Per-attempt failure reasons surface inline so a degraded-storage 503
# doesn't look identical to "container still starting".
if ! ./scripts/smoke-app-health.sh projekt-manager-app-1 60; then
  # Include the backup container in the failure dump — its profile
  # must match `up -d` above, otherwise compose filters it out of
  # the active service set and the logs command silently skips it.
  docker compose --profile backup logs --tail=50
  exit 1
fi

# Caddy graceful reload — re-reads the bind-mounted Caddyfile in place
# so site-block additions (e.g. the `storage.${DOMAIN}` block introduced
# when the storage subdomain wiring landed) take effect on the first
# deploy that ships them.
#
# `docker compose up -d` above only recreates containers whose resolved
# compose stanza differs from the running one; Caddy's stanza is stable
# across most deploys even when its bind-mounted Caddyfile changes. On
# top of that, a file bind-mount pins the container's inode at creation
# time — replacing the on-host file (which is what `git checkout` does
# for any tracked change) leaves the container's file descriptor open on
# the old inode for the current Caddy process lifetime. A `docker restart`
# re-mounts with the new inode but does NOT re-read compose env, so it
# can swap Caddyfile content but keep stale secrets (e.g. CLOUDFLARE_API_TOKEN
# after a rotation). Neither behaviour is obvious enough to remember at
# deploy time.
#
# `caddy reload` sidesteps both by hitting the admin API (bound to
# localhost:2019 inside the container) to re-parse /etc/caddy/Caddyfile
# against the process's current env. Connections stay open across the
# swap. Safe to call every deploy — Caddy exits 0 and logs "config is
# unchanged" when nothing differs.
echo "Reloading Caddy config..."
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --force

# --- Drill-key reload (operator-loaded; AC-175 tmpfs-only) -----------
# Container recreation wipes the tmpfs at /run/drill-key. Until the
# operator re-pastes the age private identity, every Tier 2 drill tick
# silently skips (services/backup-drill.ts: outcome='skipped' on absent
# key — by design, but the badge stays at "noch nie ausgeführt" until
# a successful drill writes meta_backup_status.lastDrillAt). Folding
# the reload into the deploy session — same TTY the operator used to
# decrypt secrets.env.age above — closes the gap without weakening
# AC-175: load-drill-key still reads the paste over a restricted-mode
# stdin and writes only to tmpfs.
#
# Skip when the tmpfs is still warm (compose-only changes that didn't
# recreate the backup container). docker exec exits non-zero if the
# file is absent OR empty — `test -s` covers both. Stderr is redirected
# because a "no such file" error is the expected absent path.
if docker exec projekt-manager-backup-1 test -s /run/drill-key/identity 2>/dev/null; then
  echo "Drill key already in tmpfs — skipping reload."
else
  echo
  echo "==> Loading drill key (operator paste; AC-175 tmpfs-only)"
  # `-it` allocates a pseudo-TTY so load-drill-key's `read -s` actually
  # suppresses echo. Failure here does not abort the deploy — app and
  # backups are already serving — but a loud warning prevents the
  # "silent skip until the badge goes amber days later" trap.
  if ! docker exec -it projekt-manager-backup-1 load-drill-key; then
    echo "WARN: drill key not loaded — Tier 2 drills will skip until you run:" >&2
    echo "      docker exec -it projekt-manager-backup-1 load-drill-key" >&2
  fi
fi

# --- Post-deploy: image garbage collection (host-side retention) ------
# Each deploy pulls a fresh `sha-<commit>` app+backup pair and builds a
# new caddy layer; nothing here reclaimed the superseded ones, so they
# accumulated one image-set per deploy. App/backup layers are
# node_modules-heavy (thousands of tiny files) and exhaust INODES long
# before bytes: 2026-05-29 the box hit 100% inodes at 78% disk with 122
# images, and the next deploy died mid-pull with an overlayfs "no space
# left on device". This is the host-side analogue of kubelet image GC /
# an ECR lifecycle policy: keep a small rollback window of the
# most-recent tags, expire the rest.
#
# Placed LAST, after the stack is verified healthy. Each running
# container's live tag is excluded from pruning BY NAME — not by trusting
# `docker rmi` to refuse an in-use image. That refusal only fires when
# the tag is the image's sole reference; if a CI promote re-tag left the
# image with a second tag, `docker rmi` would silently UNTAG the live,
# compose-pinned ref instead, breaking the next restart. By-name
# exclusion also protects a rollback target (an older running tag that
# falls outside the recency window). Pruning is housekeeping, not a
# deploy gate: every command is failure-tolerant so a reclaim hiccup
# cannot fail an already-successful deploy.
#
# Retention is count-based (bounds inodes regardless of deploy frequency,
# unlike an age window): keep the live tag + the newest
# IMAGE_RETENTION-1 other tags per repo image (default 3 ⇒ current + 2
# rollback targets). Override via DEPLOY_IMAGE_RETENTION.
IMAGE_RETENTION="${DEPLOY_IMAGE_RETENTION:-3}"
echo "Pruning superseded images (keep ${IMAGE_RETENTION} per image, plus dangling + build cache)..."

prune_repo_image() {
  # Resolve the live ref from the running container, so this auto-adapts
  # to a registry/org rename — we only prune the exact repo we run.
  local container="$1"
  local ref repo
  ref="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null)" || ref=""
  if [ -z "$ref" ]; then
    echo "WARN: could not resolve image for $container — skipping its image GC." >&2
    return 0
  fi
  repo="${ref%:*}"
  # Newest-first by CreatedAt (host is UTC, single daemon ⇒ one TZ ⇒
  # lexical = chronological). Always skip the live tag and any <none>
  # rows; among the remaining tags keep the newest IMAGE_RETENTION-1 and
  # untag the rest by `repo:tag` (never by image ID — untagging one tag
  # must not delete an image a kept tag still points to).
  docker images "$repo" --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' \
    | sort -r \
    | awk -F'|' -v keep="$IMAGE_RETENTION" -v live="$ref" '
        $2 ~ /<none>/ { next }
        $2 == live    { next }
        { n++ }
        n > keep - 1  { print $2 }' \
    | xargs -r docker rmi 2>/dev/null || true
}

prune_repo_image projekt-manager-app-1
prune_repo_image projekt-manager-backup-1

# Reclaim dangling (<none>) images — chiefly superseded `docker compose
# build caddy` layers, which the per-repo pass above cannot see (they
# carry no repository). Dangling-only: never touches a tagged or in-use
# image, and is the path that actually reclaims the recurring caddy-
# rebuild inode sink.
docker image prune -f >/dev/null 2>&1 || true

# Build cache has no rollback semantics, so an age window (not a count)
# is the right bound; tune via DEPLOY_BUILD_CACHE_MAX_AGE. Pruned rather
# than wiped (-a) so an unchanged caddy build stays a near-no-op.
docker builder prune -f --filter "until=${DEPLOY_BUILD_CACHE_MAX_AGE:-168h}" >/dev/null 2>&1 || true

echo "Deploy verified — healthy at $(git rev-parse --short HEAD)"
