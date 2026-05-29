/**
 * First-run admin bootstrap credential validation — single source for the
 * "both-or-neither" pairing rule and the password-policy → operator-message
 * mapping shared by the two enforcement points:
 *
 *   - Boot path (`src/server/bootstrap.ts`): validates the pair before the
 *     DB-empty insert.
 *   - Deploy preflight (`src/server/config/env.ts` cross-field guard):
 *     validates the pair, when present, before `docker compose up`.
 *
 * Keeping it here means the two points cannot drift on what counts as
 * "configured" nor on the operator-facing error text — the same reason
 * `password-policy.ts` exists for the policy core itself. See ADR-0010.
 */

import { checkPasswordPolicy } from './password-policy.js';

export interface BootstrapCredentialInput {
  username: string | undefined;
  password: string | undefined;
}

/**
 * Validate the bootstrap credential pair. Returns an operator-facing
 * English message describing the first offence, or `null` when the pair is
 * acceptable — including the "neither set" opt-out, which callers must
 * still treat as "do not bootstrap".
 *
 * Normalization mirrors the boot path exactly: the username is trimmed (a
 * whitespace-only value is "unset"); the password is taken verbatim (a
 * whitespace password is "set" and must pass the policy, matching bcrypt's
 * byte semantics). docker-compose forwards both as `${VAR:-}`, so an
 * unconfigured deploy sends `""` for each — collapsed to "unset" here.
 */
export function checkBootstrapCredentialPair(input: BootstrapCredentialInput): string | null {
  const username = input.username?.trim() ?? '';
  const password = input.password ?? '';
  const usernameProvided = username.length > 0;
  const passwordProvided = password.length > 0;

  // Opt-out: neither var set is a silent no-op for both callers.
  if (!usernameProvided && !passwordProvided) return null;

  // Fail closed on half-config, naming the missing var.
  if (!passwordProvided) {
    return 'BOOTSTRAP_ADMIN_PASSWORD is required when BOOTSTRAP_ADMIN_USERNAME is set.';
  }
  if (!usernameProvided) {
    return 'BOOTSTRAP_ADMIN_USERNAME is required when BOOTSTRAP_ADMIN_PASSWORD is set.';
  }

  // Password policy (length + blocklist) via the shared core so the two
  // enforcement points cannot diverge on the rules. Messages never include
  // the password itself — the violation object does not carry it.
  const violation = checkPasswordPolicy(password);
  if (violation) {
    switch (violation.code) {
      case 'too_short':
        return `BOOTSTRAP_ADMIN_PASSWORD must be at least ${violation.minLength} characters.`;
      case 'too_long':
        return `BOOTSTRAP_ADMIN_PASSWORD must not exceed ${violation.maxBytes} bytes when UTF-8 encoded.`;
      case 'blocklist':
        return 'BOOTSTRAP_ADMIN_PASSWORD is in the common-password blocklist. Choose a less common password.';
    }
  }

  return null;
}
