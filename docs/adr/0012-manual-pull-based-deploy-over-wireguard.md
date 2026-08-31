# ADR-0012: Manual pull-based deploy over WireGuard

- **Status:** Accepted
- **Date:** 2026-04-10
- **Confidence:** High

## Context

ADR-0011 moved image builds from the VPS to GitHub Actions + GHCR. The build leg is clean. The deploy leg — `.github/workflows/deploy.yml` SSHing into the VPS as the `deploy` user — was left unchanged. This ADR replaces it.

Two forces turn the push-based path into a liability at this project stage:

**1. Blast radius is disproportionate to the threat model.**

The `deploy` user is in the `docker` group, which is functionally root: any member can `docker run -v /:/host --rm alpine chroot /host sh` and walk the host filesystem. Accepted Docker architecture quirk, not a bug — but it means `secrets.DEPLOY_KEY` is a root-equivalent credential. Anything that can read GHA secrets, inject a workflow step, or publish a malicious Action executes arbitrary code as effective root on the only production host.

Realistic threats at pilot scale are data loss and unreliability, not a targeted supply-chain actor. The push path optimises for operator convenience (auto-deploy on green CI) at the cost of handing out a root-equivalent credential to an unaudited environment on every commit.

**2. LLM-assisted solo workflow cannot reliably audit CD configuration.**

Concrete incident: the `workflow_run` trigger loads the workflow file from the default branch, not the branch whose CI fired the event. Three `deploy.yml` changes landed on iteration branches and were **silently ignored** until merge. The caveat was documented; three changes were made anyway. The gotcha is a shape the workflow surface makes easy to get wrong and hard to detect.

Generalising: CD config is security-critical code running with root privilege on production, and in a solo LLM-assisted flow reviewer attention is saturated by diff volume. "Accept and document" is not acceptable for a foundation concern. The remaining move is to remove the foundation that needs auditing.

## Decision

Delete the push-based GHA deploy path; replace with a manual pull-based flow the operator runs on the VPS over WG. Secrets live encrypted at rest in a single age-wrapped file; plaintext never touches disk. ADR-0011's artifact pipeline (CI → GHCR, SHA-tagged immutable images) is preserved — only the distribution-to-host leg changes.

### What's removed

- `.github/workflows/deploy.yml` — deleted.
- GitHub repo secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KEY`.
- Interactive SSH for the `deploy` user (shell → `/usr/sbin/nologin`, `~deploy/.ssh/authorized_keys` removed). The outbound `github_deploy` keypair + `config` entry stay — `scripts/deploy.sh` needs them for `git fetch origin`.

The `deploy` user itself is kept: still owns `/opt/projekt-manager`, still in `docker` group, still the identity Compose runs under. Only SSH-accept is removed.

### What stays

- `.github/workflows/ci.yml` — `lint`, `check-shard`, `check`, `docker`, `publish` unchanged.
- `ghcr.io/projekt-manager-org/projekt-manager` with `sha-<commit>` and `<branch-slug>` tags — ADR-0011 untouched.
- Rollback — any previous SHA tag can be redeployed (now via `./deploy.sh <sha>`).
- SHA assertion after `git checkout` and smoke test (`docker compose exec -T app node -e "fetch('/api/health')"`) — both preserved in `scripts/deploy.sh`.

### What's new

- `scripts/deploy.sh` — committed, run on the VPS by the operator via `sudo -u deploy`. Takes an optional git ref (default `origin/main`, explicit SHA for rollback). Fetches, checks out, asserts SHA, decrypts secrets, pulls GHCR image, `docker compose up -d`, polls `/api/health`.
- `/opt/projekt-manager/secrets.env.age` — age-encrypted (passphrase) env file holding the secrets `docker-compose.yml` substitutes via `${VAR}`: `POSTGRES_PASSWORD`, `STORAGE_SECRET_KEY`, `CLOUDFLARE_API_TOKEN`, plus the Layer 2 backup keys (`R2_*`, `AGE_RECIPIENT`) and any optional secrets the operator opts into (`VAPID_PRIVATE_KEY`, `OPENROUTER_API_KEY`). Non-secret operator vars (`DOMAIN`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `WG_BIND_IP`, ...) live in plain `.env` (docker compose reads automatically). The canonical key list lives in `secrets.manifest.txt`. Plaintext never written on the VPS: `scripts/deploy.sh` sources the decrypted stream via process substitution (`source <(age -d …)`) — plaintext flows through an anonymous fd.

### Operator flow

1. Log in to the VPS over WG via the operator's sudo account.
2. `sudo -u deploy /opt/projekt-manager/scripts/deploy.sh [ref]`.
3. Enter age passphrase at the prompt.
4. Script completes with `Deploy verified — healthy at <sha>` or fails loudly.

## Alternatives considered

- **Keep GHA→VPS with tighter scoping.** OIDC short-lived creds, or a sudoers whitelist of exact `docker compose` subcommands. Narrowing reduces theoretical exposure but does not address the root concern — CD config is itself root-privileged code the LLM-assisted workflow cannot reliably audit. The `workflow_run` gotcha still applies. Operational overhead of argument-matching sudoers is meaningful.
- **Self-hosted runner inside WG.** Same reasons as ADR-0011's build rejection: second stateful host, self-hosted runners are themselves security-sensitive (execute arbitrary workflow code). Moves the trust problem, does not shrink it.
- **Pull-based GitOps agent on the VPS** (Flux, ArgoCD, watchtower-style poll). Obvious target state at team scale. Rejected for this iteration: adds a stateful component; operator already watches every deploy; marginal gain over manual `./deploy.sh` for a single operator is small. Kept as the upgrade path below.
- **Commit secrets to the repo (sops, sealed-secrets, SOPS+age).** Decrypt key still lives on the VPS — trust root moves, does not shrink. Makes sense with multiple operators/environments sharing a source of truth; with one of each, the ergonomics cost (tooling, key rotation ceremony) is not repaid.
- **Ansible Vault over SSH.** Reintroduces the same class of remote-trust-link the cutover removes, just shifted a layer. Adds another unaudited tool.

## Consequences

### Positive

- **Remote trust link removed.** Compromising a workflow, an Action publisher, or GHA secrets no longer grants VPS access. The VPS is reachable only over WG by the operator's personal account, independent of the GHA supply chain.
- **The `workflow_run` default-branch bug class is designed out.** No CD workflow file, no gotcha. `deploy.sh` lives in-tree, reviewed alongside every other code change.
- **Secrets move off GitHub and off `docker-compose.yml`'s `environment:` at rest.** One age passphrase unlocks them at invocation; plaintext never on VPS disk. Secret surface = one encrypted file + one passphrase in the operator's password manager.
- **Rollback interface = forward-deploy interface.** `./deploy.sh sha-<old>` vs `./deploy.sh origin/main`. No separate "how to roll back" to remember under pressure.
- **Builds and GHCR untouched.** ADR-0011's artifact pipeline stays — two concerns cleanly separated.
- **The config that can misconfigure production is one shell script, reviewed as code.** Not a multi-stage GHA DAG assembled from third-party Actions whose SHAs drift.

### Negative / residual risks

Documented and accepted. Each has an upgrade trigger.

- **`deploy` still in `docker` group.** Cutover reduces _exposure_ (no remote key hands it out) but not _posture_. Rootless Docker or Podman is the direction. Trigger: operational cost of migration justified by stack growth, or before repo/GHCR goes public.
- **GHCR PAT on the VPS.** `docker login` uses a classic PAT scoped `read:packages`. Treat as a key — location, expiry, rotation in `docs/ops/manual-deploy.md`. Small exposure vs what was removed.
- **VPS reboot requires manual re-deploy.** Stack does not come back alone because secrets are not on disk. Acceptable at pilot scale / single operator. Trigger: reboot-miss incidents accumulate → VPS-local secrets manager (Docker secrets from a systemd-delivered unseal file, or minimal KMS).
- **Passphrase loss = regenerate secrets from sources of record** (password manager, Cloudflare dashboard, Postgres/MinIO reset paths). Recovery in `docs/ops/manual-deploy.md`.
- **Compromised dev machine can publish a malicious image to GHCR.** Mitigated by manual promotion — an attacker-tagged image does not deploy itself; the operator reviews the SHA passed to `./deploy.sh`. Not fully mitigated by this ADR; signing (Sigstore cosign) is the scale-up answer.
- **Solo-operator bus factor.** Passphrase lives with one person. Second operator → multi-recipient age or a shared password-manager entry. Cheap to add when needed.

## Upgrade path

The cutover is a principled retreat to a smaller trust surface. Expected progression:

1. **This ADR** — manual pull-based deploy, secrets encrypted at rest, no remote trust link.
2. **Rootless Docker or Podman** — eliminates the `docker`-group-equals-root residual, enables the next step safely.
3. **Pull-based GitOps agent** — reintroduces automation once the trust root is small enough that an always-on agent is not a net privilege expansion.
4. **Multi-recipient secrets and signed images** — once a second operator exists or the GHCR package goes public.

The artifact pipeline (CI → GHCR, ADR-0011) is compatible with every step without modification — future automation bolts onto it, does not replace it.

## Dep lifecycle health (as of 2026-05-15)

| Dep                                                           | Last release               | License      | Maintainership                         | Notes                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | -------------------------- | ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `age` ([FiloSottile/age](https://github.com/FiloSottile/age)) | v1.2.x stable line, active | BSD-3-Clause | Filippo Valsorda + maintainers, active | Spec-stable since v1.0 (2022); reference Go implementation + Rust port (`rage`). Used identically in [ADR-0020](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) and [ADR-0024](0024-binary-attachment-e2e-encryption.md) with independent identities. No published deprecation; small surface area, easy to audit. |

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md) — original topology; this ADR replaces its deploy leg
- [ADR-0008: VPN-first network access](0008-vpn-first-network-access.md) — defines the operator's access path
- [ADR-0009: Pin Docker versions across environments](0009-pin-docker-versions-across-environments.md) — still applies; deploy script relies on deterministic compose behavior
- [ADR-0011: Build app images in CI, distribute via GHCR](0011-build-images-in-ci-distribute-via-ghcr.md) — unchanged; this ADR only replaces the distribution-to-host leg
