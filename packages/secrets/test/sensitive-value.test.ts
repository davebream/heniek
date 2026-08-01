import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { REDACTION_PLACEHOLDER } from "../src/redaction.js";
import { SensitiveValue } from "../src/sensitive-value.js";

describe("SensitiveValue", () => {
  it("rejects an empty value", () => {
    expect(() => SensitiveValue.from("")).toThrow(/non-empty/);
  });

  it("renders the exact shared REDACTION_PLACEHOLDER string", () => {
    expect(String(SensitiveValue.from("x"))).toBe(REDACTION_PLACEHOLDER);
  });

  it("exposes the original value only through expose()", () => {
    const value = SensitiveValue.from("super-secret-token");
    expect(value.expose()).toBe("super-secret-token");
  });

  it("renders the placeholder through toString()", () => {
    const value = SensitiveValue.from("super-secret-token");
    expect(value.toString()).toBe("[redacted]");
    expect(String(value)).toBe("[redacted]");
    expect(`${value}`).toBe("[redacted]");
  });

  it("renders the placeholder through JSON.stringify", () => {
    const value = SensitiveValue.from("super-secret-token");
    expect(JSON.stringify(value)).toBe('"[redacted]"');
    expect(JSON.stringify({ token: value })).toBe('{"token":"[redacted]"}');
  });

  it("renders the placeholder through util.inspect / console.log formatting", () => {
    const value = SensitiveValue.from("super-secret-token");
    expect(inspect(value)).toBe("[redacted]");
  });

  it("never contains the raw value in any of its default string representations", () => {
    const raw = "super-secret-token";
    const value = SensitiveValue.from(raw);
    expect(value.toString()).not.toContain(raw);
    expect(JSON.stringify(value)).not.toContain(raw);
    expect(inspect(value)).not.toContain(raw);
  });

  // These escape vectors currently earn their safety structurally (the
  // wrapped value lives behind a private `#value` field, so there is no
  // enumerable/reflectable property for any of these mechanisms to reach)
  // rather than through any code path written specifically to defeat them.
  // Asserted explicitly so a future refactor that, say, moved `#value` to a
  // regular field would fail loudly here instead of silently leaking.
  describe("escape vectors", () => {
    it("does not expose the raw value through util.inspect on a containing object", () => {
      const raw = "super-secret-token";
      const value = SensitiveValue.from(raw);
      expect(inspect({ token: value })).not.toContain(raw);
      expect(inspect({ token: value })).toContain(REDACTION_PLACEHOLDER);
    });

    it("does not expose the raw value as an enumerable own key via Object.keys", () => {
      const value = SensitiveValue.from("super-secret-token");
      expect(Object.keys(value)).toEqual([]);
    });

    it("does not expose the raw value through object-spread", () => {
      const raw = "super-secret-token";
      const value = SensitiveValue.from(raw);
      const spread = { ...value };
      expect(JSON.stringify(spread)).not.toContain(raw);
      expect(Object.keys(spread)).toEqual([]);
    });

    it("does not expose the raw value through structuredClone", () => {
      const raw = "super-secret-token";
      const value = SensitiveValue.from(raw);
      const cloned = structuredClone(value);
      expect(JSON.stringify(cloned)).not.toContain(raw);
    });
  });

  describe("equals", () => {
    it("returns true for two wrappers of the same value", () => {
      const a = SensitiveValue.from("identical-value");
      const b = SensitiveValue.from("identical-value");
      expect(a.equals(b)).toBe(true);
    });

    it("returns false for two wrappers of different values with the same length", () => {
      const a = SensitiveValue.from("aaaaaaaa");
      const b = SensitiveValue.from("bbbbbbbb");
      expect(a.equals(b)).toBe(false);
    });

    it("returns false for values of different lengths", () => {
      const a = SensitiveValue.from("short");
      const b = SensitiveValue.from("a-much-longer-value");
      expect(a.equals(b)).toBe(false);
    });

    it("compares UTF-8 bytes, not UTF-16 code units", () => {
      const a = SensitiveValue.from("café");
      const b = SensitiveValue.from("café");
      expect(a.equals(b)).toBe(true);
    });
  });
});
