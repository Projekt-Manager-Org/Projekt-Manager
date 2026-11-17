import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import globals from 'globals';
import auditWriteGate from './eslint-rules/audit-write-gate.mjs';
import noDirectDbAccess from './eslint-rules/no-direct-db-access.mjs';

// Layer boundary enforcement for the seven-layer architecture defined in
// docs/spec/architecture.md §11.2. Each rule below reflects one dependency
// edge that must not be crossed. Test files are exempt so integration tests
// can reach into internals without lint churn.
//
// Zone summary (see spec for the full model):
//   config   → imports nothing application-internal
//   domain   → never imports state, ui, server, api, hooks
//   storage  → imports from domain, config; never from services/routes/ui
//   services → imports from storage, domain, config; never from routes
//   routes   → imports from services, middleware, errors, config;
//              NOT from repositories/db directly (must go via services)
//   state    → imports api, domain, config; NOT server internals
//   ui       → imports domain types only via shared modules; dispatches to
//              state; must NOT import server or api client directly

const DOMAIN_BANNED = ['**/state/**', '**/ui/**', '**/server/**', '**/api/**', '**/hooks/**'];

const CLIENT_BANNED_SERVER = ['**/server/**'];

const ROUTES_BANNED = ['**/repositories/**', '**/db/schema*', '**/db/connection*'];

const UI_BANNED_CLIENT_API = ['@/api/*', '**/src/api/**', '../../api/**', '../api/**'];

// Schema exports that are constants, not tables (`local/no-direct-db-access`
// cannot tell without typed linting). Pinned in
// scripts/check-db-access-coverage.mjs, so a table cannot slip in here.
const SCHEMA_CONSTANTS = ['AUDIT_ENTITY_TYPES', 'AUDIT_EXCLUDED_FIELDS'];

// Drizzle exports and SQL names of the audited tables (`AUDIT_ENTITY_TO_TABLE`
// in src/server/db/schema.ts), for `local/audit-write-gate`. Kept equal to the
// schema's map by eslint-rules/__tests__/audit-write-gate-config.test.mjs.
const AUDITED_TABLES = [
  'projects',
  'customers',
  'users',
  'projectWorkers',
  'attachments',
  'invoices',
  'companyProfile',
];
const AUDITED_SQL_TABLES = [
  'projects',
  'customers',
  'users',
  'project_workers',
  'attachments',
  'invoices',
  'company_profile',
];

const localPlugin = {
  rules: { 'audit-write-gate': auditWriteGate, 'no-direct-db-access': noDirectDbAccess },
};

const CONFIG_BANNED = [
  '**/domain/**',
  '**/server/**',
  '**/state/**',
  '**/ui/**',
  '**/api/**',
  '**/hooks/**',
];

export default tseslint.config(
  { ignores: ['dist/', '.claude/', 'node_modules/', 'coverage/', 'playwright-report/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  // Config layer — imports nothing application-internal.
  {
    files: ['src/config/**/*.{ts,tsx}'],
    ignores: ['src/config/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: CONFIG_BANNED.map((group) => ({
            group: [group],
            message:
              'Config layer must not import application code (domain/server/state/ui/api/hooks). See architecture.md §11.2.',
          })),
        },
      ],
    },
  },
  // Domain layer — pure functions only.
  {
    files: ['src/domain/**/*.{ts,tsx}'],
    ignores: ['src/domain/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: DOMAIN_BANNED.map((group) => ({
            group: [group],
            message:
              'Domain layer must be pure — no imports from state, ui, server, api, or hooks. See architecture.md §11.2.',
          })),
        },
      ],
    },
  },
  // Client-side (state, UI, hooks, client API wrapper) — no server imports.
  {
    files: [
      'src/state/**/*.{ts,tsx}',
      'src/ui/**/*.{ts,tsx}',
      'src/hooks/**/*.{ts,tsx}',
      'src/api/**/*.{ts,tsx}',
      'src/styles/**/*.{ts,tsx}',
      'src/App.tsx',
      'src/main.tsx',
    ],
    ignores: [
      'src/state/**/__tests__/**',
      'src/ui/**/__tests__/**',
      'src/hooks/**/__tests__/**',
      'src/api/**/__tests__/**',
      'src/styles/**/__tests__/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: CLIENT_BANNED_SERVER.map((group) => ({
            group: [group],
            message:
              'Client-side code must not import from src/server/**. See architecture.md §11.2.',
          })),
        },
      ],
    },
  },
  // Routes must go through services — never touch repositories or db/schema
  // for VALUE imports. Type-only imports of `Database` are allowed because
  // routes take the connection as a parameter; the TS-ESLint variant of
  // this rule distinguishes `import type` from regular imports.
  {
    files: ['src/server/routes/**/*.{ts,tsx}'],
    ignores: ['src/server/routes/**/__tests__/**'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: ROUTES_BANNED.map((group) => ({
            group: [group],
            message:
              'Routes must delegate to services — no direct repository or db/schema imports. Type-only imports (`import type { Database } from ...`) are allowed. See architecture.md §11.2.',
            allowTypeImports: true,
          })),
        },
      ],
    },
  },
  // Database access lives in src/server/repositories/ (spec §11.2; #937).
  // Each table reference or query call outside them is one violation, so
  // the bulk-suppression baseline (eslint-suppressions.json) counts the debt
  // per file; `scripts/check-eslint-suppressions.sh` keeps it shrink-only.
  // Rule logic: eslint-rules/no-direct-db-access.mjs. Wiring scenarios:
  // scripts/__tests__/check-db-access-rule.test.sh.
  //
  // Named exemptions, pinned in scripts/check-db-access-coverage.mjs (CI
  // fails on any other file with the rule off or its options changed):
  //   - db/: the schema, the connection and the database's own machinery,
  //     file by file, so a query module dropped into db/ is still caught.
  //   - health.ts: the liveness probe `SELECT 1` reads no table.
  //   - services/ephemeralPg.ts: a separate, throwaway database.
  //   - seed/, seed.ts, tests: not production code paths.
  {
    files: ['src/server/**/*.ts'],
    ignores: [
      'src/server/repositories/**',
      'src/server/db/auditLogRemoval.ts',
      'src/server/db/baseline-guard.ts',
      'src/server/db/connection.ts',
      'src/server/db/constraints.ts',
      'src/server/db/schema.ts',
      'src/server/seed/**',
      'src/server/seed.ts',
      'src/server/**/__tests__/**',
      'src/server/health.ts',
      'src/server/services/ephemeralPg.ts',
    ],
    plugins: { local: localPlugin },
    rules: {
      'local/no-direct-db-access': ['error', { allow: SCHEMA_CONSTANTS }],
    },
  },
  // An inline disable would bypass the rule and the baseline check alike:
  // the suppressions file never changes. So no comment may disable the rule
  // (or `local/audit-write-gate`, the ADR-0021 gate), or this guard, and no
  // comment may disable everything at once. A comment can still switch this
  // guard off; scripts/check-eslint-suppressions.sh fails on any src/server/
  // line naming either rule or the guard.
  {
    files: ['src/server/**/*.ts'],
    ignores: ['src/server/**/__tests__/**'],
    plugins: { '@eslint-community/eslint-comments': eslintComments },
    rules: {
      '@eslint-community/eslint-comments/no-restricted-disable': [
        'error',
        'local/no-direct-db-access',
        'local/audit-write-gate',
        '@eslint-community/eslint-comments/*',
      ],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
    },
  },
  // Repositories may query; they may not hand a table to anyone else.
  {
    files: ['src/server/repositories/**/*.ts'],
    ignores: ['src/server/repositories/**/__tests__/**'],
    plugins: { local: localPlugin },
    rules: {
      'local/no-direct-db-access': ['error', { allow: SCHEMA_CONSTANTS, queries: false }],
    },
  },
  // ADR-0021's type gate, the half tsc cannot see (#938): no assertion forges
  // a `MutatingDatabase`, except in services/mutate.ts, which mints it, and in
  // repositories an audited-table write takes one. Rule logic and cases:
  // eslint-rules/audit-write-gate.mjs; wiring:
  // eslint-rules/__tests__/audit-write-gate-config.test.mjs.
  {
    files: ['src/server/**/*.ts'],
    ignores: ['src/server/services/mutate.ts', 'src/server/**/__tests__/**'],
    plugins: { local: localPlugin },
    rules: { 'local/audit-write-gate': ['error', { sqlTables: AUDITED_SQL_TABLES }] },
  },
  // Raw SQL that writes audited tables on purpose: the dev seed's wipe
  // (data-model.md §7) and the restore wipe until it moves into a repository
  // (#946). Assertions are still refused.
  {
    files: ['src/server/seed.ts', 'src/server/services/ImportService.ts'],
    plugins: { local: localPlugin },
    rules: { 'local/audit-write-gate': ['error', {}] },
  },
  {
    files: ['src/server/repositories/**/*.ts'],
    ignores: ['src/server/repositories/**/__tests__/**'],
    plugins: { local: localPlugin },
    rules: {
      'local/audit-write-gate': [
        'error',
        { tables: AUDITED_TABLES, sqlTables: AUDITED_SQL_TABLES },
      ],
    },
  },
  // HTTP routes belong to the app factory, never to the instance it
  // returns. `scripts/generate-openapi.ts` (AC-351) builds the published
  // document from what `buildApp()` registers, so a route mounted in
  // `start.ts` is a public endpoint the artifact never mentions and no
  // check can notice — the hole `/api/health` sat in until #284.
  //
  // Two things the selector has to get right, both found by probing it
  // rather than by reading it:
  //
  //   - The receiver is matched against a small allowlist, not pinned to
  //     `app`. `server.get(...)` is the same mistake under a different
  //     variable name and used to pass clean. Dropping the pin entirely
  //     is stricter still, but `.get`/`.delete` on a Drizzle query
  //     builder or a Map is the same syntax — 61 false positives across
  //     `repositories/` and `services/`, so the allowlist is where the
  //     rule stops costing more than it catches.
  //   - `register` is in the method list because a plugin mounts routes
  //     no HTTP verb names: `@fastify/static` registers one HEAD+GET per
  //     built file. That is the one legitimate case, and it carries an
  //     inline disable with its reason in `staticCache.ts`.
  //
  // Scenario coverage: `scripts/__tests__/check-route-registration.test.sh`.
  {
    files: ['src/server/**/*.ts'],
    ignores: ['src/server/routes/**', 'src/server/app.ts', 'src/server/**/__tests__/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.object.name=/^(app|server|fastify|instance)$/][callee.property.name=/^(get|post|put|patch|delete|head|options|all|route|register)$/]',
          message:
            'Register HTTP routes inside buildApp() (src/server/app.ts) — the generated OpenAPI document only sees the app factory. See ARCHITECTURE.md § API Surface.',
        },
      ],
    },
  },
  // UI must not import the client API wrapper directly; must dispatch via state.
  // AC-33 in verification.md.
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    ignores: ['src/ui/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: UI_BANNED_CLIENT_API.map((group) => ({
            group: [group],
            message:
              'UI components must dispatch through src/state/**; do not import the API client directly. See verification.md AC-33.',
          })),
        },
      ],
    },
  },
  {
    files: ['src/**/__tests__/**/*.{ts,tsx}', 'src/test/**/*.{ts,tsx}', 'e2e/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-imports': 'off',
      // Mock signatures mirror real API params for readability; `_`-prefix
      // marks them as intentionally unused. Matches the src/** convention
      // (line 52-59) so the whole repo shares one rule.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  // Node-runtime `.mjs` scripts (e2e/ bootstrappers, scripts/ tooling).
  // These run under plain `node`, not tsx — no @types/node ambient
  // globals, so ESLint needs the node globals list to resolve
  // process/console/URL.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  // Browser-runtime plain JS served from `public/`: service worker
  // (sw.js) and the pre-paint theme restoration (theme-init.js). Kept
  // out of the TypeScript build to dodge bundler transforms that would
  // break CSP or the SW scope. Needs browser + serviceworker globals
  // because one file uses window/document and the other uses self/clients.
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
    },
  },
);
