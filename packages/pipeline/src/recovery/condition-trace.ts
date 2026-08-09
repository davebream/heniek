/**
 * Condition evaluation with an audit trace of referenced path values.
 */

import type { ExpressionCondition, ExpressionNode } from "../document.js";
import {
  type ExpressionEvaluation,
  evaluateExpressionCondition,
  type JsonValue,
} from "../expression/evaluate.js";

export interface ConditionTrace {
  readonly expressionSummary: string;
  readonly referencedValues: ReadonlyArray<{
    readonly path: readonly string[];
    readonly value: JsonValue | undefined;
    readonly present: boolean;
  }>;
  readonly result: ExpressionEvaluation;
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPath(
  state: JsonValue,
  path: readonly string[],
): { readonly present: boolean; readonly value: JsonValue | undefined } {
  let current: JsonValue = state;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;
    if (Array.isArray(current)) {
      if (segment === "length") {
        current = current.length;
        continue;
      }
      return { present: false, value: undefined };
    }
    if (!isObject(current) || !Object.hasOwn(current, segment)) {
      return { present: false, value: undefined };
    }
    current = current[segment]!;
  }
  return { present: true, value: current };
}

function summarizeNode(nodes: readonly ExpressionNode[], index: number): string {
  if (index < 0 || index >= nodes.length) {
    return "<invalid>";
  }
  const node = nodes[index]!;
  switch (node.kind) {
    case "literal":
      return JSON.stringify(node.value);
    case "path":
      return node.path.join(".");
    case "not":
      return `!(${summarizeNode(nodes, node.operand)})`;
    case "compare":
      return `(${summarizeNode(nodes, node.left)} ${node.operator} ${summarizeNode(nodes, node.right)})`;
    case "logical":
      return `(${summarizeNode(nodes, node.left)} ${node.operator} ${summarizeNode(nodes, node.right)})`;
  }
}

function collectPaths(
  nodes: readonly ExpressionNode[],
  index: number,
  paths: { path: readonly string[] }[],
): void {
  if (index < 0 || index >= nodes.length) {
    return;
  }
  const node = nodes[index]!;
  switch (node.kind) {
    case "literal":
      return;
    case "path":
      paths.push({ path: node.path });
      return;
    case "not":
      collectPaths(nodes, node.operand, paths);
      return;
    case "compare":
      collectPaths(nodes, node.left, paths);
      collectPaths(nodes, node.right, paths);
      return;
    case "logical":
      collectPaths(nodes, node.left, paths);
      collectPaths(nodes, node.right, paths);
      return;
  }
}

/**
 * Evaluate an expression condition and return referenced path values for audit.
 * Does not change `evaluateExpressionCondition` behaviour.
 */
export function evaluateConditionWithTrace(
  condition: ExpressionCondition,
  state: JsonValue,
): { readonly evaluation: ExpressionEvaluation; readonly trace: ConditionTrace } {
  const evaluation = evaluateExpressionCondition(condition, state);
  const pathRefs: { path: readonly string[] }[] = [];
  collectPaths(condition.nodes, condition.root, pathRefs);
  const referencedValues = pathRefs.map((entry) => {
    const read = readPath(state, entry.path);
    return {
      path: entry.path,
      value: read.value,
      present: read.present,
    };
  });
  return {
    evaluation,
    trace: {
      expressionSummary: summarizeNode(condition.nodes, condition.root),
      referencedValues,
      result: evaluation,
    },
  };
}
