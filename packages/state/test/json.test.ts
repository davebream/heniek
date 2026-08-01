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
