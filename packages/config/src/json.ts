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
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  // Freeze the container first, so a cyclic structure (impossible for JSON
  // proper, but this helper is also used on TypeScript object literals that
  // could in principle be cyclic) cannot recurse forever: `Object.isFrozen`
  // above stops recursion into an already-visited node the next time it is
  // reached.
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
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
 */
export function canonicalJsonStringify(value: JsonValue): string {
  return `${stringifyIndented(value, 0)}\n`;
}

function stringifyIndented(value: JsonValue, depth: number): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const indent = "  ".repeat(depth + 1);
  const closingIndent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const items = value.map((item) => `${indent}${stringifyIndented(item, depth + 1)}`);
    return `[\n${items.join(",\n")}\n${closingIndent}]`;
  }
  const entries = sortedEntries(value as JsonObject);
  if (entries.length === 0) {
    return "{}";
  }
  const lines = entries.map(
    ([key, entryValue]) =>
      `${indent}${JSON.stringify(key)}: ${stringifyIndented(entryValue, depth + 1)}`,
  );
  return `{\n${lines.join(",\n")}\n${closingIndent}}`;
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
