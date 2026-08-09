/**
 * The condition grammar (§14.4), unit by unit.
 *
 * Two classes of assertion carry the weight: what the grammar *accepts* and
 * compiles to, and what it *refuses*. The second is the more important of the
 * two — §8.1's "no executable values" is a promise about what the language
 * cannot express, and a promise like that is only kept by the cases that fail.
 */

import { describe, expect, it } from "vitest";
import { lexExpression, MAX_EXPRESSION_LENGTH } from "../src/expression/lex.js";
import {
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_NODES,
  MAX_PATH_SEGMENTS,
  parseConditionExpression,
  renderExpressionExcerpt,
} from "../src/expression/parse.js";

function parseOrThrow(source: string) {
  const result = parseConditionExpression(source);
  if (!result.ok) {
    throw new Error(`${source} → ${result.error.message}`);
  }
  return result;
}

describe("accepted conditions", () => {
  it("compiles the specification's own example", () => {
    const { nodes, root } = parseOrThrow("verify.blockingFindings.length > 0");
    expect(nodes).toEqual([
      { kind: "path", path: ["verify", "blockingFindings", "length"] },
      { kind: "literal", value: 0 },
      { kind: "compare", operator: "gt", left: 0, right: 1 },
    ]);
    expect(root).toBe(2);
  });

  it("emits children before parents, so the root is the last node", () => {
    const { nodes, root } = parseOrThrow("a > 1 && b < 2 || !c");
    expect(root).toBe(nodes.length - 1);
    for (const [index, node] of nodes.entries()) {
      if (node.kind === "compare" || node.kind === "logical") {
        expect(node.left).toBeLessThan(index);
        expect(node.right).toBeLessThan(index);
      }
      if (node.kind === "not") {
        expect(node.operand).toBeLessThan(index);
      }
    }
  });

  it("binds && more tightly than ||", () => {
    const loose = parseOrThrow("a || b && c");
    const explicit = parseOrThrow("a || (b && c)");
    expect(loose.nodes).toEqual(explicit.nodes);
    expect(loose.root).toBe(explicit.root);
  });

  it("ignores whitespace entirely", () => {
    const spaced = parseOrThrow("a.b   >=   3   &&   ! c");
    const tight = parseOrThrow("a.b>=3&&!c");
    expect(spaced.nodes).toEqual(tight.nodes);
  });

  it("reads every scalar literal the core JSON types have", () => {
    expect(parseOrThrow("a == true").nodes).toContainEqual({ kind: "literal", value: true });
    expect(parseOrThrow("a == false").nodes).toContainEqual({ kind: "literal", value: false });
    expect(parseOrThrow("a == null").nodes).toContainEqual({ kind: "literal", value: null });
    expect(parseOrThrow("a == -12").nodes).toContainEqual({ kind: "literal", value: -12 });
    expect(parseOrThrow("a == 1.5").nodes).toContainEqual({ kind: "literal", value: 1.5 });
    expect(parseOrThrow('a == "x"').nodes).toContainEqual({ kind: "literal", value: "x" });
    expect(parseOrThrow("a == 'x'").nodes).toContainEqual({ kind: "literal", value: "x" });
  });

  it("treats both quote styles as the same value", () => {
    expect(parseOrThrow(`a == "x"`).nodes).toEqual(parseOrThrow(`a == 'x'`).nodes);
  });

  it("reads a keyword as a path segment when it is followed by a dot", () => {
    expect(parseOrThrow("null.count > 0").nodes[0]).toEqual({
      kind: "path",
      path: ["null", "count"],
    });
    expect(parseOrThrow("a.true > 0").nodes[0]).toEqual({ kind: "path", path: ["a", "true"] });
  });

  it("decodes the two supported string escapes", () => {
    expect(parseOrThrow(`a == "he said \\"hi\\""`).nodes).toContainEqual({
      kind: "literal",
      value: 'he said "hi"',
    });
    expect(parseOrThrow(`a == "back\\\\slash"`).nodes).toContainEqual({
      kind: "literal",
      value: "back\\slash",
    });
  });
});

describe("refused conditions", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["", "incomplete"],
    ["a >", "incomplete"],
    ["> 1", "Unexpected"],
    ["a > 1 > 2", "chained"],
    ["(a > 1", 'Missing ")"'],
    ["a > 1)", 'Unmatched ")"'],
    ["a = 1", 'use "=="'],
    ["a & b", 'use "&&" and "||"'],
    ["a | b", 'use "&&" and "||"'],
    ["a + 1", "do not compute"],
    ["a - 1", "do not compute"],
    ["a * 2 > 1", "do not compute"],
    ["a / 2 > 1", "do not compute"],
    ["a % 2 > 1", "do not compute"],
    ["count(a) > 1", "Unexpected"],
    ["a[0] > 1", "Unexpected character"],
    ["a.1 > 1", "segment must be a name"],
    ["a. > 1", "segment must be a name"],
    ["a.", "segment must be a name"],
    ['a == "unterminated', "Unterminated"],
    ['a == "bad\\nescape"', "Unsupported escape"],
    ["a == 1.", "digit after the decimal point"],
    ["a == 1.x", "digit after the decimal point"],
    ["a > 1 b", "Unexpected"],
    ["a ~ b", "Unexpected character"],
  ];

  for (const [source, fragment] of cases) {
    it(`refuses ${JSON.stringify(source)}`, () => {
      const result = parseConditionExpression(source);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain(fragment);
        expect(result.error.offset).toBeGreaterThanOrEqual(0);
        expect(result.error.offset).toBeLessThanOrEqual(source.length);
      }
    });
  }

  /**
   * The refusals that matter most: none of these is a typo, each is someone
   * reaching for a capability the language deliberately does not have.
   */
  it("has no way to call, index, assign, interpolate, or compute", () => {
    // The interpolation case is assembled rather than written literally: a
    // bare `${a}` in a plain string is what the lint rule flags as a missed
    // template literal, and here it is exactly the point — the grammar must
    // refuse the shape someone would reach for to smuggle in evaluation.
    const interpolation = `$${"{a}"}`;
    for (const source of ["a()", "a[b]", "a = b", "a ** 2", "a ? b : c", "a; b", interpolation]) {
      expect(parseConditionExpression(source).ok, source).toBe(false);
    }
  });
});

describe("bounds", () => {
  it("refuses an over-long source before scanning it", () => {
    const result = lexExpression("a".repeat(MAX_EXPRESSION_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maximum supported length");
    }
  });

  it("refuses too many path segments", () => {
    const source = Array.from({ length: MAX_PATH_SEGMENTS + 1 }, (_, index) => `s${index}`).join(
      ".",
    );
    const result = parseConditionExpression(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("at most");
    }
  });

  it("refuses parentheses nested past the depth ceiling", () => {
    const source = `${"(".repeat(MAX_EXPRESSION_DEPTH + 2)}a${")".repeat(MAX_EXPRESSION_DEPTH + 2)}`;
    const result = parseConditionExpression(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("nesting");
    }
  });

  it("refuses more nodes than the ceiling allows", () => {
    const source = Array.from({ length: MAX_EXPRESSION_NODES }, (_, index) => `a${index}`).join(
      " && ",
    );
    const result = parseConditionExpression(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maximum supported size");
    }
  });

  /**
   * `!!!!…` recurses through `parseUnary`, which the parenthesis depth guard
   * does not cover. The node ceiling is what stops it, and this pins that it
   * stops it with a diagnostic rather than a stack overflow.
   */
  it("survives a long unary chain", () => {
    const result = parseConditionExpression(`${"!".repeat(500)}a`);
    expect(result.ok).toBe(false);
  });
});

describe("excerpt rendering", () => {
  it("puts the caret under the offending character", () => {
    expect(renderExpressionExcerpt("a > ", 4)).toBe("a > \n    ^");
  });

  it("clamps an offset past the end and flattens newlines", () => {
    expect(renderExpressionExcerpt("a\nb", 99)).toBe("a b\n   ^");
  });
});
