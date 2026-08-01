/**
 * Single source of truth for "does this look like a credential" — shared by
 * this package's own redaction (`redaction.ts`) and by `@heniek/config`'s
 * restricted-YAML guard (design §3), so the two can never disagree about
 * what counts as a credential shape.
 */

/**
 * Matches a JSON/YAML property key that is credential-shaped.
 *
 * Deliberately narrower than a general "contains secret/token" scanner (see
 * `packages/contracts/test/no-credential-fields.test.ts`, which exists to
 * catch accidental credential-shaped fields in *public contracts* and can
 * afford to be broad). This pattern gates real redaction of real values, so
 * a false positive here would silently mangle ordinary configuration. The
 * `token` branch in particular requires one of `auth`/`access`/`refresh`
 * immediately before it — a bare `token` never matches, which is what keeps
 * `max_tokens` and `token_budget` out of the credential set.
 */
export const CREDENTIAL_KEY_PATTERN =
  /(^|[._-])(password|passphrase|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|(?:auth|access|refresh)[_-]?token|bearer|credentials?)([._-]|$)/i;

/** True when `key` matches the credential-key shape above. */
export function looksLikeCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key);
}

/**
 * Shape-based detectors for values that are almost certainly credential
 * material even when the surrounding key gives no hint at all — a value
 * pasted into a generic `value`, `data`, or free-text field. Each pattern is
 * deliberately tied to one well-known credential format (rather than a
 * generic "looks random" heuristic) so ordinary strings are not swept up as
 * false positives. None of these carry the `g` flag: `looksLikeCredentialValue`
 * relies on `test()` being stateless, and `redactText` builds its own global
 * copies (see `redaction.ts`) so repeated calls never trip over a stale
 * `lastIndex`.
 */
export const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  // GitHub classic personal access token: `ghp_` + 36+ alphanumerics.
  /\bghp_[A-Za-z0-9]{36,}\b/,
  // GitHub fine-grained personal access token: `github_pat_` + id + secret.
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  // OpenAI-style secret key: `sk-` + a long alphanumeric run.
  /\bsk-[A-Za-z0-9]{20,}\b/,
  // AWS access key id: `AKIA` + exactly 16 uppercase alphanumerics.
  /\bAKIA[0-9A-Z]{16}\b/,
  // PEM-encoded private key header (RSA/EC/PKCS8/etc, or unqualified).
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/,
  // JWT-shaped base64url: header.payload.signature, each segment long
  // enough to rule out short, unrelated dot-separated identifiers (e.g.
  // semantic versions or hostnames).
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

/** True when `value` matches any known credential value shape. */
export function looksLikeCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}
