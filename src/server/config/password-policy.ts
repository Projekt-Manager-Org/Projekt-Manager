/**
 * Password policy — single source of truth for length and blocklist rules.
 *
 * Both the change-password endpoint (user-facing, German error messages)
 * and the first-run admin bootstrap (operator-facing, English error
 * messages via the env var name) call into this module. Keeping the rules
 * here means a policy change in one place cannot silently diverge between
 * the two enforcement points.
 *
 * See ADR-0006 (NIST SP 800-63B + local blocklist) for the decision
 * rationale and ADR-0010 (bootstrap) for the reason a shared module exists.
 */

import { isCommonPassword } from './common-passwords.js';

/** Minimum password length, counted in JavaScript characters. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Maximum password length, counted in **UTF-8 bytes**.
 *
 * bcrypt truncates its input at 72 bytes. Counting JS characters (`.length`)
 * is NOT the same — a password like `'测'.repeat(25)` is 25 characters but
 * 75 bytes, which bcrypt would silently truncate to the first ~24 characters,
 * leaving the user with a much weaker password than they intended.
 * Enforcing the limit in bytes closes that trap.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Structured description of a password-policy violation. Callers format
 * their own user-facing message (German for the change-password endpoint,
 * operator-facing English for the bootstrap) from the structured fields.
 */
export type PasswordPolicyViolation =
  | { code: 'too_short'; minLength: number }
  | { code: 'too_long'; maxBytes: number; actualBytes: number }
  | { code: 'blocklist' };

/**
 * Check a plaintext password against the full policy in order:
 *
 *   1. Minimum length (characters)
 *   2. Maximum length (UTF-8 bytes, to match bcrypt's truncation point)
 *   3. Common-password blocklist
 *
 * Returns `null` if the password is acceptable, or a structured violation
 * naming which rule failed. Ordering matters: length checks are cheap and
 * run before the blocklist lookup.
 *
 * The returned object NEVER contains the password itself, so callers can
 * safely log it for debugging without leaking the plaintext.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyViolation | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { code: 'too_short', minLength: MIN_PASSWORD_LENGTH };
  }
  const actualBytes = Buffer.byteLength(password, 'utf8');
  if (actualBytes > MAX_PASSWORD_BYTES) {
    return { code: 'too_long', maxBytes: MAX_PASSWORD_BYTES, actualBytes };
  }
  if (isCommonPassword(password)) {
    return { code: 'blocklist' };
  }
  return null;
}
