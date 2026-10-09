# Operations — Troubleshooting

Knowledge learned the hard way. Each entry names the trap, the root cause, and the workaround — in that order. Add new entries as they are discovered; keep them terse.

## Caddy `{$VAR:default}` does not default empty strings

**Trap:** `{$ACME_CA_URL:https://acme-v02.api.letsencrypt.org/directory}` in a Caddyfile does **not** fall back to the default when `ACME_CA_URL=""`. Only _unset_ triggers the default — an empty value is substituted verbatim, which Caddy then treats as an invalid ACME endpoint.

**Root cause:** Caddy's env-var substitution distinguishes unset from empty; the `:default` syntax only fires on unset.

**Workaround:** Hardcode the production value in the Caddyfile. For staging bootstrap, edit the file manually (see [caddy-tls-bootstrap.md](caddy-tls-bootstrap.md)) and revert after the cert is issued. Do not rely on "toggle via env var" for cert authority selection.

## Docker Compose runtime commands are not interchangeable

**Trap:** Picking the wrong one silently ignores a config change. No error is raised.

**The three commands and what each one actually does:**

- `docker compose restart <svc>` — **does not** re-read `.env` or the compose file. Env-var changes are ignored. Never use after editing `.env`.
- `docker compose up -d <svc>` — re-reads `.env` and the compose file, detects diffs, and recreates any service whose config changed. **Does not** notice bind-mount content changes.
- `docker compose up -d --force-recreate <svc>` — always recreates. Use this when you edited a bind-mounted file (Caddyfile, Corefile, etc.) and need the container to see the new content.

**Rule of thumb:** After editing `.env` → `up -d`. After editing a bind-mounted file → `up -d --force-recreate`. `restart` alone is almost never what you want.

## \[skip ci\] matches anywhere in the commit body, including quoted text

**Trap:** GitHub Actions scans the raw commit message for five bracketed skip directives: \[skip ci\], \[ci skip\], \[no ci\], \[skip actions\], \[actions skip\]. The match is a plain substring check — backticks, quotes, code fences, and markdown escapes in the rendered view do **not** shield the raw text. Naming one verbatim anywhere in a commit body (even in quoted docs prose) skips CI for that commit. Follow-up commits riding on the same push are skipped too, because GitHub only evaluates the push's head commit.

**Root cause:** The skip check runs against raw commit message bytes before any rendering or parsing. Whatever the author typed is what the scanner sees.

**Workaround:** When you need to name a skip directive in a commit message or docs prose, break the substring so the raw bytes are not contiguous:

- Backslash-escape each bracket in markdown: `\[skip ci\]` renders as the bracketed form but the raw bytes include backslashes.
- Split the characters: `"skip" "ci"`, or write the tokens on separate lines.
- Use a noun form instead: "skip-ci directive".
- Link to GitHub's docs instead of inlining the literal form.

For docs prose, backslash escape reads cleanest. For commit messages (which GitHub's scanner does not render), the noun form is the only safe option. The first push of this doc file itself tripped the trap — a reminder that the scanner does not care whether the author meant it.

## `curl --resolve` is a slice test, not an end-to-end test

**Trap:** `curl --resolve host:port:ip` (or `/etc/hosts` override) bypasses DNS entirely. A successful response proves TCP/TLS/app work, but says nothing about whether the real DNS path resolves correctly. It is easy to conclude "it works" when the actual statement is "it works _if DNS is also correct_".

**Workaround:** Whenever you use `--resolve` or an `/etc/hosts` override in testing, mark the test explicitly as a bypass and re-test without the override before calling anything done. A browser hitting the bare hostname is the minimum bar for "end-to-end verified".

## Caddy cert storage is per-CA

**Trap:** Switching ACME CAs (staging ↔ production) looks like "Caddy lost my certificate" because Caddy stores issued certs under a per-CA directory: `acme-staging-v02.../prmng.org/` vs `acme-v02.../prmng.org/`. Switching CAs reads the new directory; if empty, Caddy obtains a fresh cert from that CA.

**Useful consequence:** staging and production certs coexist without conflicting. You can flip between them repeatedly during bootstrap.

**Force re-issuance:** delete the per-CA subdirectory for the domain. Caddy will re-request on next restart.

## `env | grep TOKEN` leaks the token into the conversation

**Trap:** Diagnosing env issues with `env | grep <NAME>` dumps the full value wherever the command output is displayed. If the shell is an agent transcript or a shared session, the secret is now in the log.

**Workaround:** Habit — filter values by default. Use `env | grep -E '^(TOKEN\|KEY\|PASSWORD\|SECRET)=' | sed -E 's/=.*/=<redacted>/'` or similar. If a value has already been exposed, rotate it immediately; do not rely on "I can scroll up and delete the line".

## Push notifications silently show "nicht konfiguriert"

**Trap:** The "Push-Benachrichtigungen aktivieren" affordance triggers the browser's permission prompt, the user grants it, and the UI then flashes "Push-Benachrichtigungen sind auf diesem Server nicht konfiguriert" without ever subscribing. No push messages arrive. Easy to mistake for a CORS or service-worker regression because the symptom sits on the client side.

**First check:** the boot-time feature manifest. Search the most recent app logs for `event=config-feature-manifest`; the line names every feature with its state and (when disabled) the missing variable:

```bash
docker compose logs app --no-log-prefix | grep config-feature-manifest | tail -1
# → … "push":{"state":"disabled","reason":"VAPID_PRIVATE_KEY is not set"} …
```

If the manifest reports `push: enabled` but the UI still shows "nicht konfiguriert", the issue is downstream of the env (network, service-worker, cache); the rest of this section does not apply.

**Root cause:** `VAPID_PRIVATE_KEY` is unset in the VPS deploy environment. The server's `/api/push/vapid-public-key` endpoint correctly returns `{"vapidPublicKey": null}`, which the client accurately renders as "not configured" (pushClient.ts `resolveVapidPublicKey` → `{ reason: 'not-configured' }`). The permission prompt fires first because spec §9.8 / AC-201 require the prompt to live inside the user gesture — the server round-trip happens afterwards.

**Workaround (actually the fix):**

```bash
# Probe the live endpoint first — a null value confirms the server is the problem.
curl -sS https://<your-domain>/api/push/vapid-public-key
# → {"vapidPublicKey":null}   means VAPID_PRIVATE_KEY is unset

# On the operator workstation, generate a keypair (keep privateKey stable across deploys
# — rotating invalidates every browser subscription).
npx web-push generate-vapid-keys --json
```

Add `VAPID_PRIVATE_KEY=<privateKey>` to `secrets.env.age` (see [manual-deploy.md § Rotate a secret](manual-deploy.md#rotate-a-secret)). Add `VAPID_SUBJECT=mailto:admin@<your-domain>` to the plain `.env` next to `DOMAIN` — it is non-secret. Redeploy. The same probe should then return a real base64url-encoded key, and the subscribe flow lights up.

## `source <(age -d …)` hangs or reports `incorrect passphrase` with no prompt

**Symptom:** `source <(age -d secrets.env.age)` either prints the prompt, accepts the passphrase, then hangs indefinitely, OR errors with `age: error: incorrect passphrase` having never shown a prompt at all (observed 2026-05-03 in `scripts/deploy.sh`).

**What we know:** The exact age/tty interaction at fault isn't pinned down. Process substitution runs `age` and the consumer (`source`) concurrently with `age`'s stdout wired to a FIFO; with interactive prompts in the mix, the timing is fragile across terminal type, SSH pty allocation, and whether a wrapping process (agent, multiplexer) intercepts the tty.

**Workaround:** Use command substitution. `age` runs to completion before bash touches its output, so the concurrency is gone. Capture into a variable (rather than `eval "$(age -d …)"` directly) so `set -e` fires on age failure instead of letting the script fall through with empty env:

```bash
SECRETS_PLAINTEXT="$(age -d secrets.env.age)"   # set -e exits here on age failure
set -a
eval "$SECRETS_PLAINTEXT"
set +a
unset SECRETS_PLAINTEXT
```

`set -a` auto-exports every `KEY=value` assignment, matching the process-substitution form's net effect. Plaintext stays in memory only. `scripts/deploy.sh` uses this form (switched from process substitution after the no-prompt failure on 2026-05-03).

## `column "<X>" of relation "<T>" does not exist` after a deploy

**Trap:** First request that touches a recently-added column 500s with this Postgres error, even though the deploy itself reported healthy.

**Root cause:** `migrate()` skips an edited `0000_baseline.sql` — it compares the journal `when`, not the hash ([recover-from-schema-change.md](recover-from-schema-change.md)). The live DB stays on the previous schema while `schema.ts` describes the new one. Same trap exists locally on `projekt-manager_pgdata`.

**Detection:** Both `scripts/deploy.sh` (pre-flight) and `npm run dev` / production boot (via `src/server/db/baseline-guard.ts`) compare the on-disk baseline's sha256 to the ledger entry and abort with `Baseline schema mismatch …` before serving traffic. Hitting this section means a guard was bypassed (e.g. a stale image), the message was missed, or the trap recurred between the guard and the next request.

**Workaround:** Wipe and reseed both VPS and local DBs, then sync. Full procedure: [recover-from-schema-change.md](recover-from-schema-change.md).
