/**
 * The plain-JSON type family and pointer/canonicalisation helpers shared by
 * home resolution, restricted-YAML parsing, and configuration-layer
 * resolution (design §2-4). Kept intentionally small — this is not a general
 * JSON-Schema type library, just the closed shape every parsed document and
 * resolved configuration value is guaranteed to fit.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * Recursively `Object.freeze`s `value` and every nested object/array it
 * contains, so the frozen configuration (§8.2's "frozen as immutable JSON
 * in every run") cannot be mutated by a caller holding a reference to an
 * inner node rather than the root.
 *
 * `T` is preserved rather than widened to `JsonValue` so callers keep the
 * precise type of whatever they froze (a `ResolvedConfiguration`, an
 * `ApplicationHome`, …) instead of losing it to the generic JSON shape.
 *
 * Cycle detection uses a `WeakSet` of nodes visited *by this call*, not
 * `Object.isFrozen`. `Object.isFrozen` conflates two different things: "this
 * node was already visited earlier in this same call" and "this node
 * happened to already be frozen before this call started" (e.g. a
 * caller-supplied object literal that was shallow-frozen for an unrelated
 * reason). Treating the latter as a visited node would return it untouched
 * without ever recursing into its children, silently leaving them mutable —
 * exactly the shallow-freeze bug this helper exists to prevent.
 */
export function deepFreeze<T>(value: T): T {
  return deepFreezeVisiting(value, new WeakSet<object>());
}

function deepFreezeVisiting<T>(value: T, visiting: WeakSet<object>): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (visiting.has(value)) {
    return value;
  }
  // Recorded before recursing (not after freezing), so a cyclic structure
  // (impossible for JSON proper, but this helper is also used on
  // TypeScript object literals that could in principle be cyclic) cannot
  // recurse forever: the next time the same node is reached, `visiting.has`
  // above short-circuits.
  visiting.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreezeVisiting((value as Record<string, unknown>)[key], visiting);
  }
  return value;
}

function sortedEntries(value: JsonObject): readonly (readonly [string, JsonValue])[] {
  return Object.keys(value)
    .sort()
    .map((key) => [key, value[key] as JsonValue] as const);
}

/**
 * Serialises `value` as JSON with object keys sorted at every level, 2-space
 * indentation, and a trailing newline. Two structurally-equal
 * `JsonValue`s — regardless of the key order either was built in — always
 * produce byte-identical output, which is what makes a resolved-configuration
 * snapshot (design §4, "byte-identical snapshot for equivalent inputs")
 * meaningful as a diff target.
 *
 * H5: total, not partial. `JSON.stringify` silently *lies* about two input
 * shapes rather than failing: a non-finite number (`Infinity`/`NaN`) becomes
 * the literal `null` (indistinguishable from an actual `null` value once
 * serialised), and `undefined` — reachable here despite `JsonValue` excluding
 * it, since nothing prevents a caller from constructing a `JsonObject` at
 * runtime with a stray `undefined` property despite the type — is not even
 * turned into valid JSON text at all (`JSON.stringify(undefined) ===
 * undefined`, the JS value, which the surrounding template literal would
 * then coerce to the *string* `"undefined"`, embedding invalid JSON in
 * otherwise-valid output). Both are rejected outright with a clear error
 * instead: this is phase 3's declared substrate for a frozen configuration
 * snapshot, and a silent lie there is worse than a loud failure. The
 * recursive walk also carries the same cycle guard `deepFreeze` has (a
 * `Set` of nodes currently on the ancestor path, not a global "already
 * seen" set — two sibling branches that happen to reference the same object
 * are not a cycle) — a cyclic structure is impossible for `JsonValue`
 * proper, but this is also called on hand-built object literals that could
 * in principle be cyclic, and an infinite recursion there must fail with a
 * clear error, not a stack overflow.
 */
export function canonicalJsonStringify(value: JsonValue): string {
  return `${stringifyIndented(value, 0, new Set<object>())}\n`;
}

function stringifyIndented(value: JsonValue, depth: number, visiting: Set<object>): string {
  if (value === undefined) {
    throw new TypeError(
      "canonicalJsonStringify: cannot represent `undefined` as JSON — omit the property instead.",
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(
      `canonicalJsonStringify: cannot represent a non-finite number (${String(value)}) as JSON.`,
    );
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (visiting.has(value)) {
    throw new TypeError("canonicalJsonStringify: cannot represent a cyclic structure as JSON.");
  }
  visiting.add(value);
  try {
    const indent = "  ".repeat(depth + 1);
    const closingIndent = "  ".repeat(depth);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return "[]";
      }
      const items = value.map((item) => `${indent}${stringifyIndented(item, depth + 1, visiting)}`);
      return `[\n${items.join(",\n")}\n${closingIndent}]`;
    }
    const entries = sortedEntries(value as JsonObject);
    if (entries.length === 0) {
      return "{}";
    }
    const lines = entries.map(
      ([key, entryValue]) =>
        `${indent}${JSON.stringify(key)}: ${stringifyIndented(entryValue, depth + 1, visiting)}`,
    );
    return `{\n${lines.join(",\n")}\n${closingIndent}}`;
  } finally {
    // Removed once this branch of the recursion finishes, so two sibling
    // fields that happen to reference the same object (a diamond, not a
    // cycle) are each rendered independently rather than one being flagged
    // circular — mirrors `@heniek/secrets`' `redactJson` ancestor-tracking.
    visiting.delete(value);
  }
}

/**
 * Escapes one RFC 6901 JSON Pointer reference token: `~` must become `~0`
 * *before* `/` becomes `~1`, since encoding `/` first would turn the `~` it
 * introduces into a second, incorrect escape target.
 */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Joins `base` (an already-valid JSON Pointer, `""` for the document root)
 * with one additional, unescaped `segment`, escaping the segment along the
 * way.
 */
export function joinPointer(base: string, segment: string | number): string {
  return `${base}/${escapePointerSegment(String(segment))}`;
}
