/**
 * Architecture-level invariants for the storage module (ADR-0022).
 *
 * The capability split is the actual enforcement: the app's B2 key holds
 * the canonical seven-cap set (see `docs/ops/object-storage-provisioning.md`)
 * but NOT `deleteFiles`, so any call that resolves to
 * `b2_delete_file_version` (i.e. `DeleteObjectCommand` carrying a
 * `VersionId`) is refused at the provider's capability layer regardless
 * of what the code says. This test is the structural visibility belt:
 * no source file under `src/server/` may construct
 * `DeleteObjectCommand` / `DeleteObjectsCommand` with a `VersionId`,
 * and only one file may construct `DeleteObjectCommand` at all.
 *
 * Restore (CopyObject with `CopySource: <bucket>/<key>?versionId=<vid>`)
 * is required and unaffected — the test does not scan CopyObjectCommand
 * or version-aware reads (GetObject/HeadObject with VersionId).
 *
 * Why AST, not regex. The prior regex implementation was bypassed by
 * an import alias:
 *
 *     import { DeleteObjectCommand as Foo } from '@aws-sdk/client-s3';
 *     new Foo({ Bucket, Key, VersionId: 'destroy' });   // regex missed
 *
 * ADR-0022 calls the structural test the "primary defense" for the
 * project's binary durability story. A scanner that misses the trivial
 * alias is not a primary defense. The TypeScript compiler API is
 * already a devDependency, so AST resolution has zero new-dep cost.
 * `ts-morph` would be more ergonomic but adds a new top-level dep — the
 * compiler API is the right tool here.
 *
 * Glob scope. The detector's production sweep is intentionally narrow
 * to `src/server/`, excluding `__tests__/`. Today the AWS SDK is server-
 * only; no client bundle constructs S3 commands. If that ever changes,
 * the glob in `listServerSourceFiles` must widen at the same PR — the
 * scanner must not silently miss new code.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectVersionIdOnDestructiveCommands,
  findAllowlistViolations,
  listFilesConstructingDeleteObjectCommand,
  listServerSourceFiles,
  type AllowlistEntry,
} from './storage-architecture-detector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const serverRoot = path.join(repoRoot, 'src', 'server');
const fixturesRoot = path.join(__dirname, 'fixtures', 'storage-architecture');

/**
 * The single architectural exception: the boot-time capability self-test
 * (ADR-0022) MUST issue a destructive shape against a sentinel
 * non-existent version to verify the running credential lacks
 * `deleteFiles` / `s3:DeleteObjectVersion`. The detector flags every
 * other variable-bearing destructive instantiation; this entry says
 * "this one site, in this one file, is the contractual exception."
 *
 * Pinned both ways:
 *   - the production scan accepts this entry → the legitimate site passes
 *   - `findAllowlistViolations` runs over the same file list and asserts
 *     no other file declares a function with the same name (so a future
 *     contributor cannot copy the function name into a new file as a
 *     bypass)
 *
 * If the probe is renamed or moved, the entry must change at the same
 * commit — the test is the architectural contract.
 */
const SITE_ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
  {
    file: 'src/server/storage/client.ts',
    functionName: 'probeDeleteVersionCapability',
  },
];

describe('Storage architecture (ADR-0022): no destructive call carries a VersionId', () => {
  const productionFiles = listServerSourceFiles(serverRoot);

  it('production scan: no DeleteObjectCommand / DeleteObjectsCommand instantiation in src/server carries a VersionId', () => {
    const offenses = detectVersionIdOnDestructiveCommands(
      productionFiles,
      repoRoot,
      SITE_ALLOWLIST,
    );
    expect(offenses).toEqual([]);
  });

  it('allowlist takes effect: probe site passes WITH the allowlist', () => {
    // Direct check that the allowlist parameter is what's letting the
    // probe site through — in other words, the production assertion
    // above isn't passing because the probe is somehow a clean literal
    // (it isn't; it's a variable-bound literal with VersionId, or in a
    // future commit, an inline literal with VersionId).
    const offenses = detectVersionIdOnDestructiveCommands(
      productionFiles,
      repoRoot,
      SITE_ALLOWLIST,
    );
    expect(offenses.filter((o) => o.file === 'src/server/storage/client.ts')).toEqual([]);
  });

  it('without the allowlist, the probe site WOULD be flagged (negative control)', () => {
    // Same scan with empty allowlist — proves the architectural carve-out
    // is what's permitting the probe call, not a false-negative in the
    // detector. If this assertion ever stops finding a flag, either the
    // probe was removed (update the allowlist) or the detector regressed.
    const offenses = detectVersionIdOnDestructiveCommands(productionFiles, repoRoot, []);
    const probeOffenses = offenses.filter((o) => o.file === 'src/server/storage/client.ts');
    expect(probeOffenses.length).toBeGreaterThan(0);
    expect(probeOffenses.every((o) => o.command === 'DeleteObjectCommand')).toBe(true);
  });

  it('no file outside the allowlist declares an allowlisted function name', () => {
    // Symmetric guard: a future contributor cannot land a destructive
    // call inside a same-named function in a different file. The scan
    // walks every production file and asserts no name collision with
    // an allowlist entry outside its declared file.
    const violations = findAllowlistViolations(productionFiles, repoRoot, SITE_ALLOWLIST);
    expect(violations).toEqual([]);
  });

  it('storage client is the only file that constructs DeleteObjectCommand (concentration check)', () => {
    // Concentration check — destructive-looking SDK constructs belong
    // in one place so the capability surface is auditable. Anywhere
    // else is either a leak from an old refactor or someone bypassing
    // the hide / restore primitives.
    const constructors = listFilesConstructingDeleteObjectCommand(productionFiles, repoRoot);
    expect(constructors).toEqual(['src/server/storage/client.ts']);
  });

  // -------------------------------------------------------------------
  // Negative-case fixtures.
  //
  // These files live OUTSIDE the production-scan glob so the real check
  // doesn't flag them; they're loaded explicitly by the detector here.
  // Each fixture isolates one bypass shape the prior regex missed —
  // confirming the AST detector now catches it. Add a fixture before
  // adding a new resolution rule.
  // -------------------------------------------------------------------

  describe('detector behavior on bypass shapes (fixtures)', () => {
    const fixtureFile = (name: string) => path.join(fixturesRoot, name);

    it('flags an aliased named import (`import { DeleteObjectCommand as Foo }`)', () => {
      const offenses = detectVersionIdOnDestructiveCommands(
        [fixtureFile('aliased-import.fixture.ts')],
        fixturesRoot,
      );
      expect(offenses).toHaveLength(1);
      expect(offenses[0].command).toBe('DeleteObjectCommand');
      expect(offenses[0].reason).toContain('VersionId');
    });

    it('flags a namespace import (`import * as S3; new S3.DeleteObjectCommand`)', () => {
      const offenses = detectVersionIdOnDestructiveCommands(
        [fixtureFile('namespace-import.fixture.ts')],
        fixturesRoot,
      );
      expect(offenses).toHaveLength(1);
      expect(offenses[0].command).toBe('DeleteObjectCommand');
    });

    it('flags an intra-file rebinding (`const X = DeleteObjectCommand`)', () => {
      const offenses = detectVersionIdOnDestructiveCommands(
        [fixtureFile('rebinding.fixture.ts')],
        fixturesRoot,
      );
      expect(offenses).toHaveLength(1);
      expect(offenses[0].command).toBe('DeleteObjectCommand');
    });

    it('flags a variable-bound argument carrying VersionId (T5c — closes the inline-only gap)', () => {
      // The shape that previously evaded the detector at
      // `client.ts:probeDeleteVersionCapability`. The argument is a const-
      // bound object literal in the same file; the detector must follow
      // one hop and flag the VersionId carried by the resolved literal.
      const offenses = detectVersionIdOnDestructiveCommands(
        [fixtureFile('variable-bound-versionid.fixture.ts')],
        fixturesRoot,
      );
      expect(offenses).toHaveLength(1);
      expect(offenses[0].command).toBe('DeleteObjectCommand');
      expect(offenses[0].reason).toContain('VersionId');
    });

    it('flags an inline literal carrying a `...spread` as fail-closed', () => {
      // `new DeleteObjectCommand({ ...opts })` — the spread source could
      // carry VersionId. Without a TypeChecker the detector cannot see
      // through; it must flag, parallel to the variable-bound branch.
      // The reason names the spread so the operator can locate it.
      const offenses = detectVersionIdOnDestructiveCommands(
        [fixtureFile('spread-versionid.fixture.ts')],
        fixturesRoot,
      );
      expect(offenses).toHaveLength(1);
      expect(offenses[0].command).toBe('DeleteObjectCommand');
      expect(offenses[0].reason.toLowerCase()).toContain('spread');
    });

    it('flags an opaque (non-resolvable) argument as fail-closed', () => {
      // A function-parameter argument cannot be statically resolved to a
      // literal in this file. The detector cannot prove the absence of a
      // VersionId, so it MUST flag — silent pass would re-open the
      // bypass via "pass the literal in from the outside".
      const offenses = detectVersionIdOnDestructiveCommands(
        [fixtureFile('opaque-argument.fixture.ts')],
        fixturesRoot,
      );
      expect(offenses).toHaveLength(1);
      expect(offenses[0].command).toBe('DeleteObjectCommand');
      expect(offenses[0].reason.toLowerCase()).toContain('variable-bound');
    });

    it('flags VersionId nested inside batch-delete `Delete.Objects[*]`', () => {
      const offenses = detectVersionIdOnDestructiveCommands(
        [fixtureFile('batch-nested-versionid.fixture.ts')],
        fixturesRoot,
      );
      expect(offenses).toHaveLength(1);
      expect(offenses[0].command).toBe('DeleteObjectsCommand');
      expect(offenses[0].reason).toContain('VersionId');
    });

    it('does not flag a benign DeleteObjectCommand (hide marker, no VersionId)', () => {
      // Mirrors the legitimate call shape in src/server/storage/client.ts
      // — DeleteObject without VersionId is the *hide* primitive on a
      // versioned bucket. Detector must not flag this or the production
      // sweep would fail on its own client.
      const offenses = detectVersionIdOnDestructiveCommands(
        [fixtureFile('benign-delete-no-versionid.fixture.ts')],
        fixturesRoot,
      );
      expect(offenses).toEqual([]);
    });

    it('counts DeleteObjectCommand constructors across alias / namespace / rebinding shapes', () => {
      // Four fixtures construct DeleteObjectCommand under various
      // alias shapes (aliased / namespace / rebinding / direct). The
      // concentration helper must resolve each one through the import
      // table and count them all — proving the helper used by the
      // production assertion would catch a splinter caller that
      // disguised itself with an alias.
      const fixtureFiles = [
        'aliased-import.fixture.ts',
        'namespace-import.fixture.ts',
        'rebinding.fixture.ts',
        'benign-delete-no-versionid.fixture.ts',
      ].map(fixtureFile);
      const callers = listFilesConstructingDeleteObjectCommand(fixtureFiles, fixturesRoot);
      expect(callers.sort()).toEqual([
        'aliased-import.fixture.ts',
        'benign-delete-no-versionid.fixture.ts',
        'namespace-import.fixture.ts',
        'rebinding.fixture.ts',
      ]);
    });

    it('residual gap: cross-file re-export is NOT detected (documented limit)', () => {
      // Detecting a cross-file re-export would require building a
      // TypeChecker program. The capability split is the actual
      // enforcement; this scanner is a structural visibility belt for
      // the in-tree code that lives next to the cap layer. If a
      // future change introduces a re-export of an SDK destructive
      // command from a local module, the missing capability still
      // refuses the call at the wire — but this detector won't flag
      // the rebinding-via-import. The fixture is here to pin the gap
      // explicitly so it doesn't quietly become a false-pass surprise.
      const offenses = detectVersionIdOnDestructiveCommands(
        [fixtureFile('reexport-consumer.fixture.ts'), fixtureFile('reexport-source.fixture.ts')],
        fixturesRoot,
      );
      expect(offenses).toEqual([]);
    });
  });
});
