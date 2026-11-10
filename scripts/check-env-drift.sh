#!/usr/bin/env bash
#
# Static drift check between src/server/config/env.ts and docker-compose.yml.
#
# Every variable declared in the Zod schema in env.ts MUST be forwarded to
# the app container via `services.app.environment` in docker-compose.yml —
# otherwise the container starts fine, but `process.env.X` is undefined at
# runtime and the app silently falls back to whatever Zod considers the
# default. That class of bug bit us in #57 when BOOTSTRAP_ADMIN_* were
# added to the schema but the compose whitelist was not updated; on the
# first deploy the bootstrap hook took the AC-B4 "nothing set → no-op"
# path instead of firing, and the failure was silent.
#
# This check is grep/awk-based rather than a YAML parser so it has no
# dependencies beyond a standard POSIX toolchain (ubuntu-latest GitHub
# runners ship with mawk, not gawk, so portability matters). It is
# intentionally strict: new vars require explicit placement in the
# compose file or explicit entry in the EXCLUDE list below.

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_TS="src/server/config/env.ts"
COMPOSE="docker-compose.yml"

if [ ! -f "$ENV_TS" ]; then
  echo "ERROR: $ENV_TS not found — run from project root or adjust script path." >&2
  exit 2
fi
if [ ! -f "$COMPOSE" ]; then
  echo "ERROR: $COMPOSE not found — run from project root or adjust script path." >&2
  exit 2
fi

# Vars the app code declares but intentionally DOES NOT consume at runtime.
# DOMAIN is used by Caddy (Caddyfile) and for display purposes; the app
# container has no code path that reads it. If this list grows, document
# the reason inline so future drift does not become "just add it to the
# exclude list" by reflex.
EXCLUDE_PATTERN='^(DOMAIN)$'

# --- Extract env var names from the Zod schema ----------------------------
# Matches lines like `  BOOTSTRAP_ADMIN_USERNAME: z.string().optional(),` —
# 2-space indent, UPPER_SNAKE_CASE identifier, colon. Any Zod pattern works
# after the colon; we only care about the name.
schema_vars=$(grep -oE '^  [A-Z_][A-Z0-9_]+:' "$ENV_TS" | tr -d ' :' | sort -u)

if [ -z "$schema_vars" ]; then
  echo "ERROR: no env vars found in $ENV_TS — did the schema format change?" >&2
  exit 2
fi

# --- Extract env var names from services.{app,backup}.environment ---------
# State-machine awk: track whether we are inside one of the backend
# services' `environment:` block, emit only UPPER_SNAKE var names at
# 6-space indent.
#
# Both `app` and `backup` share the env.ts Zod schema because the
# backup compose service runs code bundled from the same TypeScript
# tree (Dockerfile.backup layers the dist/ produced by the app image —
# see ADR-0020). A variable forwarded to either service is considered
# "wired" for this pass — it does not enforce *which* service consumes
# the var. Service-specific placement is asserted elsewhere:
# feature-manifest.test.ts pins that every var in a FEATURE_CATALOG
# entry's `requires` lands in `services.app.environment` so the
# deploy pre-flight CLI (which runs inside the app container) sees it
# when computing `formatFeatureManifest()`.
compose_backend_vars=$(awk '
  # A top-level service name: 2-space indent, identifier, colon, EOL.
  /^  [a-z][a-zA-Z0-9_-]*:[[:space:]]*$/ {
    svc = $0
    sub(/^  /, "", svc)
    sub(/:[[:space:]]*$/, "", svc)
    in_backend = (svc == "app" || svc == "backup")
    in_env = 0
    next
  }
  # `environment:` key inside the current service (4-space indent).
  in_backend && /^    environment:[[:space:]]*$/ { in_env = 1; next }
  # Any other 4-space property ends the environment block.
  in_backend && in_env && /^    [a-zA-Z]/ { in_env = 0 }
  # Env var entry at 6-space indent inside the environment block.
  in_backend && in_env && /^      [A-Z_][A-Z0-9_]+:/ {
    name = $1
    sub(/:.*$/, "", name)
    print name
  }
' "$COMPOSE" | sort -u)

if [ -z "$compose_backend_vars" ]; then
  echo "ERROR: no env vars found in $COMPOSE services.{app,backup}.environment — did the compose format change?" >&2
  exit 2
fi

# --- Diff and report ------------------------------------------------------
# Vars in the schema minus exclusions.
schema_to_check=$(echo "$schema_vars" | grep -vE "$EXCLUDE_PATTERN" || true)

missing=$(comm -23 <(echo "$schema_to_check") <(echo "$compose_backend_vars") || true)

if [ -n "$missing" ]; then
  echo "ERROR: env.ts declares vars that are NOT in docker-compose.yml services.{app,backup}.environment:" >&2
  echo "$missing" | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Add the missing vars to the appropriate service's environment block" >&2
  echo "in docker-compose.yml — services.app.environment for web-request code" >&2
  echo "paths, services.backup.environment for the Layer 2 backup runner." >&2
  echo "Without that, the container cannot see them at runtime and the Zod" >&2
  echo "schema silently falls back to defaults (or the code sees undefined)." >&2
  echo "" >&2
  echo "If a variable is intentionally not consumed by either backend service" >&2
  echo "(e.g. consumed by Caddy or another service), add it to the" >&2
  echo "EXCLUDE_PATTERN in $(basename "$0") with an inline reason." >&2
  exit 1
fi

echo "OK: $ENV_TS ↔ $COMPOSE services.{app,backup}.environment in sync"
echo "  schema vars checked: $(echo "$schema_to_check" | wc -l)"
echo "  excluded: $(echo "$schema_vars" | grep -cE "$EXCLUDE_PATTERN" || echo 0)"

# ==========================================================================
# Pass 2: compose `${VAR}` interpolations ↔ (.env.production.example ∪
# secrets.manifest.txt)
#
# The base compose file refers to operator-supplied values via
# `${VAR}` (bare — becomes the empty string when unset, app typically
# fails at runtime) or `${VAR:?…}` (compose aborts file parse). Either
# form means the operator MUST supply the value — so the key has to
# be documented in exactly one of:
#
#   .env.production.example  — non-secret site config (operator edits
#                               in plaintext, copy-paste workflow).
#   secrets.manifest.txt     — secrets sourced from `secrets.env.age`
#                               (age-encrypted).
#
# A key documented in BOTH is a config ambiguity (is the operator
# supposed to put it in .env or in secrets.env.age?) — we fail that
# too.
#
# APP_IMAGE_TAG is the one permitted bare / `:?` reference that is
# NOT operator-supplied: scripts/deploy.sh exports it from the target
# SHA. Exclude it here.
#
# `${VAR:-default}` references are OPTIONAL (compose supplies the
# default); they are not required to appear in either file and are
# skipped here. Documentation of optionals in .env.production.example
# is a style choice the drift check does not enforce.
# ==========================================================================

ENV_EXAMPLE="${ENV_EXAMPLE:-.env.production.example}"
SECRETS_MANIFEST="${SECRETS_MANIFEST:-secrets.manifest.txt}"

# Extract compose interpolation names where the operator MUST supply
# a value (either as-a-declaration or as-a-non-empty-value):
#   ${VAR}       — bare, no default → required (empty falls through to
#                                    the app layer, usually crash-loops).
#   ${VAR?...}   — gated, compose aborts on UNSET. Empty allowed.
#   ${VAR:?...}  — gated, compose aborts on UNSET or EMPTY.
# Explicitly exclude `${VAR:-...}` and `${VAR-...}` (optional defaults).
# The regex `(:?\?[^}]*)?` matches "optional colon, literal `?`, message"
# so both gate forms are caught; `:-default` does not match because the
# literal `?` is absent.
compose_required=$(grep -oE '\$\{[A-Z_][A-Z0-9_]*(:?\?[^}]*)?\}' "$COMPOSE" \
  | sed -E 's/^\$\{([A-Z_][A-Z0-9_]*).*$/\1/' \
  | grep -vxF 'APP_IMAGE_TAG' \
  | sort -u)

if [ -z "$compose_required" ]; then
  echo "ERROR: no operator-required \${VAR} references found in $COMPOSE — grep pattern broken?" >&2
  exit 2
fi

# Extract non-comment KEY names from .env.production.example. A
# commented example line (`# FOO=`) is treated as OPTIONAL and NOT
# a declaration — operators are not expected to set it.
example_keys=""
if [ -f "$ENV_EXAMPLE" ]; then
  example_keys=$(grep -E '^[A-Z_][A-Z0-9_]*=' "$ENV_EXAMPLE" | sed 's/=.*$//' | sort -u)
else
  echo "ERROR: $ENV_EXAMPLE not found — the drift check needs it as the canonical non-secret env template." >&2
  exit 2
fi

# Extract keys from secrets.manifest.txt. One KEY per line, shell-style
# comments (`# …`) and blank lines ignored. Values are never stored in
# this file — it is a keyset manifest, not a template.
manifest_keys=""
if [ -f "$SECRETS_MANIFEST" ]; then
  manifest_keys=$(grep -E '^[A-Z_][A-Z0-9_]*$' "$SECRETS_MANIFEST" | sort -u)
else
  echo "ERROR: $SECRETS_MANIFEST not found — every deployment's secrets.env.age keyset is driven off this file." >&2
  exit 2
fi

if [ -z "$manifest_keys" ]; then
  echo "ERROR: $SECRETS_MANIFEST has no keys — did the format change? Expected one KEY per line." >&2
  exit 2
fi

# Overlap check: a key in BOTH files is an ambiguity.
overlap=$(comm -12 <(echo "$example_keys") <(echo "$manifest_keys") || true)
if [ -n "$overlap" ]; then
  echo "ERROR: keys present in BOTH $ENV_EXAMPLE and $SECRETS_MANIFEST — a key must live in exactly one place:" >&2
  echo "$overlap" | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Decide which surface owns the key (plaintext .env vs encrypted secrets.env.age)" >&2
  echo "and remove the duplicate from the other file." >&2
  exit 1
fi

# Coverage check: every operator-required compose interpolation must
# be in exactly one of the documentation surfaces.
documented=$(cat <(echo "$example_keys") <(echo "$manifest_keys") | sort -u)
missing_doc=$(comm -23 <(echo "$compose_required") <(echo "$documented") || true)
if [ -n "$missing_doc" ]; then
  echo "ERROR: $COMPOSE references operator-supplied vars that are documented nowhere:" >&2
  echo "$missing_doc" | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Add each var to exactly one of:" >&2
  echo "  - $ENV_EXAMPLE    (non-secret site config — plaintext, operator copies to .env)" >&2
  echo "  - $SECRETS_MANIFEST (secret — value lives encrypted in secrets.env.age)" >&2
  echo "" >&2
  echo "If the var is actually optional in compose (has a \${VAR:-default}), ignore" >&2
  echo "this error — but double-check the compose line: a bare \${VAR} falls back to" >&2
  echo "the empty string silently, which is almost never the intended default." >&2
  exit 1
fi

echo "OK: $COMPOSE operator-required vars ↔ ($ENV_EXAMPLE ∪ $SECRETS_MANIFEST) in sync"
echo "  compose-required: $(echo "$compose_required" | wc -l)"
echo "  .env.example keys: $(echo "$example_keys" | wc -l)"
echo "  secrets.manifest.txt keys: $(echo "$manifest_keys" | wc -l)"

# ==========================================================================
# Pass 3: schema (env.ts) ↔ operator-documented set (.env.production.example
# ∪ secrets.manifest.txt)
#
# Pass 1 catches schema vars not forwarded by compose (#57 BOOTSTRAP_ADMIN_*
# fix). Pass 2 catches compose `${VAR}` interpolations not documented for
# operators. Pass 3 catches the orthogonal third class: a schema var that
# IS forwarded by compose AND consumed by the app, but never surfaces in
# operator docs — so an operator setting up a fresh deploy has no way of
# discovering the knob exists. The classic regression: a new feature lands
# with `OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}` in compose, and works
# silently with the empty default in production until someone wonders why
# the LLM extraction is "broken".
#
# In the other direction, an operator-doc entry without a matching schema
# field is stale documentation pointing at a removed feature — also fail.
#
# Compose-derived schema vars (DATABASE_URL built from POSTGRES_PASSWORD,
# STORAGE_* hardcoded by compose, PORT hardcoded) are excluded — operators
# never set them directly; the SOURCE values they're built from are the
# documented surface. Symmetrically, compose-only infrastructure vars in
# operator docs (POSTGRES_PASSWORD, MINIO_ROOT_*, CLOUDFLARE_API_TOKEN,
# WG_BIND_IP) feed into compose interpolation but never reach the app's
# Zod schema, so they're excluded on the docs side.
# ==========================================================================

# Schema-side exclusions: vars the operator never sets directly because
# compose-yml hardcodes them or builds them from another (documented)
# source. Each entry MUST carry a one-line reason; "obvious" is not a
# valid reason — the next person reading this file deserves the why.
SCHEMA_DOC_EXCLUDE=$(cat <<'EOF'
DATABASE_URL          # compose builds from POSTGRES_PASSWORD (documented in secrets.manifest.txt)
NODE_ENV              # compose hardcodes "production"; an operator override is the wrong surface to expose
PORT                  # compose hardcodes "3000"; not an operator-tunable surface
HOST                  # compose hardcodes "0.0.0.0"; not an operator-tunable surface
STORAGE_KEY_PREFIX    # test-only knob — vitest sets `test-<pid>/` via process.env (src/test/integration-setup.ts); production leaves it unset
EOF
)

# Docs-side exclusions: operator-doc entries that feed into compose
# interpolation but never reach the app's Zod schema. They surface in
# operator docs because the operator must set them; the schema sees the
# downstream value compose builds (e.g. DATABASE_URL).
DOC_SCHEMA_EXCLUDE=$(cat <<'EOF'
POSTGRES_PASSWORD     # compose interpolation source for DATABASE_URL; app sees the URL, not the password
CLOUDFLARE_API_TOKEN  # consumed only by the caddy service for ACME-DNS-01; no app-schema footprint
WG_BIND_IP            # consumed only by the caddy service's port binding (${WG_BIND_IP:-127.0.0.1})
EOF
)

# Strip the trailing comments and produce one KEY per line. The `awk
# '{print $1}'` is the mawk-portable way to pick the first whitespace-
# delimited token; `cut -d' ' -f1` would fail on the multi-space alignment
# above, and a sed regex would be heavier. Empty lines are filtered too.
schema_exclude_keys=$(echo "$SCHEMA_DOC_EXCLUDE" \
  | awk 'NF { print $1 }' | sort -u)
doc_exclude_keys=$(echo "$DOC_SCHEMA_EXCLUDE" \
  | awk 'NF { print $1 }' | sort -u)

# Operator-documentation keys: live KEY= and commented `# KEY=` in the
# example file (both forms count — a commented optional is still a hint
# the operator can find), plus every key in the manifest. The example
# regex anchors `# ` (pound + single space) at line start so prose like
# "the ${VAR}=…" cannot smuggle a stray match in mid-sentence.
example_doc_keys=""
if [ -f "$ENV_EXAMPLE" ]; then
  example_doc_keys=$(grep -E '^(# )?[A-Z_][A-Z0-9_]*=' "$ENV_EXAMPLE" \
    | sed -E 's/^# //; s/=.*$//' | sort -u)
fi
documented_keys=$(cat <(echo "$example_doc_keys") <(echo "$manifest_keys") \
  | sort -u)

# Schema keys minus schema-side exclusions.
schema_to_check=$(comm -23 <(echo "$schema_vars") <(echo "$schema_exclude_keys") || true)

# Documented keys minus docs-side exclusions.
docs_to_check=$(comm -23 <(echo "$documented_keys") <(echo "$doc_exclude_keys") || true)

# (a) Schema fields with no operator-doc entry — these are knobs the
# operator can never discover from the docs. Adding the var to either
# .env.production.example (commented optional is fine) or
# secrets.manifest.txt closes the gap.
schema_undocumented=$(comm -23 <(echo "$schema_to_check") <(echo "$documented_keys") || true)
if [ -n "$schema_undocumented" ]; then
  echo "ERROR: $ENV_TS declares vars that are documented nowhere for operators:" >&2
  echo "$schema_undocumented" | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Each var must appear in exactly one of:" >&2
  echo "  - $ENV_EXAMPLE     (non-secret operator config — commented optional is fine)" >&2
  echo "  - $SECRETS_MANIFEST (secret — the value lives encrypted in secrets.env.age)" >&2
  echo "" >&2
  echo "If the var is genuinely compose-derived or hardcoded (operator never sets" >&2
  echo "it directly), add it to SCHEMA_DOC_EXCLUDE in $(basename "$0") with a" >&2
  echo "one-line reason." >&2
  exit 1
fi

# (b) Documentation entries that are not in the schema — stale docs.
docs_unschemaed=$(comm -23 <(echo "$docs_to_check") <(echo "$schema_vars") || true)
if [ -n "$docs_unschemaed" ]; then
  echo "ERROR: operator docs declare keys that are NOT in $ENV_TS:" >&2
  echo "$docs_unschemaed" | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Either remove the stale entry from $ENV_EXAMPLE / $SECRETS_MANIFEST," >&2
  echo "or — if the key feeds compose interpolation that builds another schema" >&2
  echo "var (e.g. POSTGRES_PASSWORD → DATABASE_URL) — add it to" >&2
  echo "DOC_SCHEMA_EXCLUDE in $(basename "$0") with a one-line reason." >&2
  exit 1
fi

echo "OK: $ENV_TS ↔ ($ENV_EXAMPLE ∪ $SECRETS_MANIFEST) keyspaces in sync"
echo "  schema vars checked: $(echo "$schema_to_check" | wc -l)"
echo "  documented keys checked: $(echo "$docs_to_check" | wc -l)"
echo "  schema-side exclusions: $(echo "$schema_exclude_keys" | wc -l)"
echo "  docs-side exclusions: $(echo "$doc_exclude_keys" | wc -l)"
