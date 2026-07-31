/** A JSON-serializable value — the shape every trace/artifact payload must hold to. */
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
 * traces (C1/RT1).
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
