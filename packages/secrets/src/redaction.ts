import {
  CREDENTIAL_VALUE_PATTERNS,
  looksLikeCredentialKey,
  looksLikeCredentialValue,
} from "./patterns.js";
import { SensitiveValue } from "./sensitive-value.js";

export const REDACTION_PLACEHOLDER = "[redacted]";

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

function redactValue(value: unknown, ancestors: Set<object>, depth: number): JsonValue {
  if (value instanceof SensitiveValue) {
    return REDACTION_PLACEHOLDER;
  }
  if (typeof value === "string") {
    return looksLikeCredentialValue(value) ? REDACTION_PLACEHOLDER : value;
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

    const out: { [key: string]: JsonValue } = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      out[key] = looksLikeCredentialKey(key)
        ? REDACTION_PLACEHOLDER
        : redactValue(entryValue, ancestors, depth + 1);
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

/**
 * Redacts credential-*shaped* substrings out of free text (log lines,
 * diagnostic messages). Unlike `redactJson`, there is no key to consult —
 * only the value-shape patterns apply, replaced wherever they occur.
 */
export function redactText(text: string): string {
  let result = text;
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    result = result.replace(toGlobalPattern(pattern), REDACTION_PLACEHOLDER);
  }
  return result;
}

/** Builds a global-flagged copy of `pattern` so `.replace()` replaces every match, not just the first. */
function toGlobalPattern(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
}
