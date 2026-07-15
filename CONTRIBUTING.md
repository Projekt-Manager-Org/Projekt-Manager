<!-- READ-ONLY for AI -->

# Contributing

For lists of category-specific conventions (spec, docs, code, tests, ARCHITECTURE.md) see review/conventions-\*.md

## Runtime Requirements

- Node.js (pinned in `.nvmrc` — use `nvm install`)
- npm (use the version bundled with that Node release — do not upgrade independently)
- `age` / `age-keygen` — `sudo apt install age` (Debian/Ubuntu). Required from the first `npm run dev` (`scripts/binary-key/init-local-key.sh`, ADR-0024), by integration/Playwright tests, and by every operator workflow.

## Tech Stack

See [ARCHITECTURE.md § Tech Stack](ARCHITECTURE.md#tech-stack).

## Workflow

Steps happen in this order. Skipping or reordering must be flagged.

1. **Specification** — see review/conventions-spec.md
2. **Specification review** — independent reviewer verifies for adherence to review/conventions-spec.md. Violations are blocking, back to step 1.
3. **Tests (failing)** — see review/conventions-tests.md
4. **Tests review** — independent reviewer verifies for adherence to review/conventions-tests.md. Violations are blocking, back to step 3.
5. **Implementation** — see review/conventions-code.md
6. **Tests passing**
7. **Code quality review** — independent reviewer verifies for adherence to review/conventions-code.md. Violations are blocking, back to step 5.
8. **Security audit** (conditional) — needs to be confirmed by user. Propose it when trust boundaries change
9. **Documentation update** — see review/conventions-docs-general.md
10. **Commit** — group changes, including multiple files, in logical groups
11. **Open Issues** — list all open issues, including findings discovered during the workflow, even if unrelated

### Security audit

The trigger question: **"Does this change affect how the system authenticates, authorizes, stores data, communicates externally, or exposes itself to the network?"** If yes — propose an audit. If no — skip.

## Testing

| Layer              | Command                                     |
| ------------------ | ------------------------------------------- |
| Unit + integration | `npm run test`                              |
| E2E headless       | `npm run test:e2e`                          |
| E2E interactive    | `npx playwright test --ui --project=<name>` |
| Trace review       | `npx playwright show-trace <zip>`           |

**Design ACs** The functional E2E specs (`management-flows`, `kanban-flows`, `permission-visibility`, …) remain the automated behavioral gate.

**UI Mode gotcha**: pass `--project=<name>` explicitly — `chromium` for read-only specs (including `permission-visibility`), `chromium-mutating` for serial tests that mutate DB state, `smoke` for the unauthenticated boot check. Without an explicit project, the filter defaults hide everything but the `setup` login and the test tree appears empty.

**Integration prerequisites**: `docker compose up -d` — `npm run test` needs Postgres on `:5432` and MinIO on `:9000`; Playwright needs those plus the dev server on `:5173` (auto-started via `webServer`). The dev `.env` sets `COMPOSE_FILE` so bare compose commands pick up the dev overlay triple. Close the MCP Chromium browser or limit workers before Playwright runs — the persistent MCP instance plus per-worker Playwright browsers OOM Chrome.

**`age` on PATH**: integration setup and Playwright's `webServer` both shell out to `age-keygen` to generate a per-fork/per-run binary identity (ADR-0024) — see [§ Runtime Requirements](#runtime-requirements).

## Debugging

**Mobile DevTools.** Append `?debug=1` to any URL to mount [Eruda](https://github.com/liriliri/eruda) — a touch-friendly Console / Elements / Network panel for phones where attaching desktop DevTools is impractical. The flag persists in `localStorage`; clear with `?debug=0`. The Eruda chunk is dynamic-imported on demand, so unactivated sessions never download it.

## Code Style

- **German UI, English code.** All variable names, functions, types, and comments in English. User-facing labels in German, centralized in config.
- **One component per file.** File name matches the default export.
- **CSS Modules.** One `.module.css` per component. No inline styles for layout, no global CSS except a minimal reset.
- **No `any`.** TypeScript strict mode. Use proper types or `unknown`.
- **Imports.** Absolute from `src/` root where the bundler supports it, relative within the same module.
- **Quality gates are enforced by two git hooks plus CI.**
  - **pre-commit** (`.husky/pre-commit`)
  - **pre-push** (`.husky/pre-push`)
  - **CI** (`ci.yml`)

## Branching Strategy

```
main                     always deployable
  └── <type>/<slug>      topic branch (e.g. fix/dev-static-fallback)
```

Short-lived topic branches off `main`, merged back via PR. No integration/iteration branches — that was the model early in the project; current practice is direct-to-`main`.

- **main**: Always deployable. Never commit directly — every change lands via PR.
- **Topic branch**: `<type>/<short-slug>`, matching the commit type below. Branch off `main`, PR into `main`.

## Commit Conventions

[Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>: <short description>

[optional body]
```

**Types**:

`feat`, `fix`, `refactor`, `test`, `docs`, `chore`

One logical change per commit. Don't batch unrelated changes. Batch related changes.
