# Local Development

No Caddy, no TLS, plain HTTP on loopback. `http://localhost` is a W3C secure context -- session cookies work without `Secure` flag in dev.

## Prerequisites

- **Node 22.22.3** (pinned in `.nvmrc`) -- `nvm install`
- **Docker Engine + Compose plugin**, pinned version ([ADR-0009](../adr/0009-pin-docker-versions-across-environments.md)) -- see [Installing Docker](#installing-docker) below
- **`age`** -- see [CONTRIBUTING.md § Runtime Requirements](../../CONTRIBUTING.md#runtime-requirements). Required before the first `npm run dev` boots (`scripts/binary-key/init-local-key.sh`, ADR-0024).
- **`shellcheck`** -- see [CONTRIBUTING.md § Runtime Requirements](../../CONTRIBUTING.md#runtime-requirements). Checked by `.husky/pre-push` (local, warns if missing) and CI's `lint` job (hard fail).
- Free ports: `3000` (Fastify), `5173` (Vite), `5432` (Postgres), `9000`/`9001` (MinIO)
- **Claude Code tooling** (only if developing with Claude Code) -- machine-level, not project dependencies:
  - `npx playwright install chrome` -- Chrome binary for the Playwright MCP browser tool. Separate from the project's own `chromium` E2E binary (see [§ Tests](#tests)); needs its own install. Needs root and only runs on Debian/Ubuntu (checks `/etc/os-release`'s `ID` literally) -- on a derivative like Linux Mint it refuses outright. There, install Google Chrome manually from [google.com/chrome](https://www.google.com/chrome/) instead; the MCP tool finds it at the same `/opt/google/chrome/chrome` path either way.
  - `npm install -g typescript-language-server` -- lets the LSP tool do go-to-definition/references/hover. Resolves this project's local `typescript` automatically, no project-side config needed.

### Installing Docker

Same pinned versions as the VPS -- follow [server-setup.md](server-setup.md) Phase 4 for the apt repo, version table, and install/hold commands. Two differences for a workstation:

- Install for your own interactive user, not `deploy` -- add yourself to the `docker` group instead: `sudo usermod -aG docker $USER` (log out/in to apply).
- Skip step 4 (UDP socket buffer tuning) -- that's Caddy/HTTP3-specific and only applies to the VPS.

## First-time setup

```bash
nvm install
npm install
cp .env.example .env
scripts/binary-key/init-local-key.sh  # generates the dev age identity, writes it into .env
```

The `.env.example` defaults are dev-ready: `NODE_ENV=development`, `SEED=true`, `DOMAIN=localhost`. No Cloudflare token or bootstrap vars needed.

## Daily workflow

```bash
# Start backing services (Postgres + MinIO)
docker compose up -d

# Run Vite (HMR) + Fastify (tsx watch)
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` to `http://localhost:3000`.

`COMPOSE_FILE` in `.env.example` declares the dev overlay triple (`docker-compose.yml:docker-compose.minio.yml:docker-compose.dev.yml`), so bare `docker compose` commands pick up the right file set without `-f` flags. The dev overlay's `app` service is profile-gated (`containerised-app`) — bare `up` starts only `db`, `storage`, `storage-init` because the app runs on the host via `npm run dev`. To exercise the prod-shaped Dockerfile build locally, opt in with `docker compose --profile containerised-app up -d`.

### Seed users

| Username      | Role              | Password   |
| ------------- | ----------------- | ---------- |
| `inhaber`     | owner             | `changeme` |
| `buero`       | office            | `changeme` |
| `arbeiter1`   | worker            | `changeme` |
| `arbeiter2`   | worker            | `changeme` |
| `buchhalter`  | bookkeeper        | `changeme` |
| `deaktiviert` | worker (inactive) | `changeme` |

### Connecting the DB in WebStorm

Data Source → PostgreSQL: host `localhost`, port `5432`, user `pm`, password `changeme`, database `projekt_manager` (matches `DATABASE_URL` in `.env.example`).

The DB is empty until seeded. `npm run dev` seeds it automatically on first run (`SEED=true` is the `.env.example` default — see [§ Seed users](#seed-users) above), so run it once before browsing tables. To pull real data instead, see [sync-vps-to-dev.md](sync-vps-to-dev.md).

## Stop / reset

```bash
# Stop containers, keep data
docker compose down

# Wipe everything (fresh start, seed re-runs on next start)
docker compose down -v
```

## Re-seed without volume wipe

Set `SEED=force` in `.env`, restart `npm run dev`. Does `TRUNCATE ... CASCADE` before re-inserting. `SEED=true` skips seeding when users exist.

## Tests

```bash
npm test                  # unit + component + integration (db + storage must be running)
npm run test:coverage     # with coverage
npm run test:watch        # watch mode
npm run test:e2e          # Playwright E2E
```

Integration tests wipe and re-seed per file -- do not run against a database you care about.

## Common pitfalls

| Symptom                                                             | Fix                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port `5432` already in use                                          | Stop system Postgres (`sudo systemctl stop postgresql`) or change port in `docker-compose.dev.yml`                                                                                          |
| `getaddrinfo EAI_AGAIN storage`                                     | Verify `.env` has `STORAGE_ENDPOINT=http://localhost:9000` (the default in `.env.example`). If you copied from `.env.production.example`, this var is missing — use `.env.example` for dev. |
| Login fails on fresh DB                                             | Check `npm run dev` output for seed errors; try `SEED=force`                                                                                                                                |
| Do NOT run `docker-compose.yml` with `DOMAIN=<prod-domain>` locally | Caddy will mint a real LE cert, burning rate-limit slots uselessly                                                                                                                          |

## Deploying to a VPS

Local development does not require a VPS. When ready to deploy, see the [production quick start](../../README.md#run-in-production) for the full path, or [HTTP-only evaluation](http-only-evaluation.md) for a quick test without a domain.
