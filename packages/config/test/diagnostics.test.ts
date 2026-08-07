import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/diagnostics.js";
import { compareDiagnostics, createDiagnostic, sortDiagnostics } from "../src/diagnostics.js";

describe("compareDiagnostics (D1)", () => {
  it("orders by severity first: error, then warning, then info", () => {
    const info = createDiagnostic("z.info", "info", "z");
    const warning = createDiagnostic("a.warning", "warning", "a");
    const error = createDiagnostic("m.error", "error", "m");

    expect(sortDiagnostics([info, warning, error])).toEqual([error, warning, info]);
  });

  it("uses codepoint order for code, not locale order", () => {
    // Under `localeCompare` in many locales "Z" < "a" is false (locale
    // collation treats letters case-insensitively-ish and sorts "a" before
    // "Z"), but strict codepoint order puts every uppercase letter before
    // every lowercase one ("Z" = 0x5A < "a" = 0x61).
    const upper = createDiagnostic("Z.code", "error", "upper");
    const lower = createDiagnostic("a.code", "error", "lower");

    expect(sortDiagnostics([lower, upper])).toEqual([upper, lower]);
  });

  it("falls back to line, then column, then message when code and pointer tie", () => {
    const a = createDiagnostic("yaml.non-json-value", "error", "b-message", { line: 2, column: 1 });
    const b = createDiagnostic("yaml.non-json-value", "error", "a-message", { line: 1, column: 5 });
    const c = createDiagnostic("yaml.non-json-value", "error", "z-message", { line: 1, column: 1 });

    // Shuffled input must always sort to the same documented order:
    // line 1/col 1 (c), then line 1/col 5 (b), then line 2/col 1 (a).
    expect(sortDiagnostics([a, b, c])).toEqual([c, b, a]);
    expect(sortDiagnostics([c, a, b])).toEqual([c, b, a]);
    expect(sortDiagnostics([b, c, a])).toEqual([c, b, a]);
  });

  it("falls back to message when code, pointer, line, and column all tie", () => {
    const a = createDiagnostic("yaml.non-json-value", "error", "beta");
    const b = createDiagnostic("yaml.non-json-value", "error", "alpha");

    expect(sortDiagnostics([a, b])).toEqual([b, a]);
  });

  it("a shuffled input array sorts to a stable, documented order regardless of starting order", () => {
    const diagnostics: Diagnostic[] = [
      createDiagnostic("yaml.syntax-error", "error", "m", { line: 3, column: 1 }),
      createDiagnostic("yaml.ambiguous-scalar", "warning", "w", { line: 1, column: 1 }),
      createDiagnostic("home.xdg-ignored-under-override", "info", "i"),
      createDiagnostic("yaml.duplicate-key", "error", "d", { line: 1, column: 1 }),
    ];
    const expected = [diagnostics[3], diagnostics[0], diagnostics[1], diagnostics[2]];

    // Every rotation of the input array sorts to the exact same output.
    for (let rotation = 0; rotation < diagnostics.length; rotation++) {
      const rotated = [...diagnostics.slice(rotation), ...diagnostics.slice(0, rotation)];
      expect(sortDiagnostics(rotated)).toEqual(expected);
    }
  });

  it("returns 0 for two diagnostics that are identical in every tiebreak field", () => {
    const a = createDiagnostic("code", "error", "message", { line: 1, column: 1, pointer: "/x" });
    const b = createDiagnostic("code", "error", "message", { line: 1, column: 1, pointer: "/x" });
    expect(compareDiagnostics(a, b)).toBe(0);
  });
});
