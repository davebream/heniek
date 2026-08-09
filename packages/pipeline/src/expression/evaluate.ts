/**
 * Evaluates a compiled §14.4 expression against canonical JSON state.
 *
 * No executable code, no `eval`, no function calls: every node is data, and
 * every missing or incompatible path becomes a typed failure the scheduler
 * turns into `blocked` rather than a throw the caller has to classify.
 */

import type { ExpressionCondition, ExpressionNode } from "../document.js";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export type ExpressionEvaluation =
  | { readonly ok: true; readonly value: boolean }
  | {
      readonly ok: false;
      readonly code: "missing_path" | "incompatible_type" | "invalid_expression";
      readonly message: string;
      readonly path?: readonly string[];
    };

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPath(
  state: JsonValue,
  path: readonly string[],
):
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly path: readonly string[] } {
  let current: JsonValue = state;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;
    if (Array.isArray(current)) {
      if (segment === "length") {
        current = current.length;
        continue;
      }
      return { ok: false, path: path.slice(0, index + 1) };
    }
    if (!isObject(current) || !Object.hasOwn(current, segment)) {
      return { ok: false, path: path.slice(0, index + 1) };
    }
    current = current[segment]!;
  }
  return { ok: true, value: current };
}

function asComparable(
  value: JsonValue,
): { readonly ok: true; readonly value: JsonScalar } | { readonly ok: false } {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { ok: true, value };
  }
  return { ok: false };
}

function compareValues(
  operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte",
  left: JsonScalar,
  right: JsonScalar,
):
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly message: string } {
  if (operator === "eq") {
    return { ok: true, value: Object.is(left, right) };
  }
  if (operator === "ne") {
    return { ok: true, value: !Object.is(left, right) };
  }
  if (
    typeof left !== "number" ||
    typeof right !== "number" ||
    !Number.isFinite(left) ||
    !Number.isFinite(right)
  ) {
    return {
      ok: false,
      message: `ordered comparison requires finite numbers, got ${typeof left} and ${typeof right}`,
    };
  }
  switch (operator) {
    case "lt":
      return { ok: true, value: left < right };
    case "lte":
      return { ok: true, value: left <= right };
    case "gt":
      return { ok: true, value: left > right };
    case "gte":
      return { ok: true, value: left >= right };
  }
}

function evaluateNode(
  nodes: readonly ExpressionNode[],
  index: number,
  state: JsonValue,
): ExpressionEvaluation | { readonly ok: true; readonly value: JsonValue } {
  if (index < 0 || index >= nodes.length) {
    return {
      ok: false,
      code: "invalid_expression",
      message: `expression node index ${index} is out of range`,
    };
  }
  const node = nodes[index]!;
  switch (node.kind) {
    case "literal":
      return { ok: true, value: node.value };
    case "path": {
      const read = readPath(state, node.path);
      if (!read.ok) {
        return {
          ok: false,
          code: "missing_path",
          message: `missing state path ${read.path.join(".")}`,
          path: read.path,
        };
      }
      return { ok: true, value: read.value };
    }
    case "not": {
      const operand = evaluateNode(nodes, node.operand, state);
      if (!operand.ok) {
        return operand;
      }
      if (typeof operand.value !== "boolean") {
        return {
          ok: false,
          code: "incompatible_type",
          message: `unary ! requires a boolean, got ${describeType(operand.value)}`,
        };
      }
      return { ok: true, value: !operand.value };
    }
    case "compare": {
      const left = evaluateNode(nodes, node.left, state);
      if (!left.ok) {
        return left;
      }
      const right = evaluateNode(nodes, node.right, state);
      if (!right.ok) {
        return right;
      }
      const leftScalar = asComparable(left.value);
      const rightScalar = asComparable(right.value);
      if (!leftScalar.ok || !rightScalar.ok) {
        return {
          ok: false,
          code: "incompatible_type",
          message: `comparison requires JSON scalars, got ${describeType(left.value)} and ${describeType(right.value)}`,
        };
      }
      const compared = compareValues(node.operator, leftScalar.value, rightScalar.value);
      if (!compared.ok) {
        return { ok: false, code: "incompatible_type", message: compared.message };
      }
      return { ok: true, value: compared.value };
    }
    case "logical": {
      const left = evaluateNode(nodes, node.left, state);
      if (!left.ok) {
        return left;
      }
      if (typeof left.value !== "boolean") {
        return {
          ok: false,
          code: "incompatible_type",
          message: `logical ${node.operator} requires booleans, got ${describeType(left.value)} on the left`,
        };
      }
      if (node.operator === "and" && left.value === false) {
        return { ok: true, value: false };
      }
      if (node.operator === "or" && left.value === true) {
        return { ok: true, value: true };
      }
      const right = evaluateNode(nodes, node.right, state);
      if (!right.ok) {
        return right;
      }
      if (typeof right.value !== "boolean") {
        return {
          ok: false,
          code: "incompatible_type",
          message: `logical ${node.operator} requires booleans, got ${describeType(right.value)} on the right`,
        };
      }
      return {
        ok: true,
        value: node.operator === "and" ? left.value && right.value : left.value || right.value,
      };
    }
  }
}

function describeType(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/**
 * Evaluates a compiled expression condition to a boolean against canonical
 * JSON state. The root node must reduce to a boolean; every other failure
 * mode is typed.
 */
export function evaluateExpressionCondition(
  condition: ExpressionCondition,
  state: JsonValue,
): ExpressionEvaluation {
  const result = evaluateNode(condition.nodes, condition.root, state);
  if (!result.ok) {
    return result;
  }
  if (typeof result.value !== "boolean") {
    return {
      ok: false,
      code: "incompatible_type",
      message: `expression root must be boolean, got ${describeType(result.value)}`,
    };
  }
  return { ok: true, value: result.value };
}
