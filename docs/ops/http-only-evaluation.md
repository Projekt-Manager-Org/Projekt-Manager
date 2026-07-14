# HTTP-Only Evaluation

> **WARNING:** No TLS. Login credentials and session cookies travel in cleartext.
> **Never use this for real users or real data.**

Runs the full production stack (app image, Caddy, Postgres, MinIO) in Docker over plain HTTP. Unlike [local development](local-dev.md) (`npm run dev` with Node directly), this mode exercises the Docker image and the Caddy reverse proxy -- the same components that run in production, minus TLS and VPN.

See [README § Quick Start](../../README.md#quick-start) for how this fits alongside local dev and production.

## Quick start

Both options start with:

```bash
cp .env.example .env                  # first time only — dev-ready, no edits needed
```

`.env.example` has dev-ready defaults. The compose override (`docker-compose.http.yml`) replaces the custom Caddy build with stock Caddy on port 80 and sets `NODE_ENV=development` so seeding and dev credentials work.

### Option A — Pull from GHCR

Uses the pre-built image from GitHub Container Registry. Private packages need a GHCR login first -- classic PAT, `read:packages` scope, see [manual-deploy.md § GHCR pull token](manual-deploy.md#ghcr-pull-token) for where and how to create one.

```bash
docker login ghcr.io -u <github-username>   # paste the PAT at the password prompt; skip if the package is public

docker compose -f docker-compose.yml -f docker-compose.http.yml pull
docker compose -f docker-compose.yml -f docker-compose.http.yml up -d
# Open http://localhost — login with inhaber / changeme
```

### Option B — Build locally

Builds the app image from source. No registry access needed.

```bash
docker compose -f docker-compose.yml -f docker-compose.http.yml up -d --build
# Open http://localhost — login with inhaber / changeme
```

First build takes a few minutes.

## Remote access

When running on a remote server, open port 80/TCP in ufw (`sudo ufw allow 80/tcp`) and any cloud firewall. Access via `http://<server-ip>` instead of `http://localhost`.

For VPS provisioning (OS hardening, Docker install), see [server-setup.md](server-setup.md).

## Stop / clean up

```bash
# Stop, keep data
docker compose -f docker-compose.yml -f docker-compose.http.yml down

# Wipe everything
docker compose -f docker-compose.yml -f docker-compose.http.yml down -v
```

## Graduating to production

1. Get a domain and add it to Cloudflare
2. Set up WireGuard -- [wireguard-setup.md](wireguard-setup.md)
3. Configure DNS -- [dns-setup.md](dns-setup.md)
4. Set up `.env` from `.env.production.example`
5. Set up `secrets.env.age` -- [manual-deploy.md](manual-deploy.md)
6. Bootstrap TLS -- [caddy-tls-bootstrap.md](caddy-tls-bootstrap.md)
7. Switch to standard compose: `docker compose up -d`
8. Close port 80/TCP if opened (`sudo ufw delete allow 80/tcp` + cloud firewall)

## Security implications

- **No TLS.** Credentials and sessions travel in cleartext. On a network you don't fully control, assume everything is interceptable.
- **No VPN.** On a remote server, anyone who can reach the IP can reach the login page. Application-level auth is present, but the app is a walking skeleton -- it has not been hardened against all attack vectors. The production VPN exists for defense in depth, not just access control.
- **HSTS conflict.** If the same browser previously visited the HTTPS version, it may refuse HTTP for up to 180 days. Use a different browser or clear HSTS state.
