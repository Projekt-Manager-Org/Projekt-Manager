/**
 * AC-228 — repo scan refusing raw `process.env` reads outside the
 * configuration boundary.
 *
 * The configuration loader (`src/server/config/env.ts`) parses
 * `process.env` once via Zod and exposes a typed, validated `Env`. Every
 * other consumer is meant to go through `getEnv()` (or, for build-time
 * defaults, the `src/config/*.ts` config modules that read from the
 * validated env at call-time — see `src/server/config/index.ts` header
 * comment). Direct `process.env.X` reads outside the loader are a
 * documented foot-gun: they bypass the schema, miss type coercion, miss
 * dev-default credential rejection, and leave operator forgetfulness
 * (issue #139) silent until production manifests it.
 *
 * This test walks `src/server/` and `src/config/` and refuses any raw
 * `process.env` access form outside an inline allowlist. Forms covered:
 *   - `process.env.X`           (dotted)
 *   - `process.env['X']`        (bracketed, any quote style)
 *   - `process.env`             (bare, e.g. spread or argument)
 *   - `const { X } = process.env` (destructured)
 *   - `const env = process.env`   (aliased)
 *
 * STATUS: Passes today. Two of the three pre-existing bypasses moved
 * into the Zod schema — `LOGIN_RATE_LIMIT_MAX` is now a typed schema
 * field consumed via `getEnv()` in `src/server/config/index.ts`, and
 * `start.ts`'s `rejectDevCredentials` was folded into `validateEnvRuntime()`
 * as `assertNoDevCredentials`. The third (`src/config/pushDispatch.ts`,
 * `PUSH_DISPATCH_LATENCY_BUDGET_MS`) is allowlisted because the file
 * is in the isomorphic `src/config/` tree which by layering rule must
 * not import from `src/server/` — see the allowlist entry below for
 * details. Two further pre-existing categorical exceptions
 * (`services/backup.ts` for spawn-env propagation, `config/routes.ts`
 * for the build-time NODE_ENV guard) are also allowlisted.
 *
 * Allowlist policy: each entry carries a non-empty `reason` string
 * documenting why the bypass is admissible. New entries require explicit
 * justification at code-review time.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

// ---------------------------------------------------------------------
// Allowlist
//
// `LOADER_PATH` is the configuration boundary — `process.env` is parsed
// here exactly once, into the typed `Env`. The rest of the codebase
// reads from `getEnv()` or from build-time config modules (`src/config/`)
// that themselves resolve via `getEnv()` at call time.
//
// The exceptions below are reads of `process.env` that are categorically
// not configuration reads (parent-to-child env propagation for `spawn()`,
// build-time NODE_ENV guards in isomorphic config modules) where routing
// through the typed Env loader would be wrong. Pre-existing schema
// bypasses (`LOGIN_RATE_LIMIT_MAX`, `rejectDevCredentials`) were moved
// into the schema instead of being allowlisted.
// ---------------------------------------------------------------------

const LOADER_PATH = 'src/server/config/env.ts';

interface KnownException {
  /** Repo-relative path. */
  file: string;
  /** Why this raw read is admissible. Must be non-empty. */
  reason: string;
}

const KNOWN_EXCEPTIONS: ReadonlyArray<KnownException> = [
  {
    file: 'src/server/services/backup.ts',
    reason:
      "Spawn-env propagation to pg_dump / spawnCollect: the child needs the parent's PATH, HOME, etc. — these are not configuration reads, they are process-environment forwarding to subprocesses. The typed Env shape does not (and should not) carry POSIX runtime variables.",
  },
  {
    file: 'src/config/routes.ts',
    reason:
      'Dev-only `process.env.NODE_ENV` guard inside an isomorphic config module that runs both as a Vite-bundled client artifact (where Vite static-replaces NODE_ENV at build time) and as a server-side module. Routing this through the schema loader would couple a build-time-replaceable client constant to a runtime server contract.',
  },
  {
    file: 'src/config/pushDispatch.ts',
    reason:
      "Build-time-default-with-env-override module under src/config/, which by layering rule must not import from src/server/. Routing this through getEnv() would force src/config/ to depend on the server's Zod loader. Same exception class as src/config/routes.ts above; the override stays a thin parseInt wrapper with the schema-style empty-string handling.",
  },
  {
    file: 'src/server/deploy-preflight-cli.ts',
    reason:
      'Deploy pre-flight CLI: its entire purpose is to validate process.env via the schema loader at deploy time before `docker compose up`. The single `process.env` spread is the input to validateEnvAggregated() — the categorical opposite of a bypass. Pre-flight is the consumer the boundary exists to enable.',
  },
];

// ---------------------------------------------------------------------
// Matcher — the same regex set used to scan files. Exposed so the
// matcher itself can be exercised against synthetic strings (so a
// regression that breaks the regex would fail loud, not just go silent
// against the live tree).
// ---------------------------------------------------------------------

interface RawEnvMatch {
  /** The form caught: `dotted` | `bracketed` | `bare` | `destructured` | `aliased`. */
  form: string;
  /** The exact substring matched. */
  text: string;
  /** 1-indexed line number in the source. */
  line: number;
}

/**
 * Find every raw `process.env` access in `source`. Returns one entry
 * per match with a `form` discriminator and 1-indexed line.
 */
function findRawEnvAccess(source: string): RawEnvMatch[] {
  const matches: RawEnvMatch[] = [];

  // Strip block + line comments so a comment mentioning `process.env`
  // does not satisfy the matcher. Keep the original source for line
  // resolution — the strip is only used for matching.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

  // Patterns. Each emits the matched substring; line number is resolved
  // from the byte offset by counting newlines in the prefix.
  const patterns: Array<{ form: string; re: RegExp }> = [
    // Destructured first (more specific than `bare`).
    {
      form: 'destructured',
      re: /(?:const|let|var)\s*\{[^}]*\}\s*=\s*process\.env\b/g,
    },
    // Aliased: `const x = process.env` — captured before `bare` so we
    // do not double-count the same occurrence.
    {
      form: 'aliased',
      re: /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::\s*[^=]+)?=\s*process\.env\b(?!\s*[.[])/g,
    },
    // Dotted: `process.env.X`
    {
      form: 'dotted',
      re: /\bprocess\.env\.[A-Za-z_$][\w$]*/g,
    },
    // Bracketed: `process.env['X']` / `process.env["X"]` /
    // `process.env[varName]`
    {
      form: 'bracketed',
      re: /\bprocess\.env\s*\[\s*[^\]]+\s*\]/g,
    },
    // Bare: standalone `process.env` (e.g. passed as an argument or
    // spread). Excludes anything immediately followed by `.` or `[`
    // (those are caught by `dotted` / `bracketed`) and `=` (assigning
    // *to* `process.env.X` is a different pattern, not in scope).
    {
      form: 'bare',
      re: /\bprocess\.env\b(?!\s*[.[=])/g,
    },
  ];

  // Track byte offsets we have already attributed to a match, so a
  // bare-form match that overlaps with a dotted/bracketed/destructured
  // match is not counted twice.
  const claimedOffsets = new Set<number>();

  for (const { form, re } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      // Skip if any byte in this span is already claimed.
      const start = m.index;
      const end = start + m[0].length;
      let overlaps = false;
      for (let i = start; i < end; i += 1) {
        if (claimedOffsets.has(i)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      for (let i = start; i < end; i += 1) claimedOffsets.add(i);

      // Resolve line number from byte offset.
      const upTo = stripped.slice(0, start);
      const line = upTo.split('\n').length;
      matches.push({ form, text: m[0], line });
    }
  }

  return matches;
}

// ---------------------------------------------------------------------
// Repo walker — recursive .ts file enumeration with `__tests__` excluded.
// ---------------------------------------------------------------------

async function walkTsFiles(absDir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      if (entry.name === 'node_modules') continue;
      out.push(...(await walkTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Matcher self-tests — feed synthetic strings so a regression in the
// regex set fails loud. Runs first so a broken matcher reports as a
// matcher failure, not as a tree-scan failure.
// ---------------------------------------------------------------------

describe('AC-228: raw process.env matcher catches every form', () => {
  it('catches dotted access (process.env.X)', () => {
    const source = `const x = process.env.FOO;\n`;
    const matches = findRawEnvAccess(source);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.form).toBe('dotted');
    expect(matches[0]?.text).toBe('process.env.FOO');
  });

  it("catches single-quoted bracketed access (process.env['X'])", () => {
    const source = `const x = process.env['FOO'];\n`;
    const matches = findRawEnvAccess(source);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.form).toBe('bracketed');
  });

  it('catches double-quoted bracketed access (process.env["X"])', () => {
    const source = `const x = process.env["FOO"];\n`;
    const matches = findRawEnvAccess(source);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.form).toBe('bracketed');
  });

  it('catches dynamic bracketed access (process.env[varName])', () => {
    const source = `const x = process.env[varName];\n`;
    const matches = findRawEnvAccess(source);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.form).toBe('bracketed');
  });

  it('catches bare process.env passed as argument', () => {
    const source = `f(process.env);\n`;
    const matches = findRawEnvAccess(source);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.form).toBe('bare');
  });

  it('catches destructured access (const { X } = process.env)', () => {
    const source = `const { FOO, BAR } = process.env;\n`;
    const matches = findRawEnvAccess(source);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.form).toBe('destructured');
  });

  it('catches aliased access (const env = process.env)', () => {
    const source = `const env = process.env;\n`;
    const matches = findRawEnvAccess(source);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.form).toBe('aliased');
  });

  it('reports the 1-indexed line of the match', () => {
    const source = `// header\nconst x = 1;\nconst y = process.env.FOO;\n`;
    const matches = findRawEnvAccess(source);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.line).toBe(3);
  });

  it('ignores process.env mentioned only inside a block comment', () => {
    const source = `/* see process.env.FOO */\nconst x = 1;\n`;
    expect(findRawEnvAccess(source)).toHaveLength(0);
  });

  it('ignores process.env mentioned only inside a line comment', () => {
    const source = `// process.env.FOO is a no-no\nconst x = 1;\n`;
    expect(findRawEnvAccess(source)).toHaveLength(0);
  });

  it('does not double-count the same occurrence as dotted + bare', () => {
    // `process.env.FOO` would match both the dotted pattern and (if not
    // for the offset claim) the bare pattern's negative lookahead.
    // Confirm only one match emerges.
    const source = `const x = process.env.FOO;\n`;
    const matches = findRawEnvAccess(source);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.form).toBe('dotted');
  });
});

// ---------------------------------------------------------------------
// Tree scan — enumerate src/server and src/config and reject any match
// outside the allowlist. The loader (`env.ts`) is unconditionally
// allowed because parsing `process.env` is its raison d'être.
// ---------------------------------------------------------------------

describe('AC-228: refuses raw process.env access in src/server/ and src/config/', () => {
  it('finds no raw process.env reads outside the configuration loader and the allowlist', async () => {
    // Arrange — collect every .ts file under the two roots.
    const roots = ['src/server', 'src/config'];
    const files: string[] = [];
    for (const root of roots) {
      const abs = path.join(repoRoot, root);
      files.push(...(await walkTsFiles(abs)));
    }

    const allowedFiles = new Set<string>([LOADER_PATH, ...KNOWN_EXCEPTIONS.map((e) => e.file)]);

    // Act — scan each non-allowlisted file.
    const offences: string[] = [];
    for (const abs of files) {
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
      if (allowedFiles.has(rel)) continue;
      const source = await readFile(abs, 'utf8');
      for (const m of findRawEnvAccess(source)) {
        offences.push(`${rel}:${m.line} (${m.form}): ${m.text}`);
      }
    }

    // Assert — names every offending file:line.
    expect(
      offences,
      `Raw process.env access found outside src/server/config/env.ts and KNOWN_EXCEPTIONS:\n${offences.join('\n')}`,
    ).toEqual([]);
  });

  it('allowlist entries each carry a non-empty reason', () => {
    // Arrange — every KNOWN_EXCEPTIONS row.
    // Act + Assert — reason is a non-empty trimmed string.
    for (const exc of KNOWN_EXCEPTIONS) {
      expect(exc.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
