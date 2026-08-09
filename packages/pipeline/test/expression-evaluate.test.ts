/**
 * Expression evaluation against canonical JSON state.
 */

import { describe, expect, it } from "vitest";
import { evaluateExpressionCondition } from "../src/expression/evaluate.js";
import { parseConditionExpression } from "../src/expression/parse.js";

function evaluate(source: string, state: unknown) {
  const parsed = parseConditionExpression(source);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return evaluateExpressionCondition(
    { kind: "expression", nodes: [...parsed.nodes], root: parsed.root },
    state as never,
  );
}

describe("evaluateExpressionCondition", () => {
  it("evaluates the specification example", () => {
    expect(
      evaluate("verify.blockingFindings.length > 0", {
        verify: { blockingFindings: [1, 2] },
      }),
    ).toEqual({ ok: true, value: true });
    expect(
      evaluate("verify.blockingFindings.length > 0", {
        verify: { blockingFindings: [] },
      }),
    ).toEqual({ ok: true, value: false });
  });

  it("short-circuits logical operators after a successful left boolean", () => {
    expect(evaluate("false && missing.path == true", {})).toEqual({ ok: true, value: false });
    expect(evaluate("true || missing.path == true", {})).toEqual({ ok: true, value: true });
  });

  it("propagates missing_path from the left of a logical operator", () => {
    const result = evaluate("missing.path == true || true", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_path");
    }
  });

  it("returns typed missing_path when a reference is absent", () => {
    const result = evaluate("verify.blockingFindings.length > 0", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_path");
    }
  });

  it("returns typed incompatible_type for ordered comparison of strings", () => {
    const result = evaluate('a > "x"', { a: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("incompatible_type");
    }
  });
});
