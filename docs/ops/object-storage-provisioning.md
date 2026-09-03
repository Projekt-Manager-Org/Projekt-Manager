# Object storage provisioning (Backblaze B2 + MinIO dev parity)

[ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md) requires a versioned bucket with Compliance Object Lock plus a `daysFromHidingToDeleting` lifecycle rule. The app key cannot destroy versions — destruction is a provider-side lifecycle action only. This runbook captures the bucket and key configuration in prod (Backblaze B2) and the dev mirror (MinIO).

## Sizing dials

| Symbol | Meaning                                                       | Current value | Notes                                                                                                |
| ------ | ------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `R`    | Default Compliance retention (days) — auto-applied per upload | `1`           | Operator-mistake recovery window. Sized for the iterating-friction phase; bump when real data lands. |
| `L`    | Lifecycle `daysFromHidingToDeleting` (days)                   | `2`           | Trash-bin TTL after a hide. Same: bump for prod.                                                     |

**Required: `R ≤ L`.** With `R > L` the lifecycle would attempt to reap noncurrent versions still protected by Object Lock retention, leaving zombie versions on every reap cycle until `R` elapses — incoherent on its face. The boot-time safety probe refuses to start under `R > L`.

To adjust:

- B2 console → bucket → Object Lock → "Default Retention Policy for Bucket". Change applies to **future uploads only**; existing versions keep their original retention.
- B2 console → bucket → Lifecycle Settings → edit `daysFromHidingToDeleting`. Change applies bucket-wide immediately.
- Dev mirror: re-run `docker compose up storage-init` after changing `STORAGE_OBJECT_LOCK_DAYS` or `STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS` in `.env`.

## B2 bucket — one-time portal setup

Done in the B2 web UI:

1. Create bucket `prmng-object-storage`:
   - Files: **private**
   - Encryption: **disabled** — the SSE-B2 option provides at-rest encryption with a Backblaze-held key. Not end-to-end: the provider can still decrypt, so it adds no confidentiality guarantee against a hostile-or-compromised B2. ADR-0020 covers e2e via age for the R2 backup path; binaries may follow if real e2e becomes a requirement.
   - Object Lock: **enabled** — irreversible, cannot be added later
2. Bucket → Object Lock → Default Retention: **Compliance**, `R` days.
3. Bucket → Lifecycle Settings → Use custom lifecycle rules → `daysFromHidingToDeleting = L`.

Deny-listed (do **not** set):

- `daysFromUploadingToHiding` — would auto-hide live data.
- Any lifecycle rule other than `daysFromHidingToDeleting`.
- Governance retention — bypassable by capability; defeats the layered defense.
- Bucket-wide legal-hold defaults.

## App key — via `b2` CLI

The B2 web UI cannot create capability-restricted keys; it grants only coarse Read / Write. Use the CLI:

```bash
# 1. Authorize once with master credentials (interactive — type yourself):
b2 account authorize <masterKeyId> <masterAppKey>

# 2. Create the bucket-scoped app key:
b2 key create --bucket prmng-object-storage prmng-app \
  readBuckets,readBucketLifecycleRules,readBucketRetentions,listFiles,readFiles,writeFiles,writeFileRetentions
```

Why these seven capabilities, no more, no fewer:

| Capability                 | Why it is needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listFiles`                | `s3:ListBucket` / `s3:ListBucketVersions` — orphan reaper sweeps, Papierkorb listing, AND the storage liveness probe used by `/api/health` (a bounded `ListObjectsV2`, not `HeadBucket`). B2 maps `HeadBucket` to `b2_list_buckets` which requires the account-scoped `listAllBucketNames` capability — bucket-scoped keys cannot hold it. See `src/server/storage/client.ts` (`ping()`) for the canonical replacement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `readFiles`                | `s3:GetObject` / `s3:GetObjectVersion` — download path + restore copy source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `writeFiles`               | `s3:PutObject` (uploads) AND `s3:DeleteObject` without `VersionId` — the **hide** path. B2 dispatches version-less `DeleteObject` to `b2_hide_file` which requires `writeFiles` only; the destructive `b2_delete_file_version` requires `deleteFiles`, which this key lacks. The capability split per ADR-0022.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `writeFileRetentions`      | `s3:PutObjectRetention` — required by B2 specifically for `CopyObject` on a bucket with default Compliance retention (the **restore** path). B2's S3-compat layer writes the inherited retention timestamp as part of the copy and silently HANGS the request without this capability — verified empirically against B2 in 2026-04: `writeFiles` alone produces an indefinite stall followed by 503 ServiceUnavailable; adding `writeFileRetentions` makes the same call succeed in <200ms. MinIO does not surface this quirk (`s3:PutObjectRetention` is not required for CopyObject under default Compliance retention there). The cap escalation is bounded — per the [B2 Object Lock docs](https://www.backblaze.com/docs/cloud-storage-object-lock), `writeFileRetentions` only allows EXTENDING existing retention timestamps; Compliance retention "cannot be removed by any user," and shortening governance retention requires the separate `bypassGovernance` cap which this key still lacks. The integrity invariant from ADR-0022 (no version destroyed before its retention expires) is preserved; the marginal new attack surface is cost-DoS via extended locks on attacker-uploaded or existing files. |
| `readBuckets`              | `s3:GetBucketVersioning` — boot-time probe checks Versioning=Enabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `readBucketLifecycleRules` | `s3:GetBucketLifecycleConfiguration` — boot-time probe walks every lifecycle rule. B2's S3-compat surface gates this op behind its own cap (separate from generic bucket-metadata reads).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `readBucketRetentions`     | `s3:GetObjectLockConfiguration` — boot-time probe checks Compliance retention. Without this cap, B2 returns `not entitled` (the API surface filters retention info per-cap).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The boot-time probe is non-negotiable: it runs on every startup and refuses to serve if it can't read the bucket's actual config (ADR-0022 / `src/server/storage/safety.ts`). Three of the seven caps above exist solely to let the probe do its three reads.

The create command prints the secret on stdout **once** — listing keys later shows IDs but never the secret again:

```
<keyId> <applicationKey>
```

Capture both values immediately:

- `STORAGE_ACCESS_KEY` (= `keyId`) → plain `.env` on the VPS (non-secret operator config; B2 keyIds are short opaque identifiers, not credentials by themselves).
- `STORAGE_SECRET_KEY` (= `applicationKey`) → `secrets.env.age` (the actual secret half; deploy.sh's manifest pre-flight rejects a missing entry).

Verify the key has only the intended capabilities:

```bash
b2 key list | grep prmng-app
# expected: "<keyId> prmng-app … readBuckets,readBucketLifecycleRules,readBucketRetentions,listFiles,readFiles,writeFiles,writeFileRetentions"
```

If `deleteFiles`, `bypassGovernance`, `writeFileLegalHolds`, `writeBuckets`, `writeBucketRetentions`, or any other `write*` bucket-config capability appears — revoke (`b2 key delete <keyId>`) and recreate. Those would either break the capability split (version destruction, retention bypass) or let the running app mutate bucket policy out from under itself. `writeFileRetentions` is intentionally INCLUDED above (not on this deny list) — it is the cap B2 requires for `CopyObject` to succeed under default Compliance retention; see the table row for the bounded scope of what it allows.

### Master-key handling

The master key has `deleteFiles` and can destroy versions outside their retention window. Per ADR-0022:

- Stored offline (password manager). Not on the VPS, not in any deploy artifact, not in CI.
- Used **only** for provisioning, key rotation, audited maintenance.
- Never set as `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` on any running service.

App-key rotation: create the new key first, deploy the new credentials, verify, then revoke the old key with `b2 key delete <oldKeyId>`.

## CORS rule on the bucket

The browser uploads attachments directly to B2 via presigned PUT and downloads via presigned GET. Same-origin policy still applies, so the bucket must echo `Access-Control-Allow-Origin: https://<your-domain>` on the preflight or every upload aborts client-side with no server-side trace.

Use the `b2` CLI — the web UI's CORS form does not surface every required field (`exposeHeaders`, `maxAgeSeconds`, multiple `allowedOperations`) and silently saves a partial rule that the app's presigned uploads will fail against:

```bash
b2 bucket update prmng-object-storage allPrivate --cors-rules '[
  {
    "corsRuleName": "prmng-presigned",
    "allowedOrigins": ["https://<your-domain>"],
    "allowedOperations": ["s3_put", "s3_get", "s3_head"],
    "allowedHeaders": ["*"],
    "exposeHeaders": ["x-amz-version-id"],
    "maxAgeSeconds": 3600
  }
]'
```

Notes on the arguments:

- `allPrivate` is the bucket's **type**, not a flag — `b2 bucket update` requires it as a positional even when the type is unchanged.
- `allowedOrigins` is exactly one origin: replace `<your-domain>` with the actual `${DOMAIN}` you set in `.env`. No trailing slash, no wildcard, no scheme variants.
- `allowedOperations` lists the three S3 verbs the presigned flows use: `s3_put` (browser uploads), `s3_get` (downloads + bulk-zip pickup), `s3_head` (rare CORS-preflight headers). `s3_post` is deliberately omitted — B2 does not implement browser-based POST uploads (it returns 501 NotImplemented), and the app uses presigned PUT instead. Leaving `s3_post` in the rule is harmless but misleading. B2 also exposes `b2_*` natives — leave those off; the app only speaks S3.
- `exposeHeaders` includes `x-amz-version-id` so the client can log the version id post-upload. Harmless if unused.

Verify the rule landed:

```bash
b2 bucket get prmng-object-storage | jq '.corsRules'
# expected: an array with one rule matching the above
```

## Wire the deploy

The app reads object-storage config via `STORAGE_*` env vars. Five live in plain `.env` (operator config), one lives in `secrets.env.age` (the secret half):

| Variable                  | Source               | Example value                               |
| ------------------------- | -------------------- | ------------------------------------------- |
| `STORAGE_ENDPOINT`        | `.env`               | `https://s3.eu-central-003.backblazeb2.com` |
| `STORAGE_REGION`          | `.env`               | `eu-central-003`                            |
| `STORAGE_BUCKET`          | `.env`               | `prmng-object-storage`                      |
| `STORAGE_ACCESS_KEY`      | `.env`               | `<keyId from b2 key create>`                |
| `STORAGE_PUBLIC_ENDPOINT` | `.env` (leave empty) | (empty — browser hits B2 directly)          |
| `STORAGE_SECRET_KEY`      | `secrets.env.age`    | `<applicationKey from b2 key create>`       |

The split mirrors the AWS SigV4 model: the `keyId` is the public identifier on every signed request (analogous to an AWS access key id) — it lives in `.env` so an operator inspecting the running config can see which key is in use. Only the `applicationKey` is secret, and only the secret half belongs in `secrets.env.age`. **Do not** put `STORAGE_ACCESS_KEY` in `secrets.env.age` — anyone debugging "is the right key wired up?" is going to grep `.env` first, and the encrypted file's whole point is to hide the secret material from that lookup. Keeping `keyId` outside the encrypted file also lets `secrets.manifest.txt`'s pre-flight catch a missing secret without needing to decrypt to find the keyId for the error message.

`STORAGE_ENDPOINT` and `STORAGE_REGION` must agree on the region. Mismatched values fail SigV4 verification on every call with `SignatureDoesNotMatch`. The endpoint is shown on the bucket's page in the B2 console under "S3 API"; the region is the same string in the host name.

`STORAGE_PUBLIC_ENDPOINT` is intentionally empty for the B2 topology — the app signs presigned URLs against `STORAGE_ENDPOINT` and the browser hits B2 directly with no reverse proxy. (The previous MinIO-on-VPS topology required `https://storage.<DOMAIN>` reverse-proxying through Caddy; that path is gone.)

After updating `.env` and `secrets.env.age`:

```bash
# On VPS — preflight runs schema + feature manifest + storage reachability
# probe + upload-verb probe inside a one-shot container BEFORE
# `docker compose up` recreates anything. Aborts the deploy on the first
# failure.
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh
```

The preflight CLI runs five checks against the deploy environment inside an ephemeral one-shot container before any service container is recreated:

1. `validateEnvAggregated()` — schema + every cross-field guard.
2. Feature manifest — same per-feature breakdown the app emits at boot, formatted for the operator's terminal.
3. `client.ping()` against the live bucket — `ListObjectsV2` exercising the actual `STORAGE_ACCESS_KEY` + `STORAGE_SECRET_KEY` against the real endpoint.
4. **Upload-verb probe** — signs a presigned PUT to `__probe/upload`, executes it with a 1-byte body + matching `Content-MD5`, asserts a 2xx response. Catches the class of provider gaps step 3 cannot see: in particular, B2's S3-compatible API does not implement browser-based POST uploads (it returns `501 NotImplemented`), and the B2 cutover surfaced exactly that gap as a confusing browser-side CORS error at first user upload. Verifying the upload verb here means a future provider cutover that drops PUT, breaks SigV4 signed-header binding, or changes the `Content-MD5` contract surfaces at deploy time, not at first user upload.
5. **CopyObject-verb probe** — copies `__probe/upload` (just written by step 4) to `__probe/copyobj` with a tight per-call timeout, asserts a 2xx response. This is the canary for the **restore** flow (`copyFromVersion` in `src/server/storage/client.ts`). Catches the specific failure mode where an app key lacks `writeFileRetentions` on a B2 bucket with default Compliance retention: B2 silently HANGS the request for ~5 minutes per attempt before returning 503, the SDK retries 3×, and the user-facing restore call times out after ~17 minutes. Verifying here means the same misconfiguration surfaces at deploy time as `probe-copyobj: FAILED ...` — not at first user-clicked Wiederherstellen.

A stale `STORAGE_ACCESS_KEY` (rotated keyId not propagated to `.env`), mismatched `STORAGE_SECRET_KEY` (applicationKey from a different key pair), wrong `STORAGE_REGION`, or app-key capability set missing `listFiles` surfaces in step 3 as `probe-storage: FAILED ...`. A provider that doesn't implement presigned PUT, a CORS rule that strips the integrity header, a bucket policy that rejects the signed-header set, or a stale CRC32 middleware that double-binds an empty-body checksum surfaces in step 4 as `probe-upload: FAILED ...`. An app key missing `writeFileRetentions` against a Compliance-locked bucket surfaces in step 5 as `probe-copyobj: FAILED ...` — not at first request, and not while crash-looping the freshly-recreated app container after the previous good replica is gone.

## Verify against the live bucket

Run BEFORE the first deploy that points at this bucket. The boot-time safety probe (`assertStorageBucketSafe()` in `src/server/storage/safety.ts`) will refuse to serve on any drift between the bucket's actual shape and ADR-0022's pinned shape; verifying ahead of time means the next deploy doesn't start crash-looping while you investigate.

Use the **app key** (not the master key) so the capability self-test exercises what the running app will see:

```bash
# Source ONLY for this shell — the credentials should NOT persist in your env.
export AWS_ACCESS_KEY_ID="<keyId>"             # STORAGE_ACCESS_KEY
export AWS_SECRET_ACCESS_KEY="<appKey>"        # STORAGE_SECRET_KEY
export AWS_DEFAULT_REGION="eu-central-003"     # STORAGE_REGION
EP="https://s3.eu-central-003.backblazeb2.com" # STORAGE_ENDPOINT
B="prmng-object-storage"                       # STORAGE_BUCKET (name)

# 1. Versioning — must be Enabled.
aws --endpoint-url "$EP" s3api get-bucket-versioning --bucket "$B"
#   expected: { "Status": "Enabled" }

# 2. Object Lock — must be Enabled, COMPLIANCE, positive Days.
aws --endpoint-url "$EP" s3api get-object-lock-configuration --bucket "$B"
#   expected: ObjectLockConfiguration.ObjectLockEnabled = "Enabled"
#             Rule.DefaultRetention.Mode = "COMPLIANCE"
#             Rule.DefaultRetention.Days >= 1     (this is R)

# 3. Lifecycle — exactly one rule, no filter, NoncurrentDays + ExpiredObjectDeleteMarker.
aws --endpoint-url "$EP" s3api get-bucket-lifecycle-configuration --bucket "$B"
#   expected: Rules has length 1, with:
#     Status = "Enabled"
#     Filter absent OR Filter.Prefix = ""    (rule applies to all objects)
#     NoncurrentVersionExpiration.NoncurrentDays > 0   (this is L)
#     Expiration.ExpiredObjectDeleteMarker = true
#     no Expiration.Days, no Expiration.Date,
#     no Transitions[], no NoncurrentVersionTransitions[],
#     no AbortIncompleteMultipartUpload
#     ID does NOT contain "daysFromUploadingToHiding"

# 4. R ≤ L invariant — read off the previous two outputs.
#   R is COMPLIANCE.Days from step 2; L is NoncurrentDays from step 3.
#   R must be ≤ L. If R > L the probe refuses to start (lifecycle reap is
#   blocked by Object Lock retention; zombie versions accumulate).

# 5. Capability self-test — the credential MUST NOT be able to destroy versions.
aws --endpoint-url "$EP" s3api delete-object \
  --bucket "$B" --key "__probe/safety" \
  --version-id "00000000-0000-0000-0000-000000000000" 2>&1
#   expected: "An error occurred (AccessDenied) ..."
#   any 2xx response → re-issue the app key WITHOUT deleteFiles before deploying;
#   any other error code → fail-closed (the probe will refuse to serve too).

# 6. CopyObject capability — the credential MUST be able to copy under default Compliance retention.
#    Without writeFileRetentions, B2's S3 layer silently hangs CopyObject under
#    a Compliance-default-retention bucket. This positive probe is the catch-point.
aws --endpoint-url "$EP" s3api put-object \
  --bucket "$B" --key "__probe/copyobj-source" \
  --body /dev/null --content-md5 "1B2M2Y8AsgTpgAmY7PhCfg=="
aws --endpoint-url "$EP" s3api copy-object \
  --bucket "$B" --key "__probe/copyobj-dest" \
  --copy-source "$B/__probe/copyobj-source" \
  --cli-read-timeout 30 --cli-connect-timeout 5
#   expected: a JSON CopyObjectResult with VersionId in <1 second.
#   hangs / times out → app key is missing writeFileRetentions; rotate per the
#   "App key — via b2 CLI" section above. The deploy-preflight probe-copyobj
#   step will refuse the deploy with the same diagnosis.
```

If every step matches the expected output, the bucket is provisioned correctly and the boot-time probe will pass on first request. If any step deviates: fix in the B2 console (Object Lock and Lifecycle have inline editors), then re-verify before deploying. The probe is fail-closed by design — there is no "deploy and patch in place" path.

## Dev-MinIO parity

Local dev uses MinIO behind the same `STORAGE_*` env interface. The dev bucket mirrors the B2 surface — versioning, object-lock with default retention, lifecycle — AND the credential capability split, so dev tests catch divergence on either axis before prod.

`docker/init-storage.sh` runs once on `docker compose up` and ensures:

- Bucket exists with Object Lock enabled. Object Lock can only be set at bucket-create time on MinIO; if the existing dev bucket lacks it, the init script logs a warning and recreates the bucket. Dev-volume data is destroyed — re-seed with `npm run seed` if needed.
- Versioning enabled.
- Default Compliance retention = `R` days.
- Lifecycle rule `daysFromHidingToDeleting = L`.
- A capability-restricted MinIO user `${MINIO_APP_ACCESS_KEY}` exists with a bucket-scoped IAM policy named `projekt-manager-app` attached.

The B2 prod recipe (separate restricted app key created via `b2 key create … readBuckets,readBucketLifecycleRules,readBucketRetentions,listFiles,readFiles,writeFiles`) and the MinIO dev recipe (separate restricted IAM user created via `mc admin user add` + `mc admin policy attach`) are now structurally parallel — both grant the boot probe enough access to read versioning + Object Lock + lifecycle, both deny version destruction at the credential layer, so the boot-time capability self-test in `src/server/storage/safety.ts` exercises the same defense in both environments. The app **never** runs as the MinIO root user; root credentials only exist to provision the MinIO process and the app user.

The IAM policy the init script applies (allow list mirrors the B2 app key's `readFiles, writeFiles, listFiles`):

```json
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
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Effect": "Deny",
      "Action": [
        "s3:DeleteObjectVersion",
        "s3:BypassGovernanceRetention",
        "s3:PutObjectRetention",
        "s3:PutObjectLegalHold"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    }
  ]
}
```

The explicit `Deny` block is required, not redundant: MinIO's IAM evaluator treats `s3:DeleteObject` as covering a `DeleteObjectCommand` that carries a `VersionId`, so a policy that merely omits `s3:DeleteObjectVersion` is not enough to deny version destruction. MinIO's "deny overrides allow" semantic makes the explicit `Deny` a hard guardrail — even if a downstream policy mutation introduced a broader allow, version destruction would still be blocked.

Override per-developer in `.env`:

```bash
STORAGE_OBJECT_LOCK_DAYS=7              # longer trash window during exploratory work
STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS=14
MINIO_APP_ACCESS_KEY=pmapp              # username for the app user (default in .env.example)
MINIO_APP_SECRET_KEY=pmappsecret        # password for the app user (default in .env.example)
```

`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` continue to provision the MinIO process and run the init script as the privileged caller — they are NEVER set as `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` on the app container. The compose file `:?`-gates `MINIO_APP_ACCESS_KEY` and `MINIO_APP_SECRET_KEY` so a missing value fails the deploy at parse time rather than booting the app under root credentials by accident.

## Boot-time safety probe

`assertStorageBucketSafe()` in `src/server/storage/safety.ts` runs once at startup (before reapers schedule) and reads the bucket's actual versioning, Object Lock, and lifecycle config — plus a credential capability self-test (#45 review H3). Behaviour:

- **Refuses to boot** (data-corruption class):
  - Versioning not Enabled.
  - Object Lock not Enabled, or default retention not `COMPLIANCE` with positive days.
  - No lifecycle rule, more than one rule, or a rule that:
    - is Disabled, or
    - has a prefix or tag filter (must apply to all objects), or
    - lacks `NoncurrentVersionExpiration.NoncurrentDays` (hidden versions would never reap), or
    - lacks `ExpiredObjectDeleteMarker = true` (delete markers would zombie), or
    - has any other action — itemized: `Expiration.Days`, `Expiration.Date`, `Transitions[]`, `NoncurrentVersionTransitions[]`, `AbortIncompleteMultipartUpload`, or a rule with both `Expiration` AND `NoncurrentVersionExpiration` (mixed semantics).
    - has an `ID` containing the deny-listed B2 moniker `daysFromUploadingToHiding`.
  - `R > L` — lifecycle reap is blocked by Object Lock retention for `R-L` days, leaving zombie versions every cycle. The configuration is incoherent; refuse to start.
  - **Capability self-test** — issues `DeleteObjectCommand` with a non-existent `VersionId` against the sentinel key `__probe/safety` and refuses to boot unless the response is `AccessDenied`. A 2xx response means the credential CAN destroy versions (the primary defense layer is broken); any other error code means the response leaked no perms info and the probe is fail-closed under that ambiguity.

This catches drift between the runbook and live bucket state — e.g., an operator who edits lifecycle in the B2 portal without updating the runbook trips the probe at next deploy. The capability self-test additionally catches the orthogonal "credential drift" axis: a reissued app key with `deleteFiles` enabled by mistake passes every shape check yet breaks the primary defense.

## Orphan reconciliation

Objects with no `attachments` row. Two paths PUT bytes before inserting their row and leak on a fault in between: the takeout import runner and the invoice renderer (issue #169).

The app process sweeps for them on a timer. Nothing to run and nothing to schedule — but the destructive half is **opt-in**:

| Variable                         | Default | Meaning                                                            |
| -------------------------------- | ------- | ------------------------------------------------------------------ |
| `STORAGE_PRUNE_APPLY`            | `false` | `false` logs the diff and writes nothing; `true` hides the orphans |
| `STORAGE_PRUNE_INTERVAL_MINUTES` | `1440`  | Sweep cadence                                                      |
| `STORAGE_PRUNE_MIN_AGE_MINUTES`  | `1440`  | Objects younger than this are never touched                        |

Watch `bucket-orphan-prune` in the app log first — one line per sweep, carrying `orphan_count`, `preserved_count` and `skipped_recent_count`. When the reported diff looks right, set `STORAGE_PRUNE_APPLY=true`. `orphan_count` should then fall to zero and stay there; a standing non-zero value means a writer is leaking faster than the sweep reaps.

To look at the diff on demand from a repo checkout (the deployed image ships neither `scripts/` nor `tsx`, so this does not run on the server):

```bash
npm run storage:prune
```

Report-only by default — prints the diff and every orphan key, writes nothing. `-- --apply` hides them.

### What bounds the damage

- **Hiding is not destroying.** `hide()` writes a delete marker; the app key cannot destroy versions, so the bytes survive until the lifecycle reaps them after `L` days. But note the un-hide flow does **not** cover `invoices/…` — those rows are excluded from the Papierkorb and carry `hiddenAt = null`, so recovering a wrongly hidden invoice PDF is a manual `copyFromVersion` against the row's `version_id`. That asymmetry is why the two guards below are enforced in code rather than left to the operator.
- **Min age.** An object younger than `STORAGE_PRUNE_MIN_AGE_MINUTES`, or one whose `LastModified` the provider omits, is skipped. The invoice renderer holds a PUT object whose row is still uncommitted for as long as the issuance transaction runs; without the grace window a sweep landing in that gap would hide a live invoice PDF.
- **Mismatch refusal.** A sweep that would preserve _nothing_ out of a non-empty bucket aborts before the first hide. That is the signature of a bucket and a database from different deployments — a wrong `DATABASE_URL`, a half-restored DB — not of a dirty bucket. `SEED=force` is the one caller that opts out, because truncating `attachments` is exactly how it gets there.

### Scope of the diff

The bucket holds three key namespaces: `attachments/…` and `invoices/…`, both indexed by the `attachments` table, and `__probe/…`, the deploy-preflight sentinels, which the sweep treats as reserved and never reports. Backups live in a separate R2 bucket; takeout staging is local disk.

Cheap to run: `ListObjectsV2` is a Class C call, and B2 bills only Class D.

## Related

- [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md) — design rationale, layered-defense reasoning, R vs. L sizing.
- [B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)
- [B2 Lifecycle Rules](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules)
- [B2 Application Keys](https://www.backblaze.com/docs/cloud-storage-application-keys)
- Throwaway-bucket verification (Compliance lock blocks even max-capability key) — verified manually against a scratch bucket; not committed as a script.
- Capability split verification (`writeFiles`-only key cannot destroy) — verified manually against a scratch bucket; not committed as a script.
