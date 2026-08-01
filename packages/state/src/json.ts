/**
 * `JsonValue` and `canonicalize` — copied, not imported, from
 * `packages/conformance/src/kernel/json.ts:2-31`. Importing would give
 * `@heniek/state` a runtime edge on `@heniek/conformance` for ~30 lines of
 * pure, already-pinned logic (plan §0.6, design D14). Any future edit to
 * the conformance original must be mirrored here by hand.
 */

import { StateStoreError } from "./errors.js";

/** A JSON-serializable value — the shape every journal payload must hold to. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Recursively sorts object keys so structurally identical values serialize
 * identically regardless of insertion order — required for byte-reproducible
 * canonical payloads.
 */
export function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort();
    const out: Record<string, JsonValue> = {};
    for (const key of sortedKeys) {
      const entryValue = (value as { readonly [key: string]: JsonValue })[key];
      if (entryValue !== undefined) {
        out[key] = canonicalize(entryValue);
      }
    }
    return out;
  }
  return value;
}

/**
 * Parses `text` as JSON and asserts the result is a `JsonValue`. `JSON.parse`
 * cannot actually produce anything outside that shape (no `undefined`, no
 * functions, no cyclic structures survive a round trip through text), but
 * this guard is what lets every downstream consumer avoid an `as` cast on
 * parsed input.
 */
export function parseJsonValue(text: string, what: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new StateStoreError(`${what} is not valid JSON: ${reason}`);
  }
  return assertJsonValue(parsed, what);
}

function assertJsonValue(value: unknown, what: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => assertJsonValue(item, what));
  }
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      out[key] = assertJsonValue(entryValue, what);
    }
    return out;
  }
  throw new StateStoreError(
    `${what} contains a value that is not JSON-representable (${typeof value})`,
  );
}

/** `JSON.stringify(canonicalize(value))` — the package's one canonical serialisation. */
export function stringifyCanonical(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

/** The UTF-8 byte length of `text`, used to enforce D7's payload cap. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
