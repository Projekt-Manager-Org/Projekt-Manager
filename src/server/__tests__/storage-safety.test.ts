/**
 * Boot-time bucket-safety probe — unit tests for the pure validator and
 * one integration test confirming the real MinIO surface satisfies the
 * canonical shape that init-storage.sh produces.
 *
 * The validator is the load-bearing logic; the IO method on the storage
 * client just shapes SDK output into the snapshot shape. Table-driven
 * here — every fail-path documented at the call site doubles as a test
 * row, so a future regression that softens a failure into a warning (or
 * vice versa) trips a specific case.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateBucketSafety,
  assertStorageBucketSafe,
  type BucketSafetyConfig,
  type CapabilityProbeResult,
  type LifecycleRuleSnapshot,
} from '../storage/safety.js';
import { createStorageClient } from '../storage/client.js';

// ---------------------------------------------------------------------
// Fixtures — start from the canonical shape, mutate per-case.
// ---------------------------------------------------------------------

const CANONICAL_RULE: LifecycleRuleSnapshot = {
  id: 'reap-hidden-versions',
  status: 'Enabled',
  prefix: '',
  hasTagFilter: false,
  noncurrentDays: 2,
  expireDeleteMarker: true,
  hasExpirationDays: false,
  hasExpirationDate: false,
  hasTransitions: false,
  hasNoncurrentTransitions: false,
  hasAbortMpu: false,
};

const CANONICAL_CONFIG: BucketSafetyConfig = {
  versioningEnabled: true,
  objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: 1 },
  lifecycleRules: [CANONICAL_RULE],
};

function withRule(patch: Partial<LifecycleRuleSnapshot>): BucketSafetyConfig {
  return {
    ...CANONICAL_CONFIG,
    lifecycleRules: [{ ...CANONICAL_RULE, ...patch }],
  };
}

// ---------------------------------------------------------------------
// evaluateBucketSafety — pure validator.
// ---------------------------------------------------------------------

describe('evaluateBucketSafety — happy path', () => {
  it('passes the canonical configuration', () => {
    const verdict = evaluateBucketSafety(CANONICAL_CONFIG);
    expect(verdict).toEqual({ ok: true });
  });

  it('passes when R = L', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: 2 },
    });
    expect(verdict).toEqual({ ok: true });
  });
});

describe('evaluateBucketSafety — versioning failures', () => {
  it('fails when versioning is not Enabled', () => {
    const verdict = evaluateBucketSafety({ ...CANONICAL_CONFIG, versioningEnabled: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/versioning is not Enabled/i);
  });
});

describe('evaluateBucketSafety — object-lock failures', () => {
  it('fails when Object Lock is not enabled', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      objectLock: { enabled: false },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/Object Lock is not Enabled/i);
  });

  it('fails when default retention mode is GOVERNANCE (bypassable)', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      objectLock: { enabled: true, defaultMode: 'GOVERNANCE', defaultDays: 1 },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/expected COMPLIANCE/);
  });

  it('fails when default retention days is unset or zero', () => {
    for (const days of [undefined, 0]) {
      const verdict = evaluateBucketSafety({
        ...CANONICAL_CONFIG,
        objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: days },
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/positive integer/);
    }
  });
});

describe('evaluateBucketSafety — lifecycle failures', () => {
  it('fails when no lifecycle rule is configured', () => {
    const verdict = evaluateBucketSafety({ ...CANONICAL_CONFIG, lifecycleRules: [] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/no lifecycle rule/);
  });

  it('fails when more than one lifecycle rule is configured', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      lifecycleRules: [CANONICAL_RULE, { ...CANONICAL_RULE, id: 'extra' }],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/2 lifecycle rules/);
  });

  it('fails when the rule is Disabled', () => {
    const verdict = evaluateBucketSafety(withRule({ status: 'Disabled' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/expected Enabled/);
  });

  it('fails when the rule has a prefix filter', () => {
    const verdict = evaluateBucketSafety(withRule({ prefix: 'photos/' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/prefix filter/);
  });

  it('fails when the rule has a tag filter', () => {
    const verdict = evaluateBucketSafety(withRule({ hasTagFilter: true }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/tag filter/);
  });

  it('fails when NoncurrentDays is missing or zero', () => {
    for (const noncurrent of [undefined, 0]) {
      const verdict = evaluateBucketSafety(withRule({ noncurrentDays: noncurrent }));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/NoncurrentVersionExpiration/);
    }
  });

  // ExpiredObjectDeleteMarker is intentionally not required — see safety.ts
  // file header. B2's native lifecycle handles delete-marker cleanup
  // implicitly via daysFromHidingToDeleting, and B2's S3-compat surface
  // never sets the field. Requiring it would refuse to start against a
  // correctly-configured B2 bucket. This test pins the relaxed contract:
  // a rule that has NoncurrentVersionExpiration but no Expiration block at
  // all is the canonical B2 shape and must pass.
  it('passes when ExpiredObjectDeleteMarker is absent (B2 native shape)', () => {
    const verdict = evaluateBucketSafety(withRule({ expireDeleteMarker: false }));
    expect(verdict).toEqual({ ok: true });
  });

  // Itemized deny list — one case per disallowed action so a regression
  // that softens the message or drops the check trips the specific row.
  it('fails when Expiration.Days > 0 (auto-hides live data — equivalent to B2 daysFromUploadingToHiding)', () => {
    const verdict = evaluateBucketSafety(withRule({ hasExpirationDays: true }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/Expiration\.Days/);
  });

  it('fails when Expiration.Date is set (calendar-based auto-hide — same data-loss class)', () => {
    const verdict = evaluateBucketSafety(withRule({ hasExpirationDate: true }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/Expiration\.Date/);
  });

  it('fails when the rule has Transitions[]', () => {
    const verdict = evaluateBucketSafety(withRule({ hasTransitions: true }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/Transitions/);
  });

  it('fails when the rule has NoncurrentVersionTransitions[]', () => {
    const verdict = evaluateBucketSafety(withRule({ hasNoncurrentTransitions: true }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/NoncurrentVersionTransitions/);
  });

  it('fails when the rule has AbortIncompleteMultipartUpload set', () => {
    const verdict = evaluateBucketSafety(withRule({ hasAbortMpu: true }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/AbortIncompleteMultipartUpload/);
  });

  // Mixed semantics: a rule that expires both current AND noncurrent
  // versions is ambiguous — ADR-0022 splits the two into separate
  // concerns (current = "never auto-hide", noncurrent = "reap after L
  // days"). Single rule combining both is a defensive reject.
  it('fails when a rule has BOTH Expiration.Days AND NoncurrentVersionExpiration (mixed semantics)', () => {
    const verdict = evaluateBucketSafety(withRule({ hasExpirationDays: true, noncurrentDays: 2 }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.failures.join(' ')).toMatch(/mixes Expiration.*NoncurrentVersionExpiration/);
  });

  // Defensive name-based check — surfaces the B2 portal moniker in the
  // failure message even when the structural shape has already been
  // rejected. Useful for operators reading logs.
  it('fails when the rule ID matches the B2 deny-listed moniker daysFromUploadingToHiding', () => {
    const verdict = evaluateBucketSafety(withRule({ id: 'daysFromUploadingToHiding-something' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/daysFromUploadingToHiding/);
  });

  // The acceptable shape: NoncurrentVersionExpiration.NoncurrentDays = L
  // is the only required field on the rule. Both shapes are accepted —
  // with ExpiredObjectDeleteMarker = true (MinIO/AWS idiom) or without
  // (B2 native, which reaps delete markers implicitly). Reaffirmed here
  // as a dedicated row so a future change that narrows it further trips a
  // specific test rather than a side effect.
  it('passes when the only expiration field is NoncurrentVersionExpiration.NoncurrentDays', () => {
    const verdict = evaluateBucketSafety(withRule({ noncurrentDays: 2 }));
    expect(verdict).toEqual({ ok: true });
  });
});

describe('evaluateBucketSafety — R > L is a hard failure', () => {
  it('fails when R > L (lifecycle reap is blocked by Object Lock for R-L days)', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: 7 },
      lifecycleRules: [{ ...CANONICAL_RULE, noncurrentDays: 2 }],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/R \(7d.*\) > L \(2d/);
  });

  it('passes when R = L', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: 2 },
      lifecycleRules: [{ ...CANONICAL_RULE, noncurrentDays: 2 }],
    });
    expect(verdict).toEqual({ ok: true });
  });
});

describe('evaluateBucketSafety — multiple offences aggregate', () => {
  it('reports every failure in one verdict (no fail-fast on first offence)', () => {
    const verdict = evaluateBucketSafety({
      versioningEnabled: false,
      objectLock: { enabled: false },
      lifecycleRules: [],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.length).toBeGreaterThanOrEqual(3);
      expect(verdict.failures.join(' ')).toMatch(/versioning/);
      expect(verdict.failures.join(' ')).toMatch(/Object Lock/);
      expect(verdict.failures.join(' ')).toMatch(/no lifecycle rule/);
    }
  });
});

// ---------------------------------------------------------------------
// assertStorageBucketSafe — orchestration. Stub the reader, capture
// warnings, expect throw on failure.
//
// `makeReader` defaults the capability probe to AccessDenied (the
// healthy case) so existing shape-focused tests don't have to repeat
// it. Tests that exercise the capability probe specifically pass a
// custom result.
// ---------------------------------------------------------------------

describe('assertStorageBucketSafe — orchestration', () => {
  function makeReader(
    config: BucketSafetyConfig,
    probe: CapabilityProbeResult = { kind: 'access-denied' },
  ) {
    return {
      getBucketSafetyConfig: () => Promise.resolve(config),
      probeDeleteVersionCapability: () => Promise.resolve(probe),
    };
  }

  it('throws on R > L (lifecycle reap is blocked by Object Lock for R-L days)', async () => {
    await expect(
      assertStorageBucketSafe(
        makeReader({
          ...CANONICAL_CONFIG,
          objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: 7 },
        }),
      ),
    ).rejects.toThrow(/Refusing to start.*R \(7d.*\) > L \(2d/s);
  });

  it('throws an aggregated error on a failing config, listing every offence', async () => {
    await expect(
      assertStorageBucketSafe(
        makeReader({
          versioningEnabled: false,
          objectLock: { enabled: false },
          lifecycleRules: [],
        }),
      ),
    ).rejects.toThrow(/Refusing to start.*versioning.*Object Lock.*lifecycle/s);
  });

  // -------------------------------------------------------------------
  // Capability self-test — load-bearing because it's the *primary*
  // defense per ADR-0022. Each branch below is a fail-closed assertion:
  // only AccessDenied passes; everything else trips a boot failure.
  // -------------------------------------------------------------------

  describe('capability self-test', () => {
    it('passes when the probe returns access-denied (capability split intact)', async () => {
      // Healthy case — the credential cannot destroy versions, both
      // bucket-shape and capability are clean. No throw.
      await assertStorageBucketSafe(makeReader(CANONICAL_CONFIG, { kind: 'access-denied' }));
    });

    it('fails boot when the probe returns unexpected-success (credential CAN destroy versions)', async () => {
      // Catastrophic case — the credential has destroy capability.
      // This is the dev/prod drift the probe was added to catch
      // (e.g., re-issuing the app key with `deleteFiles` by mistake,
      // or running with MinIO root credentials). Failure message must
      // name the capability and point at the runbook.
      await expect(
        assertStorageBucketSafe(makeReader(CANONICAL_CONFIG, { kind: 'unexpected-success' })),
      ).rejects.toThrow(/capability self-test FAILED.*CAN destroy versions/s);
    });

    it('fails boot on any non-AccessDenied error (probe is fail-closed)', async () => {
      // Provider returned NoSuchVersion, NoSuchKey, InvalidArgument,
      // a network error — any of those mean the response leaks no
      // perms info. The probe refuses to serve under that ambiguity.
      await expect(
        assertStorageBucketSafe(
          makeReader(CANONICAL_CONFIG, {
            kind: 'unexpected-error',
            errorName: 'NoSuchVersion',
            message: 'The specified version does not exist',
          }),
        ),
      ).rejects.toThrow(/capability self-test ambiguous.*NoSuchVersion/s);
    });

    it('aggregates a shape failure AND a capability failure into one error', async () => {
      // Both layers can be wrong simultaneously — operator should see
      // every defect at once instead of fix-and-redeploy iteration.
      await expect(
        assertStorageBucketSafe(
          makeReader(
            { ...CANONICAL_CONFIG, versioningEnabled: false },
            { kind: 'unexpected-success' },
          ),
        ),
      ).rejects.toThrow(/Refusing to start.*versioning.*capability self-test FAILED/s);
    });
  });
});

// ---------------------------------------------------------------------
// Integration — real MinIO surface, against the canonical bucket
// init-storage.sh produces. Confirms the IO path matches the validator's
// expected shape.
// ---------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} must be set. STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY, ` +
        'STORAGE_SECRET_KEY are required. Silent skipping is not allowed.',
    );
  }
  return v;
}

describe('assertStorageBucketSafe — integration with the dev MinIO bucket', () => {
  function makeClient() {
    return createStorageClient({
      endpoint: requireEnv('STORAGE_ENDPOINT'),
      bucket: requireEnv('STORAGE_BUCKET'),
      accessKey: requireEnv('STORAGE_ACCESS_KEY'),
      secretKey: requireEnv('STORAGE_SECRET_KEY'),
    });
  }

  it('the canonical dev MinIO bucket + restricted user satisfy the full probe', async () => {
    // End-to-end exercise of the boot path against the real dev MinIO.
    // `docker/init-storage.sh` settles the bucket to the shape the
    // runbook pins (Object Lock COMPLIANCE / R=1, lifecycle
    // NoncurrentDays=L=2, ExpiredObjectDeleteMarker=true) AND
    // provisions a capability-restricted MinIO user with a bucket-scoped
    // policy that allows write/read/list/hide but denies
    // `s3:DeleteObjectVersion` — mirroring the prod B2 app key. With
    // that pair in place `assertStorageBucketSafe(client, …)` must pass:
    // the shape probe is clean, and the capability self-test resolves to
    // `access-denied` because the running credential cannot destroy
    // versions. Failure here is one of:
    //   - bucket shape drifted (init script didn't run, or a previous
    //     run left it half-configured),
    //   - the app credentials in `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY`
    //     are still root creds (regression to the pre-task state),
    //   - the IAM policy was attached but doesn't actually deny
    //     DeleteObjectVersion (provider drift).
    // Each surfaces a distinct message via the aggregated error.
    const client = makeClient();
    await assertStorageBucketSafe(client);
  });
});
