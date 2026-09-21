#!/bin/sh
# Configure the MinIO bucket to mirror the prod B2 surface — Object Lock,
# Versioning, default Compliance retention, a lifecycle rule that reaps
# hidden versions, AND a capability-restricted app user that mirrors
# the prod B2 app key (writeFiles, readFiles, listFiles only — no
# deleteFiles). See ADR-0022 and docs/ops/object-storage-provisioning.md.
#
# Idempotent: re-running settles the bucket and IAM state to the desired
# shape without failing on existing resources. Object Lock can only be
# set at bucket-creation time on MinIO, so a pre-existing unlocked
# bucket is dropped and recreated (dev-only data, throwaway).

set -e

TIMEOUT=30
ELAPSED=0

# Wait for MinIO to be ready (max ${TIMEOUT}s)
until mc alias set minio http://storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "ERROR: MinIO not ready after ${TIMEOUT}s"
    exit 1
  fi
  echo "Waiting for MinIO... (${ELAPSED}/${TIMEOUT}s)"
  sleep 1
done

BUCKET_DEV="$STORAGE_BUCKET"
# E2E and integration-test buckets are optional. The dev compose stack
# and the e2e CI workflow set both; the prod-shape ci.yml `check` job
# that also runs this script sets neither. When unset, only the dev
# bucket is provisioned and the IAM policy below scopes to a single
# bucket ARN — preserving the prior behaviour for any caller that
# hasn't opted in to the isolation.
BUCKET_E2E="${STORAGE_BUCKET_E2E:-}"
BUCKET_TEST="${STORAGE_BUCKET_TEST:-}"
LOCK_DAYS="${STORAGE_OBJECT_LOCK_DAYS:-1}"
HIDE_TTL_DAYS="${STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS:-2}"

if [ -n "$BUCKET_E2E" ] && [ "$BUCKET_E2E" = "$BUCKET_DEV" ]; then
  echo "ERROR: STORAGE_BUCKET_E2E ('$BUCKET_E2E') must differ from STORAGE_BUCKET" >&2
  echo "       — isolation requires distinct buckets." >&2
  exit 1
fi
if [ -n "$BUCKET_TEST" ] && [ "$BUCKET_TEST" = "$BUCKET_DEV" ]; then
  echo "ERROR: STORAGE_BUCKET_TEST ('$BUCKET_TEST') must differ from STORAGE_BUCKET" >&2
  echo "       — isolation requires distinct buckets." >&2
  exit 1
fi
if [ -n "$BUCKET_TEST" ] && [ -n "$BUCKET_E2E" ] && [ "$BUCKET_TEST" = "$BUCKET_E2E" ]; then
  echo "ERROR: STORAGE_BUCKET_TEST ('$BUCKET_TEST') must differ from STORAGE_BUCKET_E2E" >&2
  echo "       — isolation requires distinct buckets." >&2
  exit 1
fi

# Provision one bucket end-to-end: create-if-missing (recreating an
# unlocked pre-existing bucket — Object Lock cannot be added after the
# fact on MinIO; dev attachment data is throwaway), then settle
# versioning, default Compliance retention, and the lifecycle rule.
configure_bucket() {
  bucket="$1"

  if mc ls "minio/$bucket" >/dev/null 2>&1; then
    if ! mc retention info "minio/$bucket" >/dev/null 2>&1; then
      echo "WARN: bucket '$bucket' exists without Object Lock — recreating."
      echo "      Local attachment data will be destroyed. Re-seed if needed."
      mc rb --force "minio/$bucket"
      mc mb --with-lock --with-versioning "minio/$bucket"
    fi
  else
    mc mb --with-lock --with-versioning "minio/$bucket"
  fi

  # Belt-and-braces: --with-versioning at create-time enables it, but a
  # downstream operator could have suspended it. Idempotent re-enable.
  mc version enable "minio/$bucket" >/dev/null

  # Default Compliance retention — auto-applied per upload, mirroring B2's
  # bucket-default. The PUT result returns the version id which the app
  # persists for restore.
  mc retention set --default compliance "${LOCK_DAYS}d" "minio/$bucket"

  # Lifecycle: reap noncurrent versions HIDE_TTL_DAYS days after they
  # become noncurrent. On a versioned bucket, DeleteObject without a
  # VersionId demotes the current version to noncurrent and writes a
  # delete marker — that's the "hide". NoncurrentDays counts from the
  # demotion, matching B2's daysFromHidingToDeleting semantic.
  # --expire-delete-marker cleans up the dangling marker after the
  # noncurrent version is reaped (otherwise it sits forever as a zombie).
  #
  # Idempotent: clear-all then add. Cheaper than diffing existing rules,
  # and dev-loop cost is irrelevant.
  mc ilm rule remove --all --force "minio/$bucket" >/dev/null 2>&1 || true
  mc ilm rule add \
    --noncurrent-expire-days "$HIDE_TTL_DAYS" \
    --expire-delete-marker \
    "minio/$bucket"

  echo "Bucket '$bucket' ready: Object Lock=Compliance/${LOCK_DAYS}d, NoncurrentDays=${HIDE_TTL_DAYS}, expire-delete-marker=true."
}

configure_bucket "$BUCKET_DEV"
if [ -n "$BUCKET_E2E" ]; then
  configure_bucket "$BUCKET_E2E"
fi
if [ -n "$BUCKET_TEST" ]; then
  configure_bucket "$BUCKET_TEST"
fi

# -----------------------------------------------------------------------
# Capability-restricted app user (#45 / ADR-0022).
#
# Prod (B2) uses an app key with writeFiles, readFiles, listFiles only —
# no deleteFiles. The boot-time capability self-test in
# src/server/storage/safety.ts depends on the running credential lacking
# the destroy capability, so dev MinIO must provision an equivalent user
# instead of letting the app run as root. Without this, the probe
# returns 'unexpected-success' on dev startup and the server refuses to
# serve.
#
# Required env (compose-gated `:?` upstream so missing values fail the
# deploy rather than producing an empty user/password here):
#   MINIO_APP_ACCESS_KEY  — username for the app
#   MINIO_APP_SECRET_KEY  — password for the app
# -----------------------------------------------------------------------

if [ -z "${MINIO_APP_ACCESS_KEY:-}" ] || [ -z "${MINIO_APP_SECRET_KEY:-}" ]; then
  echo "ERROR: MINIO_APP_ACCESS_KEY and MINIO_APP_SECRET_KEY must be set"
  echo "       (gated by compose \`:?\` substitution; this branch should be unreachable)"
  exit 1
fi

POLICY_NAME="projekt-manager-app"
POLICY_FILE="/tmp/${POLICY_NAME}.json"

# Bucket-scoped least-privilege policy. Allow list mirrors what the app
# actually does:
#   - GetBucketLocation / GetBucketVersioning / GetBucketObjectLockConfiguration
#     / GetLifecycleConfiguration → boot-time bucket-safety probe reads
#     these to validate the runbook-pinned bucket shape.
#   - ListBucket / ListBucketVersions → prefix listing for the orphan
#     reaper and Papierkorb listing.
#   - GetObject / GetObjectVersion → download path + restore copy source.
#   - PutObject → upload + CopyObject (restore).
#   - DeleteObject (no version-id) → hide path; on a versioned bucket
#     this writes a delete marker and is non-destructive.
#
# Deny block — explicit denials of the destruction capabilities the
# prod B2 app key also lacks. MinIO's "deny overrides allow" semantic
# makes this a hard guardrail: even if a downstream policy mutation
# allowed these, the deny here would still win. Required because
# MinIO's IAM evaluator treats some `s3:Delete*` granular actions as
# subsumed by an `s3:DeleteObject` allow, so omission alone is not
# enough — a `DeleteObjectCommand` carrying a VersionId is granted
# unless `s3:DeleteObjectVersion` is explicitly denied.
#   - s3:DeleteObjectVersion          (would destroy a specific version)
#   - s3:BypassGovernanceRetention    (would bypass GOVERNANCE locks; we
#                                      use COMPLIANCE so this is moot,
#                                      but defensive omission is cheap)
#   - s3:PutObjectLegalHold          (would let the app apply a legal hold)
# s3:PutObjectRetention IS granted — parity with the B2 key's
# writeFileRetentions. Rendered invoice PDFs are PUT with their own
# Compliance lock (ADR-0026), which needs it; Compliance retention can
# only be extended, never shortened, so the capability split holds.
# Bucket-mutating actions (PutBucket*, DeleteBucket*, PutLifecycleConfig)
# are absent from the allow list and not explicitly listed here — the
# implicit-deny floor handles them and there is no granular-action
# subsumption issue at the bucket scope.
#
# Resource arrays list every provisioned bucket. With STORAGE_BUCKET_E2E
# set (dev + e2e CI), the app user can read/write both the dev bucket and
# the isolated e2e bucket — the playwright webServer overrides
# STORAGE_BUCKET to the e2e value so test runs target the e2e ARN, leaving
# the dev bucket untouched. Without STORAGE_BUCKET_E2E (the prod-shape
# `check` job), only the dev ARN is granted.
RESOURCES_BUCKET="\"arn:aws:s3:::$BUCKET_DEV\""
RESOURCES_OBJECTS="\"arn:aws:s3:::$BUCKET_DEV/*\""
if [ -n "$BUCKET_E2E" ]; then
  RESOURCES_BUCKET="$RESOURCES_BUCKET,\"arn:aws:s3:::$BUCKET_E2E\""
  RESOURCES_OBJECTS="$RESOURCES_OBJECTS,\"arn:aws:s3:::$BUCKET_E2E/*\""
fi
if [ -n "$BUCKET_TEST" ]; then
  RESOURCES_BUCKET="$RESOURCES_BUCKET,\"arn:aws:s3:::$BUCKET_TEST\""
  RESOURCES_OBJECTS="$RESOURCES_OBJECTS,\"arn:aws:s3:::$BUCKET_TEST/*\""
fi

cat > "$POLICY_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetBucketObjectLockConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:ListBucket",
        "s3:ListBucketVersions"
      ],
      "Resource": [${RESOURCES_BUCKET}]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:PutObjectRetention",
        "s3:DeleteObject"
      ],
      "Resource": [${RESOURCES_OBJECTS}]
    },
    {
      "Effect": "Deny",
      "Action": [
        "s3:DeleteObjectVersion",
        "s3:BypassGovernanceRetention",
        "s3:PutObjectLegalHold"
      ],
      "Resource": [${RESOURCES_OBJECTS}]
    }
  ]
}
EOF

# `mc admin policy create` overwrites an existing policy of the same
# name, so re-running is safe.
mc admin policy create minio "$POLICY_NAME" "$POLICY_FILE" >/dev/null

# `mc admin user add` returns non-zero if the user already exists. Probe
# first with `info` and skip the add when it's already there — re-running
# init-storage on a populated MinIO must not fail.
if mc admin user info minio "$MINIO_APP_ACCESS_KEY" >/dev/null 2>&1; then
  echo "User '$MINIO_APP_ACCESS_KEY' already exists — skipping create."
else
  mc admin user add minio "$MINIO_APP_ACCESS_KEY" "$MINIO_APP_SECRET_KEY" >/dev/null
fi

# Attach the policy. Idempotent on this mc version — re-attaching an
# already-attached policy returns success. Suppress stderr just in case
# a future mc version starts complaining; the subsequent `info` call
# below verifies the attachment landed regardless.
mc admin policy attach minio "$POLICY_NAME" --user "$MINIO_APP_ACCESS_KEY" >/dev/null 2>&1 || true

# Verify: the user must show the projekt-manager-app policy attached.
# A drift here (policy detached, missing, or replaced) means the boot-
# time capability self-test will misclassify and refuse to serve, so
# fail loud at provisioning time instead. The mc image has no
# grep/sed/awk, only mc + a coreutils subset, so we feed `mc admin user
# info --json` through shell case-match on the policyName field. Output
# is one line of JSON like
#   {"status":"success","accessKey":"<u>","policyName":"<p>","userStatus":"enabled"}
USER_INFO_JSON=$(mc admin user info --json minio "$MINIO_APP_ACCESS_KEY" 2>/dev/null || true)
case "$USER_INFO_JSON" in
  *"\"policyName\":\"${POLICY_NAME}\""*) : ;;
  *)
    echo "ERROR: user '$MINIO_APP_ACCESS_KEY' is missing policy '$POLICY_NAME' after attach."
    echo "  Got: $USER_INFO_JSON"
    exit 1
    ;;
esac

rm -f "$POLICY_FILE"

echo "App user '$MINIO_APP_ACCESS_KEY' provisioned with bucket-scoped policy '$POLICY_NAME' (no DeleteObjectVersion)."
