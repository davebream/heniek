import { describe, expect, it } from "vitest";
import {
  canonicalJsonStringify,
  deepFreeze,
  escapePointerSegment,
  type JsonObject,
  type JsonValue,
  joinPointer,
} from "../src/json.js";

describe("deepFreeze", () => {
  it("freezes every nested object and array, not just the root", () => {
    const value = deepFreeze({ a: { b: [{ c: 1 }] } });

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[0])).toBe(true);
  });

  /**
   * The regression that motivated replacing an `Object.isFrozen` cycle guard
   * with a `WeakSet`: a caller-supplied value whose *root* was already frozen
   * for an unrelated reason used to short-circuit the whole walk, leaving
   * every child mutable while `deepFreeze` reported success. §8.2's "frozen
   * as immutable JSON" would then have been silently shallow.
   */
  it("still freezes children when the root was shallow-frozen beforehand", () => {
    const inner = { c: 1 };
    const value = Object.freeze({ a: Object.freeze({ b: inner }) });

    deepFreeze(value);

    expect(Object.isFrozen(inner)).toBe(true);
  });

  it("terminates on a cyclic structure", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;

    expect(() => deepFreeze(node)).not.toThrow();
    expect(Object.isFrozen(node)).toBe(true);
  });

  it("returns primitives and null unchanged", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze("value")).toBe("value");
  });
});

describe("canonicalJsonStringify", () => {
  it("sorts object keys at every nesting level", () => {
    const value: JsonValue = { b: { d: 1, c: 2 }, a: 3 };

    expect(canonicalJsonStringify(value)).toBe(
      ["{", '  "a": 3,', '  "b": {', '    "c": 2,', '    "d": 1', "  }", "}", ""].join("\n"),
    );
  });

  it("is byte-identical for two objects built in different key orders", () => {
    const first: JsonObject = { alpha: 1, beta: { x: [1, 2], y: "z" } };
    const second: JsonObject = { beta: { y: "z", x: [1, 2] }, alpha: 1 };

    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
  });

  it("preserves array order — arrays are sequences, not sets", () => {
    expect(canonicalJsonStringify(["b", "a"])).not.toBe(canonicalJsonStringify(["a", "b"]));
  });

  it("renders empty containers inline", () => {
    expect(canonicalJsonStringify({ a: {}, b: [] })).toBe(
      ["{", '  "a": {},', '  "b": []', "}", ""].join("\n"),
    );
  });

  it("renders null, and treats -0 as 0 exactly as JSON does", () => {
    expect(canonicalJsonStringify(null)).toBe("null\n");
    expect(canonicalJsonStringify({ zero: -0 })).toBe(["{", '  "zero": 0', "}", ""].join("\n"));
  });

  it("renders 1e21 in exponent form, matching JSON.stringify", () => {
    expect(canonicalJsonStringify({ big: 1e21 })).toBe(["{", '  "big": 1e+21', "}", ""].join("\n"));
  });

  /**
   * H5: `JsonValue` types `number` without excluding `Infinity`/`NaN`, which
   * JSON cannot represent — `JSON.stringify` silently coerces either to the
   * literal `null`, indistinguishable from an actual `null` value once
   * serialised. A non-finite number reaching a resolved-configuration
   * snapshot is a caller defect and must fail loudly here (the declared
   * substrate for that snapshot), not be silently rendered as a lie.
   */
  it("throws a clear error instead of silently coercing a non-finite number to null (H5)", () => {
    expect(() => canonicalJsonStringify({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify({ n: Number.NEGATIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify([Number.NaN])).toThrow(/non-finite/);
  });

  /**
   * H5: `undefined` is reachable here at runtime despite `JsonValue`
   * excluding it (nothing prevents a caller from building a `JsonObject`
   * with a stray `undefined` property at runtime despite the type).
   * `JSON.stringify(undefined)` returns the *JS value* `undefined`, not a
   * string — the surrounding template literal used to coerce that to the
   * literal text `"undefined"`, embedding invalid JSON in otherwise-valid
   * output. Rejected outright instead.
   */
  it("throws a clear error instead of emitting the literal text 'undefined' (H5)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing JsonValue to exercise the runtime guard.
    expect(() => canonicalJsonStringify({ a: undefined } as any)).toThrow(/undefined/);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing JsonValue to exercise the runtime guard.
    expect(() => canonicalJsonStringify([undefined] as any)).toThrow(/undefined/);
  });

  /**
   * H5: the recursive walk carries the same cycle guard `deepFreeze` has —
   * a cyclic structure is impossible for `JsonValue` proper, but this is
   * also called on hand-built object literals that could in principle be
   * cyclic, and must fail with a clear error rather than a stack overflow.
   */
  it("throws a clear error instead of overflowing the stack on a cyclic structure (H5)", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;

    // biome-ignore lint/suspicious/noExplicitAny: deliberately cyclic, incompatible with JsonValue by construction.
    expect(() => canonicalJsonStringify(node as any)).toThrow(/cyclic/);
  });

  it("does not flag a non-cyclic diamond reference (two siblings pointing at the same object) as circular (H5)", () => {
    const shared: JsonValue = { x: 1 };
    expect(() => canonicalJsonStringify({ a: shared, b: shared })).not.toThrow();
    expect(canonicalJsonStringify({ a: shared, b: shared })).toBe(
      ["{", '  "a": {', '    "x": 1', "  },", '  "b": {', '    "x": 1', "  }", "}", ""].join("\n"),
    );
  });

  it("escapes keys that contain quotes or control characters", () => {
    expect(canonicalJsonStringify({ 'a"b': 1 })).toBe(["{", '  "a\\"b": 1', "}", ""].join("\n"));
  });

  it("ends with exactly one trailing newline", () => {
    const rendered = canonicalJsonStringify({ a: 1 });

    expect(rendered.endsWith("}\n")).toBe(true);
    expect(rendered.endsWith("}\n\n")).toBe(false);
  });
});

describe("escapePointerSegment", () => {
  /**
   * RFC 6901 §3 fixes the order: `~` is encoded first, then `/`. Encoding
   * `/` first would produce a `~1` whose `~` the second pass would then
   * re-encode into `~01`, silently corrupting the pointer.
   */
  it("escapes ~ before /", () => {
    expect(escapePointerSegment("a~b")).toBe("a~0b");
    expect(escapePointerSegment("a/b")).toBe("a~1b");
    expect(escapePointerSegment("a~/b")).toBe("a~0~1b");
    expect(escapePointerSegment("~1")).toBe("~01");
  });

  it("leaves a segment with no reserved character untouched", () => {
    expect(escapePointerSegment("max_pipeline_duration")).toBe("max_pipeline_duration");
  });

  it("escapes an empty segment to an empty segment", () => {
    expect(escapePointerSegment("")).toBe("");
  });
});

describe("joinPointer", () => {
  it("builds a pointer from the document root", () => {
    expect(joinPointer("", "limits")).toBe("/limits");
    expect(joinPointer("/limits", "max_concurrent_workers")).toBe("/limits/max_concurrent_workers");
  });

  it("accepts a numeric array index", () => {
    expect(joinPointer("/items", 0)).toBe("/items/0");
  });

  it("escapes the appended segment", () => {
    expect(joinPointer("", "a/b")).toBe("/a~1b");
    expect(joinPointer("/x", "a~b")).toBe("/x/a~0b");
  });

  it("produces the RFC 6901 empty-key pointer for an empty segment", () => {
    expect(joinPointer("", "")).toBe("/");
  });
});
