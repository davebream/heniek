/**
 * Materialize validated stage outputs into canonical JSON state for conditions.
 */

import type { JsonValue } from "../expression/evaluate.js";

export interface CanonicalStateError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface FinalizedOutputBinding {
  readonly stageId: string;
  readonly writes: readonly string[];
  readonly outputs: readonly {
    readonly reference: string;
    readonly kind: "value" | "artifact";
    readonly value?: unknown;
  }[];
  readonly validationValid: boolean;
}

const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** Reject empty, absolute, traversal, and prototype-polluting path segments. */
export function isSafeStatePath(segments: readonly string[]): boolean {
  if (segments.length === 0) {
    return false;
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      return false;
    }
    if (segment === "." || segment === "..") {
      return false;
    }
    if (UNSAFE_SEGMENTS.has(segment)) {
      return false;
    }
    if (segment.includes("\0")) {
      return false;
    }
  }
  return true;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }
  if (typeof value === "object") {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      return false;
    }
    return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry));
  }
  return false;
}

function cloneJson(value: JsonValue): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry));
  }
  const record = value as { readonly [key: string]: JsonValue };
  const out: Record<string, JsonValue> = Object.create(null);
  for (const key of Object.keys(record)) {
    Object.defineProperty(out, key, {
      value: cloneJson(record[key]!),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function materializePath(
  root: Record<string, JsonValue>,
  segments: readonly string[],
  value: JsonValue,
  errors: CanonicalStateError[],
): void {
  if (!isSafeStatePath(segments)) {
    errors.push({
      path: segments.join("."),
      code: "unsafe_path",
      message: `rejected unsafe state path ${segments.join(".")}`,
    });
    return;
  }

  let current: Record<string, JsonValue> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const existing = Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (existing === undefined) {
      const next: Record<string, JsonValue> = Object.create(null);
      Object.defineProperty(current, segment, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      current = next;
      continue;
    }
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      errors.push({
        path: segments.slice(0, index + 1).join("."),
        code: "path_conflict",
        message: `cannot nest under non-object at ${segments.slice(0, index + 1).join(".")}`,
      });
      return;
    }
    current = existing as Record<string, JsonValue>;
  }

  const leaf = segments[segments.length - 1]!;
  Object.defineProperty(current, leaf, {
    value: cloneJson(value),
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function asObjectState(value: unknown, errors: CanonicalStateError[]): Record<string, JsonValue> {
  const root: Record<string, JsonValue> = Object.create(null);
  if (value === undefined || value === null) {
    return root;
  }
  if (!isJsonValue(value) || typeof value !== "object" || Array.isArray(value)) {
    errors.push({
      path: "",
      code: "invalid_base_state",
      message: "baseState must be a JSON object",
    });
    return root;
  }
  for (const key of Object.keys(value)) {
    if (!isSafeStatePath([key])) {
      errors.push({
        path: key,
        code: "unsafe_path",
        message: `rejected unsafe base state key ${key}`,
      });
      continue;
    }
    Object.defineProperty(root, key, {
      value: cloneJson((value as { readonly [key: string]: JsonValue })[key]!),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return root;
}

/**
 * Merge base state with validated finalized outputs. Invalid or unsafe paths
 * are reported; only validationValid attempts contribute writes.
 */
export function buildCanonicalConditionState(input: {
  readonly baseState: unknown;
  readonly finalizedOutputs: readonly FinalizedOutputBinding[];
}): { readonly state: JsonValue; readonly errors: CanonicalStateError[] } {
  const errors: CanonicalStateError[] = [];
  const root = asObjectState(input.baseState, errors);

  for (const binding of input.finalizedOutputs) {
    if (!binding.validationValid) {
      continue;
    }
    const byReference = new Map(
      binding.outputs.map((output) => [output.reference, output] as const),
    );
    for (const write of binding.writes) {
      const segments = write.split(".");
      const output = byReference.get(write);
      if (output === undefined) {
        continue;
      }
      if (output.kind === "artifact") {
        // Artifact refs are path handles; conditions read value bindings only.
        continue;
      }
      if (output.value === undefined) {
        errors.push({
          path: write,
          code: "missing_value",
          message: `validated write ${write} has no value`,
        });
        continue;
      }
      if (!isJsonValue(output.value)) {
        errors.push({
          path: write,
          code: "non_json_value",
          message: `validated write ${write} is not JSON-representable`,
        });
        continue;
      }
      materializePath(root, segments, output.value, errors);
    }
  }

  return { state: root, errors };
}
