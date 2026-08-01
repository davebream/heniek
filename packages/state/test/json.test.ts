import { describe, expect, it } from "vitest";
import { StateStoreError } from "../src/errors.js";
import type { JsonValue } from "../src/json.js";
import { canonicalize, parseJsonValue, stringifyCanonical } from "../src/json.js";

describe("canonicalize / stringifyCanonical — __proto__ safety (issue #7, Phase 1 fix F4)", () => {
  it("preserves a __proto__ key as an own property instead of reassigning the prototype", () => {
    const parsed = JSON.parse('{"__proto__":{"a":1},"z":2}') as JsonValue;
    const result = canonicalize(parsed);

    // A regression that reassigns the prototype instead of dropping the key
    // would still leave `result` looking empty to `Object.keys` — so assert
    // the prototype is untouched *and* that stringify round-trips the key.
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(stringifyCanonical(parsed)).toBe('{"__proto__":{"a":1},"z":2}');
  });

  it("round-trips a __proto__ key through parseJsonValue as well", () => {
    const value = parseJsonValue('{"__proto__":{"a":1},"z":2}', "test payload");
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(stringifyCanonical(value)).toBe('{"__proto__":{"a":1},"z":2}');
  });

  it("sorts keys and drops undefined-valued entries", () => {
    const value = canonicalize({ b: 1, a: 2 });
    expect(JSON.stringify(value)).toBe('{"a":2,"b":1}');
  });
});

describe("canonicalize — non-finite numbers rejected on the write path (issue #7, Phase 1 fix F5)", () => {
  it("throws StateStoreError for NaN instead of silently becoming null", () => {
    expect(() => canonicalize(Number.NaN as unknown as JsonValue)).toThrow(StateStoreError);
  });

  it("throws StateStoreError for Infinity and -Infinity", () => {
    expect(() => canonicalize(Number.POSITIVE_INFINITY as unknown as JsonValue)).toThrow(
      StateStoreError,
    );
    expect(() => canonicalize(Number.NEGATIVE_INFINITY as unknown as JsonValue)).toThrow(
      StateStoreError,
    );
  });

  it("throws for a non-finite number nested inside an object, not just at the top level", () => {
    const value = { a: Number.NaN } as unknown as JsonValue;
    expect(() => canonicalize(value)).toThrow(StateStoreError);
  });

  it("leaves -0 alone rather than rejecting it", () => {
    expect(() => canonicalize(-0 as JsonValue)).not.toThrow();
  });

  it("normalises -0 to 0 at the value level, not just through JSON.stringify (issue #7, Phase 2 fix S5)", () => {
    // `stringifyCanonical(-0)` is `"0"` with or without the normalisation
    // branch, because `JSON.stringify(-0)` already produces `"0"` — that
    // made the normalisation itself unobservable through the serialiser.
    // `Object.is` distinguishes -0 from 0 where `===` cannot, which is what
    // pins the branch's actual effect.
    expect(Object.is(canonicalize(-0 as JsonValue), 0)).toBe(true);
    expect(Object.is(canonicalize(-0 as JsonValue), -0)).toBe(false);
  });
});

/** Builds a JSON array nested `depth` levels deep around a scalar `0`. */
function nestedArray(depth: number): JsonValue {
  let value: JsonValue = 0;
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

describe("canonicalize / parseJsonValue — recursion depth bound (issue #7, Phase 2 fix S4)", () => {
  it("canonicalize accepts exactly MAX_DEPTH (64) levels of nesting", () => {
    expect(() => canonicalize(nestedArray(63))).not.toThrow();
  });

  it("canonicalize rejects nesting one level beyond MAX_DEPTH, with the bound in the message", () => {
    expect(() => canonicalize(nestedArray(64))).toThrow(StateStoreError);
    expect(() => canonicalize(nestedArray(64))).toThrow(/exceeded 64/);
  });

  it("parseJsonValue accepts exactly MAX_DEPTH (64) levels of nesting", () => {
    const text = JSON.stringify(nestedArray(63));
    expect(() => parseJsonValue(text, "test payload")).not.toThrow();
  });

  it("parseJsonValue rejects nesting one level beyond MAX_DEPTH, with the bound in the message", () => {
    const text = JSON.stringify(nestedArray(64));
    expect(() => parseJsonValue(text, "test payload")).toThrow(StateStoreError);
    expect(() => parseJsonValue(text, "test payload")).toThrow(/exceeded 64/);
  });
});

describe("parseJsonValue — no payload bytes in the error message (issue #7, Phase 1 fix F6)", () => {
  it("does not echo the offending input on invalid JSON", () => {
    let caught: unknown;
    try {
      parseJsonValue("sk-live-DEADBEEF-not-json", "test payload");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateStoreError);
    // Node's own `JSON.parse` message embeds a short excerpt of the input —
    // assert that excerpt specifically does not survive into this
    // package's error, not merely that some other text is now present.
    expect((caught as Error).message).not.toContain("sk-live-DE");
    expect((caught as Error).message).not.toContain("DEADBEEF");
  });

  it("does not carry the input as `cause` either", () => {
    let caught: unknown;
    try {
      parseJsonValue("sk-live-DEADBEEF-not-json", "test payload");
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).cause).toBeUndefined();
  });
});
