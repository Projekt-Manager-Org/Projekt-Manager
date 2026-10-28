# Caddy TLS Bootstrap

First-time Let's Encrypt certificate provisioning. Use this for new domains or new Cloudflare tokens to avoid burning LE production rate limits.

**When to use:** first-time domain setup, or after changing DNS provider / token / domain.
**When to skip:** established setup with a known-working config -- just deploy and Caddy uses LE production by default.

## Procedure

### 1. Edit Caddyfile -- point at LE staging

Add a `ca` line inside the `tls` block:

```caddyfile
{$DOMAIN:localhost} {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
        ca https://acme-staging-v02.api.letsencrypt.org/directory   # bootstrap only
    }
    # ...
}
```

### 2. Reload Caddy

SSH to the VPS as the admin user, then:

```bash
sudo -u deploy docker exec projekt-manager-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

Caddy's admin API (listens on `localhost:2019` inside the container) re-reads the bind-mounted `/etc/caddy/Caddyfile` and diff-applies the new config — new CA directive, re-provision via the new issuer, no container restart. Prefer this over `docker compose up -d --force-recreate caddy`: `docker compose` re-parses `docker-compose.yml` on every invocation, which requires `CLOUDFLARE_API_TOKEN`, `POSTGRES_PASSWORD`, `STORAGE_SECRET_KEY`, and friends in shell env. Those live only in `secrets.env.age`; a bare sudo shell doesn't have them sourced, so parse aborts with `CLOUDFLARE_API_TOKEN must be declared`. Same class of problem fixed in `server-setup.md` Phase 8.1 (commit 5484903).

### 3. Verify staging cert

```bash
# Watch logs for success
sudo -u deploy docker logs projekt-manager-caddy-1 --since 1m -f
# Look for: "certificate obtained successfully","issuer":"acme-staging-v02..."

# Test TLS from a WireGuard client (-k required for staging certs)
curl -vk --resolve "<domain>:443:10.213.17.1" "https://<domain>/api/health"

# Inspect cert issuer (should mention STAGING or Fake LE)
echo | openssl s_client -connect 10.213.17.1:443 -servername <domain> 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

### 4. Switch to production

Remove the `ca https://acme-staging-v02...` line from the Caddyfile. The `tls` block should be:

```caddyfile
tls {
    dns cloudflare {env.CLOUDFLARE_API_TOKEN}
}
```

### 5. Reload Caddy again

```bash
sudo -u deploy docker exec projekt-manager-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

### 6. Verify production cert

```bash
# Watch logs -- success line should show acme-v02 (no "staging")
sudo -u deploy docker logs projekt-manager-caddy-1 --since 1m -f

# Test WITHOUT -k (production cert validates against standard CA bundle)
curl -v --resolve "<domain>:443:10.213.17.1" "https://<domain>/api/health"
# Expect: 200 OK, clean TLS handshake, no warnings
```

## Config change reference

| Command                                                        | Behavior                                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker exec caddy caddy reload --config /etc/caddy/Caddyfile` | **Canonical path.** Caddy's admin API diff-applies the new config, re-provisioning certs as needed. No compose parse, no secrets required in shell env.                 |
| `docker compose restart caddy`                                 | SIGTERM only. `.env` changes **ignored** (compose file not re-parsed). Bind-mount changes ARE re-read on process restart, but `caddy reload` is cleaner.                |
| `docker compose up -d --force-recreate caddy`                  | Always recreates the container. Requires the full set of compose interpolation vars in shell env; from a bare sudo shell, hits `CLOUDFLARE_API_TOKEN must be declared`. |

## Force re-issuance

If a cert is broken or compromised:

The Caddy image has no shell or `rm` (scratch runtime), so the delete runs in a throwaway container with Caddy's volumes attached, borrowing the `db` image already on the host:

```bash
img=$(sudo -u deploy docker inspect -f '{{.Image}}' projekt-manager-db-1)
sudo -u deploy docker run --rm --volumes-from projekt-manager-caddy-1 --entrypoint rm "$img" \
  -rf /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<domain>

sudo -u deploy docker exec projekt-manager-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

**Beware rate limits** -- 5 failed validations per identifier per account per hour.

Do NOT delete the ACME account key (`/data/caddy/acme/<issuer>/users/default/`) -- Caddy registers a new account otherwise, consuming a rate-limit slot.

## Verify current cert

```bash
echo | openssl s_client -connect 10.213.17.1:443 -servername <domain> 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

Production issuer: `C = US, O = Let's Encrypt, CN = E8` (or similar). Staging issuer mentions `STAGING` or `Fake`.
