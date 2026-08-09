/**
 * Compiles §14.4's deterministic conditions into the flat, index-addressed
 * node array `PipelineGraph/v1` carries.
 *
 * Grammar, lowest precedence first:
 *
 * ```text
 * expression := or
 * or         := and ( "||" and )*
 * and        := comparison ( "&&" comparison )*
 * comparison := unary [ ("=="|"!="|"<"|"<="|">"|">=") unary ]     // non-associative
 * unary      := "!" unary | primary
 * primary    := path | number | string | "true" | "false" | "null" | "(" expression ")"
 * path       := ident ( "." ident )*
 * ```
 *
 * Comparison is deliberately non-associative: `a < b < c` reads as a range in
 * every language a person is likely to be thinking of and means something
 * else in all of them, so it is a syntax error here rather than a silent
 * `(a < b) < c`.
 *
 * Children are always emitted before their parent, so `root` is the last
 * index and a consumer may evaluate the array front-to-back with no
 * recursion at all.
 */

import type { ExpressionNode } from "../document.js";
import type { Token } from "./lex.js";
import { lexExpression } from "./lex.js";

export interface ExpressionError {
  readonly message: string;
  /** Character offset into the expression source, for the caret excerpt. */
  readonly offset: number;
}

export type ExpressionParseResult =
  | { readonly ok: true; readonly nodes: readonly ExpressionNode[]; readonly root: number }
  | { readonly ok: false; readonly error: ExpressionError };

/**
 * Ceilings on the compiled shape rather than on the source text alone. Both
 * are far above any condition a person writes — §14.4's example compiles to
 * three nodes — and exist so a pathological input fails with a diagnostic
 * instead of producing a graph nobody can read or a recursion nobody bounded.
 */
export const MAX_EXPRESSION_NODES = 128;
export const MAX_PATH_SEGMENTS = 8;
export const MAX_EXPRESSION_DEPTH = 16;

const COMPARISON_OPERATOR_NAMES: Readonly<
  Record<string, "eq" | "ne" | "lt" | "lte" | "gt" | "gte">
> = {
  "==": "eq",
  "!=": "ne",
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
};

/** Token kinds that may serve as a path segment — keywords included, since `verify.null` is a legal reference. */
const SEGMENT_KINDS = new Set(["identifier", "true", "false", "null"]);

class ExpressionSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

export function parseConditionExpression(source: string): ExpressionParseResult {
  const lexed = lexExpression(source);
  if (!lexed.ok) {
    return { ok: false, error: lexed.error };
  }

  const parser = new ExpressionParser(lexed.tokens);
  try {
    const root = parser.parseExpression(0);
    parser.expectEnd();
    return { ok: true, nodes: parser.nodes, root };
  } catch (error) {
    if (error instanceof ExpressionSyntaxError) {
      return { ok: false, error: { message: error.message, offset: error.offset } };
    }
    /* c8 ignore next 2 -- no other throw reaches here; rethrown so a genuine bug is not swallowed */
    throw error;
  }
}

class ExpressionParser {
  readonly nodes: ExpressionNode[] = [];
  private position = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parseExpression(depth: number): number {
    if (depth > MAX_EXPRESSION_DEPTH) {
      throw new ExpressionSyntaxError(
        `Condition nesting exceeds the maximum supported depth of ${MAX_EXPRESSION_DEPTH}.`,
        this.peek().offset,
      );
    }
    return this.parseOr(depth);
  }

  private parseOr(depth: number): number {
    let left = this.parseAnd(depth);
    while (this.peek().kind === "or") {
      this.advance();
      const right = this.parseAnd(depth);
      left = this.emit({ kind: "logical", operator: "or", left, right });
    }
    return left;
  }

  private parseAnd(depth: number): number {
    let left = this.parseComparison(depth);
    while (this.peek().kind === "and") {
      this.advance();
      const right = this.parseComparison(depth);
      left = this.emit({ kind: "logical", operator: "and", left, right });
    }
    return left;
  }

  private parseComparison(depth: number): number {
    const left = this.parseUnary(depth);
    const token = this.peek();
    if (token.kind !== "operator") {
      return left;
    }
    this.advance();
    const operator = COMPARISON_OPERATOR_NAMES[token.text];
    /* c8 ignore next 3 -- the lexer only emits `operator` tokens for these six spellings */
    if (operator === undefined) {
      throw new ExpressionSyntaxError(`Unsupported comparison "${token.text}".`, token.offset);
    }
    const right = this.parseUnary(depth);
    const next = this.peek();
    if (next.kind === "operator") {
      throw new ExpressionSyntaxError(
        "Comparisons cannot be chained — write `a < b && b < c` instead of `a < b < c`.",
        next.offset,
      );
    }
    return this.emit({ kind: "compare", operator, left, right });
  }

  private parseUnary(depth: number): number {
    if (this.peek().kind === "not") {
      this.advance();
      const operand = this.parseUnary(depth);
      return this.emit({ kind: "not", operand });
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): number {
    const token = this.peek();
    switch (token.kind) {
      case "lparen": {
        this.advance();
        const inner = this.parseExpression(depth + 1);
        const closing = this.peek();
        if (closing.kind !== "rparen") {
          throw new ExpressionSyntaxError('Missing ")".', closing.offset);
        }
        this.advance();
        return inner;
      }
      case "number": {
        this.advance();
        const value = Number(token.text);
        if (!Number.isFinite(value)) {
          throw new ExpressionSyntaxError(`"${token.text}" is not a finite number.`, token.offset);
        }
        return this.emit({ kind: "literal", value });
      }
      case "string":
        this.advance();
        return this.emit({ kind: "literal", value: token.text });
      case "true":
      case "false":
      case "null": {
        // A keyword only reads as a literal when it does *not* start a path:
        // `null` is the null literal, `null.count` is a reference whose first
        // segment happens to be spelled `null`.
        if (this.tokens[this.position + 1]?.kind === "dot") {
          return this.parsePath();
        }
        this.advance();
        return this.emit({
          kind: "literal",
          value: token.kind === "null" ? null : token.kind === "true",
        });
      }
      case "identifier":
        return this.parsePath();
      case "end":
        throw new ExpressionSyntaxError("Condition expression is incomplete.", token.offset);
      default:
        throw new ExpressionSyntaxError(`Unexpected "${token.text}" in condition.`, token.offset);
    }
  }

  private parsePath(): number {
    const first = this.peek();
    const segments: string[] = [first.text];
    this.advance();
    while (this.peek().kind === "dot") {
      const dot = this.advance();
      const segment = this.peek();
      if (!SEGMENT_KINDS.has(segment.kind)) {
        throw new ExpressionSyntaxError(
          "A state reference segment must be a name, for example `verify.blockingFindings`.",
          segment.kind === "end" ? dot.offset : segment.offset,
        );
      }
      segments.push(segment.text);
      this.advance();
      if (segments.length > MAX_PATH_SEGMENTS) {
        throw new ExpressionSyntaxError(
          `A state reference may have at most ${MAX_PATH_SEGMENTS} segments.`,
          segment.offset,
        );
      }
    }
    return this.emit({ kind: "path", path: segments });
  }

  expectEnd(): void {
    const token = this.peek();
    if (token.kind !== "end") {
      throw new ExpressionSyntaxError(
        token.kind === "rparen"
          ? 'Unmatched ")".'
          : `Unexpected "${token.text}" after the condition.`,
        token.offset,
      );
    }
  }

  private emit(node: ExpressionNode): number {
    if (this.nodes.length >= MAX_EXPRESSION_NODES) {
      throw new ExpressionSyntaxError(
        `Condition expression exceeds the maximum supported size of ${MAX_EXPRESSION_NODES} nodes.`,
        this.peek().offset,
      );
    }
    this.nodes.push(node);
    return this.nodes.length - 1;
  }

  private peek(): Token {
    const token = this.tokens[this.position];
    /* c8 ignore next 3 -- the lexer always terminates the stream with `end`, which is never consumed */
    if (token === undefined) {
      throw new ExpressionSyntaxError("Condition expression is incomplete.", 0);
    }
    return token;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== "end") {
      this.position += 1;
    }
    return token;
  }
}

/**
 * A one-line excerpt with a caret under `offset`, used as the tail of an
 * `pipeline.expression-invalid` suggestion. The YAML layer can locate the
 * scalar holding the expression but not a position *inside* it, so this is
 * how a reader finds the character that broke.
 */
export function renderExpressionExcerpt(source: string, offset: number): string {
  const clamped = Math.max(0, Math.min(offset, source.length));
  const single = source.replace(/[\r\n]/g, " ");
  return `${single}\n${" ".repeat(clamped)}^`;
}
