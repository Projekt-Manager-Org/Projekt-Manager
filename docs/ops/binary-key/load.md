# Binary Attachment Key — Load (after every reboot)

The binary identity lives in tmpfs (`/run/binary-key/identity`) and is wiped on every VPS reboot, container recreate, or kernel-level memory reset. The `app` boot probe refuses to start the container until the identity is loaded — there is no degraded mode, no "uploads-yes-downloads-no" path, no fallback to plaintext ([ADR-0024 §Decision "Boot probe"](../../adr/0024-binary-attachment-e2e-encryption.md#decision)). Operator-absence ⇒ application down.

Concept map: [overview.md](overview.md). Backup drill identity sibling procedure: [docs/ops/backup/drills.md § Loading the drill key](../backup/drills.md#loading-the-drill-key-on-the-vps).

## When this fires

- **After every VPS reboot.** Both identities (binary + backup drill) are wiped from tmpfs. App is down until the binary paste lands.
- **After a container recreate** that touches `app` (deploy, manual `docker rm`, OOM-kill restart). The tmpfs is per-container and dies with the PID 1 process.
- **After an explicit reload** — operator-initiated rotation, suspected key drift, ad-hoc verification.

The **deploy auto-prompt** in `scripts/deploy.sh` is the intended trigger in normal operation (mirrors the backup-side auto-prompt). The standalone invocation documented below is the recovery path for ad-hoc reloads.

## The paste

`scripts/binary-key/load-binary-key.sh` writes the identity to a tmpfs mount the `app` container reads from, and never anywhere else. The script mirrors [`scripts/backup/load-drill-key.sh`](../../../scripts/backup/load-drill-key.sh) byte-for-byte at the invariants — same prompt, same `read -s` paste, same `age-keygen -y` round-trip, same recipient match — with `BINARY_AGE_RECIPIENT` and `/run/binary-key/identity` swapped in.

**Location:** `scripts/binary-key/load-binary-key.sh` in the repo. The image build copies it to `/usr/local/bin/load-binary-key` (no `.sh`) — that is the only path the operator ever invokes, via `docker exec` into the running app container. The tmpfs target inside the container is `/run/binary-key/identity` (file mode 0400, owned by the in-container `app` user (UID 1001); the tmpfs mount itself is mode 0700 uid 1001 gid 1001). Both the boot probe (read) and the loader (write) run as `app` — the tmpfs ownership matches so neither side needs a `docker exec -u 0` privilege override.

You are about to write private key material into RAM on the VPS; this is cleared on reboot or on container recreation, and can be overwritten by rerunning the script.

1. Have `~/secrets/binary-identity.txt` open on the operator workstation. Copy its full contents (including the comment lines and the `AGE-SECRET-KEY-1...` body) to the clipboard.
2. SSH to the VPS as the admin user. Use `docker exec` directly, not `docker compose exec` — the compose path re-parses `docker-compose.yml`, which requires the full set of interpolation vars in shell env; a bare sudo shell doesn't have them sourced, so parse aborts. Same class of problem fixed in `server-setup.md` Phase 8.1 (commit 5484903). `-it` allocates a pseudo-TTY so the script's `read -s` actually suppresses echo during the paste:

   ```bash
   sudo -u deploy docker exec -it projekt-manager-app-1 load-binary-key
   ```

3. The script prompts with `read -s` ("Paste age identity, finish with Ctrl-D:"). Paste the clipboard contents, press Enter, then Ctrl-D. The script:
   - Validates the destination is a tmpfs mount (refuses to write otherwise — protects against a docker-compose regression that drops the `tmpfs:` directive).
   - Validates the pasted material parses as an `age` identity by round-tripping through `age-keygen -y`.
   - Compares the derived public recipient against `BINARY_AGE_RECIPIENT` from the container env. Mismatch = operator pasted the wrong key (probably the backup drill identity); the script wipes the partial write and exits non-zero.
   - Writes the identity to `/run/binary-key/identity` (tmpfs, mode 0400, owned by the in-container `app` user, UID 1001).
   - Zeros its own buffer before exit.

4. Verify the key is loaded without exposing it:

   ```bash
   sudo -u deploy docker exec projekt-manager-app-1 \
     test -s /run/binary-key/identity && echo "binary identity loaded"
   ```

5. The boot probe polls for the identity and resumes startup once it appears. It gives up after `DEFAULT_WAIT_TIMEOUT_MS` ([binaryIdentity.ts](../../../src/server/storage/binaryIdentity.ts)); the container then restarts with an empty tmpfs — paste again. `app` has no Docker healthcheck (`docker ps` shows only `Up`), so confirm readiness via `/api/health`:

   ```bash
   sudo -u deploy /opt/projekt-manager/scripts/smoke-app-health.sh projekt-manager-app-1
   curl -fsS https://${DOMAIN}/api/health    # from a WireGuard client
   ```

**Never** write the identity to any path other than `/run/binary-key/identity`. Specifically: not to a bind mount, not to `/opt/projekt-manager`, not to an env var in `secrets.env.age`, not to `docker compose exec app sh -c 'echo ... >'`. A persisted copy on the VPS disk defeats the entire threat model.

## Standalone reload

If `scripts/deploy.sh` did not auto-prompt (or the operator chose to reload outside a deploy), invoke the loader directly per the steps above. Same script, same invariants, same output:

```bash
sudo -u deploy docker exec -it projekt-manager-app-1 load-binary-key
```

## Two-paste workflow

After any VPS reboot or full-stack recreate, **both** operator-loaded identities have to land before the system is fully operational:

| Identity                | Loader            | Failure mode if missed                                                                                                                                     |
| ----------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary (`app`)          | `load-binary-key` | App refuses to start. Hard down. Operator notices because the app is unreachable.                                                                          |
| Backup drill (`backup`) | `load-drill-key`  | Tier 2 drills skipped; freshness badge amber after staleness threshold. App keeps serving ([AC-168](../../spec/verification.md#1522-backup-and-recovery)). |

**Order does not matter** — each loader writes to its own tmpfs, validates against its own env recipient, and is independent of the other. Pick whichever comes to hand first; the other follows.

Practical sequence after a reboot:

```bash
# binary first (because it unblocks the app)
sudo -u deploy docker exec -it projekt-manager-app-1 load-binary-key

# then backup (so the next drill tick exercises Tier 2)
sudo -u deploy docker exec -it projekt-manager-backup-1 load-drill-key
```

Or in either reverse — both pastes are required, both are independent. The deploy script's auto-prompts cover this in the post-deploy case; manual reboots without a deploy need both loaders run by hand.

If the operator pastes the **wrong** identity into a loader (e.g., the backup drill identity into `load-binary-key`), the recipient-match check in the script rejects it with `"the pasted identity's public recipient does not match BINARY_AGE_RECIPIENT"` and wipes the partial write — see [troubleshooting.md § Recipient mismatch](troubleshooting.md#recipient-mismatch). No data is corrupted; retry with the correct identity.
