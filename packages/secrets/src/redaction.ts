import {
  CREDENTIAL_VALUE_PATTERNS,
  isDisallowedConfigurationEntry,
  isSensitiveDiagnosticKey,
  looksLikeCredentialKey,
  looksLikeCredentialValue,
  looksLikeSensitiveDiagnosticValue,
  SENSITIVE_DIAGNOSTIC_VALUE_PATTERNS,
} from "./patterns.js";
import { REDACTION_PLACEHOLDER } from "./placeholder.js";
import { SensitiveValue } from "./sensitive-value.js";

export { REDACTION_PLACEHOLDER } from "./placeholder.js";

/** JSON-shaped output of `redactJson` — deliberately local to this package (no dependency on `@heniek/config`). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const CIRCULAR_PLACEHOLDER = "[circular]";
const MAX_DEPTH_PLACEHOLDER = "[max-depth-exceeded]";

// A defensive ceiling, not a spec requirement: it exists purely so a
// pathologically deep (or accidentally self-nesting) input structure fails
// safely with a placeholder instead of a stack overflow. Ordinary
// configuration and diagnostic payloads never come close to it.
const MAX_DEPTH = 64;

/**
 * Deep-walks `value` and returns a new, JSON-shaped structure with every
 * credential rendered as `REDACTION_PLACEHOLDER`:
 *
 *  - any `SensitiveValue`, regardless of where it appears;
 *  - any value — of any type — found under a credential-shaped key
 *    (`looksLikeCredentialKey`), since the point of a credential-named
 *    field is that its *contents* are sensitive, not just string contents;
 *  - any string whose shape matches a known credential pattern
 *    (`looksLikeCredentialValue`), even under an innocuous key.
 *
 * Cycle-safe: a reference that reappears within its own ancestor chain is
 * rendered as `"[circular]"` rather than recursed into again. Depth-safe:
 * nesting beyond `MAX_DEPTH` is truncated with `"[max-depth-exceeded]"`.
 * The input is never mutated — a new structure is always returned.
 */
export function redactJson<T>(value: T): JsonValue {
  return redactValue(value, new Set<object>(), 0);
}

/** Placeholder for `Buffer`/typed-array values — see the boxed/exotic-value note on `redactValue`. */
const BINARY_PLACEHOLDER = "[binary]";

function redactValue(value: unknown, ancestors: Set<object>, depth: number): JsonValue {
  if (value instanceof SensitiveValue) {
    return REDACTION_PLACEHOLDER;
  }
  if (typeof value === "string") {
    return looksLikeCredentialValue(value) || looksLikeSensitiveDiagnosticValue(value)
      ? REDACTION_PLACEHOLDER
      : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "object") {
    // `undefined`, functions, symbols, bigint — none are JSON-representable.
    // `JSON.stringify` drops them (inside objects) or emits `null` (inside
    // arrays); rendering `null` here matches the array case and keeps the
    // return type honest.
    return null;
  }

  // Boxed primitives (`new String(...)`, `new Number(...)`, `new
  // Boolean(...)`) are unwrapped and redacted through the same scalar path
  // as their primitive counterparts. Left alone they are neither an array
  // nor a useful plain object: `Object.entries(new String("ghp_..."))`
  // yields one enumerable property per character index, which would both
  // dodge value-shape redaction and emit a misleading per-character shape.
  if (value instanceof String || value instanceof Number || value instanceof Boolean) {
    return redactValue(value.valueOf(), ancestors, depth);
  }

  // `Date` has no own enumerable properties, so falling through to the
  // plain-object branch below would silently render it as `{}` — indistinguishable
  // from an empty object and useless as a diagnostic. Render the same
  // ISO-8601 string `JSON.stringify` would produce.
  if (value instanceof Date) {
    return value.toISOString();
  }

  // `Buffer` and every `TypedArray` (`Uint8Array`, `Int32Array`, …) are
  // `ArrayBuffer` views. Falling through would walk their indexed own
  // properties and emit a `{"0": 12, "1": 200, ...}` byte dump — a shape
  // that is both misleading (looks like an ordinary numeric-keyed object)
  // and actively unsafe (raw credential bytes, e.g. a key loaded into a
  // `Buffer`, would be rendered verbatim instead of redacted). Render an
  // explicit opaque placeholder instead of any byte content.
  if (ArrayBuffer.isView(value)) {
    return BINARY_PLACEHOLDER;
  }

  if (ancestors.has(value)) {
    return CIRCULAR_PLACEHOLDER;
  }
  if (depth >= MAX_DEPTH) {
    return MAX_DEPTH_PLACEHOLDER;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors, depth + 1));
    }

    // `Map` and `Set` have no own enumerable properties either (their
    // contents live behind iterator methods), so — like `Date` — they would
    // otherwise silently render as `{}`. Render their contents explicitly,
    // redacting recursively, as JSON-shaped arrays: `Map` as `[key, value]`
    // pairs (mirroring `Map#entries()`), `Set` as a values array.
    if (value instanceof Map) {
      return Array.from(value.entries()).map(([key, entryValue]) => [
        redactValue(key, ancestors, depth + 1),
        redactValue(entryValue, ancestors, depth + 1),
      ]);
    }
    if (value instanceof Set) {
      return Array.from(value.values()).map((item) => redactValue(item, ancestors, depth + 1));
    }

    // Built with `Object.defineProperty` rather than `out[key] = ...`: a
    // plain `{}` accumulator assigned via bracket notation is vulnerable to
    // prototype pollution when the input carries an own `__proto__` key
    // (e.g. from `JSON.parse('{"__proto__":{"polluted":true}}')`) — bracket
    // assignment invokes `Object.prototype`'s `__proto__` *setter*, which
    // reassigns the accumulator's own prototype instead of creating a
    // `"__proto__"` data property. `defineProperty` always creates an own
    // data property, regardless of what accessor the key would otherwise
    // resolve to, so the accumulator's prototype can never be attacker
    // controlled and the result still serialises as an ordinary plain
    // object (`Object.prototype`-rooted, not `Object.create(null)`).
    const out: { [key: string]: JsonValue } = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      // A string entry routes through the same `isDisallowedConfigurationEntry`
      // predicate the restricted-YAML guard uses (design §3, `@heniek/secrets`
      // patterns.ts), so the two can never disagree about whether a given
      // key/string-value pair is credential-shaped. A non-string entry has
      // no equivalent in that predicate (which is deliberately scoped to
      // scalar strings) — it keeps the broader "any type under a
      // credential-shaped key is sensitive" behaviour documented above.
      const redacted =
        typeof entryValue === "string"
          ? isDisallowedConfigurationEntry(key, entryValue) || isSensitiveDiagnosticKey(key)
            ? REDACTION_PLACEHOLDER
            : redactValue(entryValue, ancestors, depth + 1)
          : looksLikeCredentialKey(key) || isSensitiveDiagnosticKey(key)
            ? REDACTION_PLACEHOLDER
            : redactValue(entryValue, ancestors, depth + 1);
      // The *key itself* can be the credential (a raw token pasted into an
      // object literal as a key rather than a value) — `key` is checked
      // against the value-shape patterns (`looksLikeCredentialValue`),
      // separately from `looksLikeCredentialKey` above, which only ever
      // decides whether the *value under* a normally-named key is sensitive
      // and previously left a credential-shaped key name to survive into the
      // output verbatim (C7). Mirrors the identical fix on the
      // restricted-YAML guard's `Pair` keys (`@heniek/config`'s
      // `restricted.ts`), so the two packages can never disagree about a
      // credential accepted in key position. Two distinct credential-shaped
      // keys in the same object both collapse onto the literal
      // `REDACTION_PLACEHOLDER` string; the second silently overwrites the
      // first, which is preferable to leaking either.
      const outputKey = looksLikeCredentialValue(key) ? REDACTION_PLACEHOLDER : key;
      Object.defineProperty(out, outputKey, {
        value: redacted,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    // Removed once this branch of the recursion finishes, so two sibling
    // fields that happen to reference the same object (a diamond, not a
    // cycle) are each redacted independently rather than one being flagged
    // circular.
    ancestors.delete(value);
  }
}

/** Builds a global-flagged copy of `pattern` so `.replace()` replaces every match, not just the first. */
function toGlobalPattern(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
}

// Compiled once at module load rather than inside `redactText` on every
// call: `RegExp` construction re-parses the pattern source, and this array
// is otherwise identical across calls. Reusing the same global-flagged
// `RegExp` objects across calls is safe here because `String.prototype.replace`
// resets a global pattern's `lastIndex` to 0 at the start of every call
// (per spec) and each call runs to completion synchronously before the
// next can start, so there is no cross-call state to interfere with.
const GLOBAL_SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  ...CREDENTIAL_VALUE_PATTERNS,
  ...SENSITIVE_DIAGNOSTIC_VALUE_PATTERNS,
].map(toGlobalPattern);

/**
 * Redacts credential-*shaped* substrings out of free text (log lines,
 * diagnostic messages). Unlike `redactJson`, there is no key to consult —
 * only the value-shape patterns apply, replaced wherever they occur.
 */
export function redactText(text: string): string {
  let result = text;
  for (const pattern of GLOBAL_SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return result;
}
