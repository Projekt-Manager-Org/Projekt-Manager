# Layer 2 Backup — Credential Rotation

Rotate the R2 token and (optionally) the age key pair. This is a planned operator procedure — not retention rotation (retention is linear and provider-managed; see [overview.md](overview.md)).

Do it any time an R2 token is suspected of leak, on staff handover, or on a scheduled interval (recommended: annually).

You are about to burn the current credentials; older encrypted backups in R2 remain readable only if you keep the corresponding age identity.

## Procedure

**Before step 1 — quiesce the scheduler.** Stop the backup service so it does not accumulate `AccessDenied` errors against the dead token while the next steps are in flight. The badge will fall stale until the redeploy completes; that is expected.

SSH to the VPS as the admin user, then run via `sudo -u deploy`. Use `docker stop` directly, not `docker compose stop`. The compose path re-parses `docker-compose.yml`, which requires the full set of interpolation vars (`POSTGRES_PASSWORD`, `CLOUDFLARE_API_TOKEN`, etc.) in shell env; a bare sudo shell doesn't have them sourced, so parse aborts with `CLOUDFLARE_API_TOKEN must be declared`. Same class of problem fixed in `server-setup.md` Phase 8.1 (commit 5484903).

```bash
sudo -u deploy docker stop projekt-manager-backup-1
```

1. **Burn the R2 token.** Cloudflare dashboard → R2 Object Storage → **{ } API** → **Manage API tokens** → select the current token → **Delete**. Confirm. Every client using this token fails on its next call — the scheduler is already stopped, so the VPS side stays quiet.
2. **Issue a fresh R2 token.** Re-run [setup.md §1.4](setup.md#14-create-the-api-token). Capture the new Access Key ID, Secret Access Key, Endpoint URL.
3. **(Optional) Rotate the age key pair.** Do this if the password-manager entry or a custody copy is suspected compromised, the operator workstation was lost, or on a slower cadence than the token rotation.

   Cost: older R2 objects encrypted to the old recipient become unreadable by the new identity. Options:
   - **Accept the gap.** Old dumps age out under the lifecycle rule. During the immutable window ([ADR-0020 §Retention](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention)), any restore from locked artifacts must still use the old identity — keep it in the password manager, marked "retired, read-only".
   - **Re-encrypt the lock window.** For each still-locked old object: download, `age -d` with the retired identity in a [working file](../index.md#working-file), `age -r <new-recipient>`, re-upload under a new timestamped key. Labour-intensive; skip unless the old identity is confirmed compromised.

   To rotate: rerun [setup.md §2](setup.md#2-generate-the-age-key-pair) into a new password-manager entry; mark the old one "retired, read-only" ([Key custody](../index.md#key-custody)).

4. **Push the new creds to the VPS.** Rerun [setup.md §3](setup.md#3-push-r2-credentials--recipient-to-the-vps) with the new R2 values and (if rotated) the new `AGE_RECIPIENT`.
5. **Redeploy.** Rerun [setup.md §4](setup.md#4-first-deploy).
6. **Restart the scheduler.** Bring the backup service back up so the next interval tick fires. No-op if the redeploy in step 5 already recreated and started the `backup` container (deploy.sh uses `--profile backup up -d` so the backup service is in the managed set); otherwise this flips it from the pre-step-1 stopped state:

   ```bash
   sudo -u deploy docker start projekt-manager-backup-1
   ```

7. **Sanity-check.** Immediately run the monthly drill per [drills.md § Monthly drill](drills.md#monthly-operator-workstation-drill) against the next completed backup. A rotation that passes the drill is successfully done; a rotation whose drill fails is a rollback candidate — restore the previous `secrets.env.age` from the password manager and investigate before retrying.
