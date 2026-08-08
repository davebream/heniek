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
 * a false positive here would silently mangle ordinary configuration.
 *
 * The `secret`/`key` camelCase compounds (`secretKey`, `secretAccessKey`,
 * `apiSecret`) are handled as explicit atomic alternatives rather than a
 * generic "`secret` followed by an uppercase letter" rule: this whole
 * pattern carries the `i` flag, and under `/i` a character class such as
 * `[A-Z]` matches lowercase letters too, so a "requires an uppercase
 * follow-on letter" lookahead/lookbehind cannot actually distinguish
 * `secretKey` from `secretsDirectory` — both would pass. Enumerating the
 * required compounds sidesteps that trap.
 *
 * The `token` branch matches a bare `token` only when it is *actually*
 * preceded by a `[._-]` separator (`(?<=[._-])`, not just the shared
 * `(^|[._-])` prefix that other keywords use, which also allows a bare
 * start-of-string match) — this is what keeps a standalone `token` or
 * `tokens` key out of the credential set while still catching `auth_token`,
 * `GITHUB_TOKEN`, and `gh_token`. A further negative lookbehind excludes the
 * separator-prefixed segment when the word before it is one of the known
 * non-credential qualifiers (`max`, `min`, `num`, `count`, `budget`,
 * `limit`, `total`, `used`, `remaining`), which is what keeps `max_tokens`
 * out. `token_budget` and `tokenCount` are already excluded by the
 * mandatory-leading-separator rule above, since `token` is the *first* word
 * in both and so is never preceded by an actual separator character.
 *
 * The `bearer` branch excludes a `_capacity` (or `.capacity`/`-capacity`)
 * suffix so a rate-limit field such as `bearer_capacity` is not swept up.
 */
export const CREDENTIAL_KEY_PATTERN =
  /(^|[._-])(password|passphrase|secret[_-]?access[_-]?key|secret[_-]?key|secret|api[_-]?key|apikey|api[_-]?secret|access[_-]?key|private[_-]?key|client[_-]?secret|(?<=[._-])(?<!(?:max|min|num|count|budget|limit|total|used|remaining)[._-])token|bearer(?![._-]?capacity)|credentials?)([._-]|$)/i;

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
  // GitHub token, classic and scoped: `ghp_` (personal), `gho_` (OAuth),
  // `ghu_` (user-to-server), `ghs_` (server-to-server/installation), `ghr_`
  // (refresh) — all share the `gh[pousr]_` + 36+ alphanumerics shape.
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  // GitHub fine-grained personal access token: `github_pat_` + id + secret.
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  // OpenAI/Anthropic/Stripe-style secret key: `sk-` or `sk_` optionally
  // followed by one or more `-`/`_`-delimited segments (`proj-`,
  // `ant-api03-`, `live_`, …) then the long secret run itself. A bare
  // `sk-[A-Za-z0-9]{20,}` stops at the first hyphen and misses `sk-proj-…`
  // (current OpenAI project keys), `sk-ant-api03-…` (Anthropic), and
  // `sk_live_…` (Stripe-style) — three of the most likely credentials here.
  /\bsk[-_](?:[A-Za-z0-9]+[-_])*[A-Za-z0-9_-]{20,}\b/,
  // AWS access key id: `AKIA` + exactly 16 uppercase alphanumerics. This is
  // the non-secret identifier, not the 40-character AWS secret access key
  // that accompanies it — that secret has no distinguishing shape (it is an
  // arbitrary base64-ish string) and adding a shape rule for it would carry
  // a high false-positive rate against ordinary opaque tokens. It is still
  // caught when stored under a credential-shaped key (`secretAccessKey`,
  // `aws_secret_access_key`, …) via `looksLikeCredentialKey`/`redactJson`;
  // this limitation is carried into the phase-3 ADR note.
  /\bAKIA[0-9A-Z]{16}\b/,
  // PEM-encoded private key header (RSA/EC/PKCS8/etc, or unqualified).
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/,
  // JWT-shaped base64url: header.payload.signature. Anchored on `eyJ` — the
  // base64url encoding of `{"`, which every real JWT header starts with —
  // rather than a bare `\b[...]{10,}` run: `-` is not a `\w` character, so a
  // long hyphenated string (e.g. `"a-".repeat(50_000)`) gives the old,
  // un-anchored pattern a fresh `\b` at every letter and made it quadratic
  // (measured ~8s on 64KB of such input). The segment lengths are also
  // capped at 4096 to bound worst-case work on any one candidate match.
  /\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\b/,
];

/** Sensitive provider diagnostics that are unsafe even when they contain no token-shaped value. */
export const SENSITIVE_DIAGNOSTIC_VALUE_PATTERNS: readonly RegExp[] = [
  /\bhttps?:\/\/[^\s"'<>()[\]{}]+/i,
  /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/i,
];

const SENSITIVE_DIAGNOSTIC_KEY_PATTERN =
  /^(?:authorization|proxy-authorization|cookies?|set-cookie|x-api-key|provider[_-]?(?:payload|request|response|error)|raw[_-]?(?:request|response|body)|(?:request|response)[_-]?body)$/i;

/** True when a diagnostic property can contain an opaque provider payload or sensitive header material. */
export function isSensitiveDiagnosticKey(key: string): boolean {
  return SENSITIVE_DIAGNOSTIC_KEY_PATTERN.test(key);
}

/** True when a free-text diagnostic contains a URL or a sensitive HTTP header. */
export function looksLikeSensitiveDiagnosticValue(value: string): boolean {
  return SENSITIVE_DIAGNOSTIC_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** True when `value` matches any known credential value shape. */
export function looksLikeCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * The single predicate for "is this JSON/YAML entry a disallowed
 * configuration value" — shared by `redactJson` (`redaction.ts`, for the
 * string-under-a-key case) and by `@heniek/config`'s restricted-YAML guard
 * (design §3's `yaml.sensitive-value-not-allowed` rule). Both consumers
 * route through this one function so the two can never independently drift
 * on what counts as a disallowed entry.
 *
 * True when either:
 *  - `key` looks credential-shaped (`looksLikeCredentialKey`) and `value` is
 *    a scalar string — deliberately scoped to strings, not any type, so a
 *    reference object such as `{ store: "file", name: "github" }` under a
 *    credential-shaped key stays legal; that is the sanctioned way to point
 *    configuration at the secret store instead of embedding a raw value; or
 *  - `value` is a string whose shape matches a known credential value
 *    pattern (`looksLikeCredentialValue`), regardless of which key it is
 *    under.
 *
 * Always `false` for a non-string `value`: a non-scalar value under a
 * credential-shaped key is a caller decision (`redactJson` still redacts it
 * defensively — see the comment there — but this predicate, which the YAML
 * guard uses to *reject* input outright, does not).
 */
export function isDisallowedConfigurationEntry(key: string, value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return looksLikeCredentialKey(key) || looksLikeCredentialValue(value);
}
