/**
 * Boot-time bucket-safety probe. ADR-0022 / docs/ops/object-storage-provisioning.md
 * pin a precise bucket shape — Compliance Object Lock, Versioning, and a
 * single canonical lifecycle rule — AND a credential capability split
 * (the app key cannot destroy versions). This module verifies both and
 * refuses to start on data-corruption-class drift in either.
 *
 * Shape (validator):
 *   - Versioning: Enabled
 *   - Object Lock: Enabled, default retention COMPLIANCE for R days
 *   - Lifecycle: exactly one Enabled rule, no prefix/tag filter,
 *     NoncurrentVersionExpiration.NoncurrentDays = L,
 *     no other actions (no Expiration.Days — would auto-hide live data;
 *     no Transitions — wrong storage class semantic).
 *
 * `Expiration.ExpiredObjectDeleteMarker = true` is intentionally NOT
 * required — it is a MinIO / AWS S3 idiom, not a data-integrity invariant.
 * On Backblaze B2 (the prod target, ADR-0022), the native lifecycle action
 * `daysFromHidingToDeleting` reaps the hidden version AND its delete
 * marker together; the S3-compat surface does not surface
 * `ExpiredObjectDeleteMarker=true` for that case. Requiring the field
 * would refuse to start against a correctly-configured B2 bucket. MinIO's
 * `docker/init-storage.sh` still sets `--expire-delete-marker`
 * unconditionally so dev rules carry the field; that is parity at the
 * provisioning layer, not a probe-time check.
 *
 * Capability self-test:
 *   The shape check above does not verify the *primary* defense — that
 *   the running credential lacks `deleteFiles` (B2) /
 *   `s3:DeleteObjectVersion` (MinIO/AWS). If someone re-issues the app
 *   key with destroy capability by mistake, every shape probe still
 *   passes and the credential can destroy any version older than the
 *   retention window. The self-test issues a `DeleteObjectCommand` with
 *   a format-valid-but-nonexistent `VersionId` against a sentinel key
 *   (`__probe/safety`) and asserts `AccessDenied` is the response —
 *   meaning the capability layer refused before the existence check
 *   ran.
 *
 *   Why a bogus VersionId, not a sentinel write:
 *     - On B2 with a `writeFiles, readFiles, listFiles` key, the
 *       `b2_delete_file_version` capability check fires before the
 *       version-existence check, so the bogus VersionId never matters.
 *       Verified end-to-end against B2 in 2026-04 (see
 *       docs/wip/verify-hide-capability-split.sh).
 *     - On MinIO with a restricted user (no `s3:DeleteObjectVersion`),
 *       the IAM policy denies the action before resolution. Same shape.
 *     - A sentinel write would auto-apply Compliance retention
 *       (`R` days) and never be deletable by design — heavier fixture
 *       with the same outcome. The bogus-version path keeps the probe
 *       side-effect-free and identical across providers.
 *
 *   Failure semantics — fail-closed for any non-AccessDenied outcome:
 *     - 204 success → credential CAN destroy (catastrophic dev/prod drift)
 *     - NoSuchVersion / NoSuchKey → provider checked existence first;
 *       the response leaks no perms info, so we cannot trust the
 *       capability split is actually in place
 *     - InvalidArgument (malformed VersionId) → provider validated the
 *       format before perms; same ambiguity
 *     - Network / timeout → ambiguous; refuse to serve
 *
 * `R > L` is a hard failure — lifecycle would attempt to reap noncurrent
 * versions still protected by Object Lock retention, leaving zombie
 * versions on every reap cycle until R has elapsed. The configuration
 * is incoherent on its face; refuse to serve until R ≤ L.
 *
 * The validator is a pure function over a structured snapshot so each
 * fail-path is unit-tested without mocking the S3 SDK. The capability
 * self-test is mocked via the `BucketSafetyReader` interface so unit
 * tests can pin AccessDenied / 204 / other-error paths without an SDK
 * round-trip.
 */

/**
 * B2 portal monikers that the runbook (docs/ops/object-storage-provisioning.md)
 * and ADR-0022 explicitly deny. When B2 round-trips such a rule through
 * the S3 API, the moniker can survive in the rule's ID. Match against the
 * SDK-surfaced ID/Name fields as a defensive belt — the canonical action
 * checks below already reject the resulting `Expiration.Days` shape, but
 * matching the moniker name produces an unambiguous failure message that
 * points the operator at the deny list.
 */
export const LIFECYCLE_DENY_ID_TOKENS: ReadonlyArray<string> = ['daysFromUploadingToHiding'];

export interface BucketSafetyConfig {
  versioningEnabled: boolean;
  objectLock: {
    enabled: boolean;
    defaultMode?: string;
    defaultDays?: number;
  };
  lifecycleRules: ReadonlyArray<LifecycleRuleSnapshot>;
}

/**
 * Structured snapshot of one S3 LifecycleRule, flattened so the validator
 * can assert each field independently. The split between
 * `hasExpirationDays` / `hasExpirationDate` / `hasTransitions` etc. lets
 * the failure message identify the specific defect rather than a generic
 * "disallowed action" — important because the runbook deny list is
 * itemized and operators need to know which item drifted.
 */
export interface LifecycleRuleSnapshot {
  id?: string;
  status: string;
  /** Empty string when no prefix filter — i.e., applies to all objects. */
  prefix: string;
  /** True when the rule has any tag-based filter. */
  hasTagFilter: boolean;
  /** NoncurrentVersionExpiration.NoncurrentDays — the canonical hide-to-delete dial. */
  noncurrentDays?: number;
  /**
   * Expiration.ExpiredObjectDeleteMarker = true if present in the rule.
   * The validator does NOT require this — see file header. Tracked here
   * because the field IS load-bearing in tests (and on MinIO it is set by
   * `docker/init-storage.sh`); the snapshot just doesn't enforce it.
   */
  expireDeleteMarker: boolean;
  /** Expiration.Days > 0 — auto-hides live data. ADR-0022 deny list. */
  hasExpirationDays: boolean;
  /** Expiration.Date set — same data-loss class as Expiration.Days. */
  hasExpirationDate: boolean;
  /** Any Transitions[] entries — wrong storage-class semantic. */
  hasTransitions: boolean;
  /** Any NoncurrentVersionTransitions[] entries — same. */
  hasNoncurrentTransitions: boolean;
  /** AbortIncompleteMultipartUpload set — outside our hide/reap model. */
  hasAbortMpu: boolean;
}

export type SafetyVerdict = { ok: true } | { ok: false; failures: string[] };

/**
 * Pure validator over the structured snapshot. Returns the canonical
 * pass / fail verdict — every drift is a hard failure (no soft warnings;
 * ADR-0022 prescribes a single canonical bucket shape).
 */
export function evaluateBucketSafety(config: BucketSafetyConfig): SafetyVerdict {
  const failures: string[] = [];

  if (!config.versioningEnabled) {
    failures.push('bucket versioning is not Enabled (required for hide/restore semantics)');
  }

  if (!config.objectLock.enabled) {
    failures.push(
      'Object Lock is not Enabled (Compliance retention is the finite-window backstop)',
    );
  } else {
    if (config.objectLock.defaultMode !== 'COMPLIANCE') {
      failures.push(
        `Object Lock default retention mode is "${config.objectLock.defaultMode ?? 'unset'}", expected COMPLIANCE`,
      );
    }
    if (!config.objectLock.defaultDays || config.objectLock.defaultDays < 1) {
      failures.push(
        `Object Lock default retention days is "${config.objectLock.defaultDays ?? 'unset'}", expected positive integer`,
      );
    }
  }

  if (config.lifecycleRules.length === 0) {
    failures.push(
      'no lifecycle rule configured (hidden versions would never reap — unbounded storage growth)',
    );
  } else if (config.lifecycleRules.length > 1) {
    failures.push(`${config.lifecycleRules.length} lifecycle rules configured, expected exactly 1`);
  } else {
    const rule = config.lifecycleRules[0];
    if (rule.status !== 'Enabled') {
      failures.push(`lifecycle rule status is "${rule.status}", expected Enabled`);
    }
    if (rule.prefix !== '') {
      failures.push(
        `lifecycle rule has prefix filter "${rule.prefix}", expected empty (apply to all objects)`,
      );
    }
    if (rule.hasTagFilter) {
      failures.push('lifecycle rule has a tag filter, expected none (apply to all objects)');
    }
    if (!rule.noncurrentDays || rule.noncurrentDays < 1) {
      failures.push(
        'lifecycle rule has no NoncurrentVersionExpiration.NoncurrentDays (hidden versions would never reap)',
      );
    }
    // Note: we deliberately do NOT require Expiration.ExpiredObjectDeleteMarker=true.
    // See file header — B2's native lifecycle reaps delete markers together
    // with the hidden version, but does not surface that fact through the
    // S3 API. Requiring the field would refuse to start against a
    // correctly-configured B2 bucket. The data-integrity guarantee
    // (versions reap after L days) is enforced by the noncurrentDays
    // check above; delete-marker zombies are operational clutter, not
    // data loss, and B2 handles them implicitly anyway.

    // Itemized deny list. Each defect emits its own failure so the
    // operator sees exactly which action drifted from the canonical
    // shape — `daysFromHidingToDeleting` is the only allowed lifecycle
    // action per ADR-0022 / docs/ops/object-storage-provisioning.md.
    if (rule.hasExpirationDays) {
      failures.push(
        'lifecycle rule has Expiration.Days > 0 (auto-hides live data — ADR-0022 deny list, equivalent to B2 daysFromUploadingToHiding)',
      );
    }
    if (rule.hasExpirationDate) {
      failures.push(
        'lifecycle rule has Expiration.Date set (auto-hides live data on a calendar date — same data-loss class as Expiration.Days)',
      );
    }
    if (rule.hasTransitions) {
      failures.push(
        'lifecycle rule has Transitions[] (storage-class change is outside the hide/reap model)',
      );
    }
    if (rule.hasNoncurrentTransitions) {
      failures.push(
        'lifecycle rule has NoncurrentVersionTransitions[] (storage-class change is outside the hide/reap model)',
      );
    }
    if (rule.hasAbortMpu) {
      failures.push(
        'lifecycle rule has AbortIncompleteMultipartUpload (outside the canonical reap-only shape)',
      );
    }

    // Mixed semantics: a single rule that both expires current versions
    // AND noncurrent versions is ambiguous. ADR-0022 prescribes exactly
    // one canonical rule, scoped to noncurrent-only.
    if (
      (rule.hasExpirationDays || rule.hasExpirationDate) &&
      rule.noncurrentDays !== undefined &&
      rule.noncurrentDays > 0
    ) {
      failures.push(
        'lifecycle rule mixes Expiration (current) with NoncurrentVersionExpiration — ambiguous semantics, ADR-0022 deny list',
      );
    }

    // Defense-in-depth — match the rule's surfaced ID against the B2
    // portal moniker deny list. The action checks above already reject
    // the structural shape, but a clear "your daysFromUploadingToHiding
    // rule is forbidden" message is more actionable than generic
    // "Expiration.Days > 0".
    if (rule.id) {
      for (const token of LIFECYCLE_DENY_ID_TOKENS) {
        if (rule.id.includes(token)) {
          failures.push(
            `lifecycle rule ID "${rule.id}" matches deny-listed B2 moniker "${token}" — runbook forbids this rule shape`,
          );
        }
      }
    }

    if (
      config.objectLock.defaultDays &&
      rule.noncurrentDays &&
      config.objectLock.defaultDays > rule.noncurrentDays
    ) {
      failures.push(
        `R (${config.objectLock.defaultDays}d default retention) > L (${rule.noncurrentDays}d hide-to-delete) — lifecycle reap is blocked by Object Lock for R-L days; configuration is incoherent (ADR-0022 prescribes R ≤ L)`,
      );
    }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/**
 * Sentinel key the capability self-test tries (and is expected to fail)
 * to delete. The key is never written — the call is intentionally
 * directed at a non-existent object so the only branches are:
 *   - the credential is denied at the capability layer  → AccessDenied
 *   - the credential is permitted, server resolves the version → other
 * Both providers (B2, MinIO) check capability before resolution when
 * the IAM/key entitlements forbid the action; both return AccessDenied
 * for the denied case regardless of whether the object exists.
 *
 * The leading `__probe/` prefix is unique to this probe so even if a
 * future change starts writing here, an operator grepping the bucket
 * sees the safety-probe namespace immediately.
 */
export const CAPABILITY_PROBE_KEY = '__probe/safety';

/**
 * Format-valid UUID that no real PUT will ever produce (the "nil UUID",
 * RFC 4122). Plausible to both B2 (which uses long opaque base64-ish
 * VersionIds; format-validation is permissive) and MinIO (which uses
 * UUIDs natively). On a properly-restricted credential, the capability
 * layer rejects the call before the server inspects this value, so it
 * never has to be a "real" version.
 */
export const CAPABILITY_PROBE_VERSION_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Outcome of the capability self-test, surfaced as a discriminated
 * union so the caller can render distinct error messages without
 * stringly matching on SDK output.
 */
export type CapabilityProbeResult =
  | { kind: 'access-denied' }
  | { kind: 'unexpected-success' }
  | { kind: 'unexpected-error'; errorName: string; message: string };

export interface BucketSafetyReader {
  getBucketSafetyConfig: () => Promise<BucketSafetyConfig>;
  /**
   * Issue a DeleteObjectCommand with a non-existent VersionId against
   * `CAPABILITY_PROBE_KEY` and classify the outcome. Implementations
   * MUST NOT translate AccessDenied into a thrown exception — the
   * probe needs the structured result, not a control-flow signal.
   */
  probeDeleteVersionCapability: () => Promise<CapabilityProbeResult>;
}

/**
 * Reads the bucket configuration via the storage client, applies the
 * shape validator, and runs the capability self-test. Throws an
 * aggregated error on failure — same fail-fast shape as the existing
 * assertX helpers in src/server/config/env.ts.
 *
 * Both checks run unconditionally and their failures aggregate into a
 * single thrown error: the operator sees every defect at once instead
 * of fixing one and re-deploying to discover the next. Order is fixed
 * (shape first, capability second) only for deterministic error
 * output, not because the checks depend on each other.
 *
 * Invoice retention is not a bucket property: rendered invoice PDFs
 * carry their own per-object lock (ADR-0026, AC-296), because the
 * bucket default `R` must stay within `L` and so cannot hold years.
 */
export async function assertStorageBucketSafe(client: BucketSafetyReader): Promise<void> {
  const config = await client.getBucketSafetyConfig();
  const verdict = evaluateBucketSafety(config);

  const failures: string[] = verdict.ok ? [] : [...verdict.failures];

  // Capability self-test — verify the running credential cannot
  // destroy versions. Per ADR-0022 the capability split is the primary,
  // continuous defense; a misconfigured credential here is more
  // dangerous than any shape drift because the credential is what
  // mediates every runtime call.
  const probe = await client.probeDeleteVersionCapability();
  switch (probe.kind) {
    case 'access-denied':
      // Pass — credential lacks destroy capability, layered defense intact.
      break;
    case 'unexpected-success':
      failures.push(
        'capability self-test FAILED: DeleteObjectCommand with a non-existent ' +
          'VersionId returned 2xx — the running credential CAN destroy versions. ' +
          'This violates ADR-0022 §"capability split" and breaks the primary ' +
          'defense layer. Re-issue the app key without `deleteFiles` (B2) / ' +
          '`s3:DeleteObjectVersion` (MinIO/AWS) before serving traffic.',
      );
      break;
    case 'unexpected-error':
      failures.push(
        `capability self-test ambiguous: DeleteObjectCommand returned ` +
          `${probe.errorName} ("${probe.message}"). Expected AccessDenied — ` +
          `any other response leaves the capability layer unverified. Probe is ` +
          `fail-closed: refusing to serve until the credential's destroy capability ` +
          `is provably absent. See docs/ops/object-storage-provisioning.md.`,
      );
      break;
  }

  if (failures.length > 0) {
    throw new Error(
      `Refusing to start: storage bucket configuration violates ADR-0022.\n${failures
        .map((f) => `  - ${f}`)
        .join('\n')}\nSee docs/ops/object-storage-provisioning.md.`,
    );
  }
}
