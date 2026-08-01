import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SensitiveValue } from "../src/sensitive-value.js";

describe("SensitiveValue", () => {
  it("rejects an empty value", () => {
    expect(() => SensitiveValue.from("")).toThrow(/non-empty/);
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
