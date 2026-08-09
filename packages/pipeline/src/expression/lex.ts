/**
 * The tokenizer for §14.4's deterministic conditions.
 *
 * Deliberately tiny. The grammar admits dotted state references, JSON
 * scalars, six comparison operators, `&&`/`||`/`!`, and parentheses — no
 * arithmetic, no indexing, no function calls. §8.1 forbids executable values,
 * and the cheapest way to keep that promise is for the language to have
 * nothing to execute: every accepted expression compiles to a data structure
 * a consumer walks, and anything richer is a syntax error at authoring time
 * rather than a capability at run time.
 */

export type TokenKind =
  | "identifier"
  | "number"
  | "string"
  | "true"
  | "false"
  | "null"
  | "dot"
  | "operator"
  | "and"
  | "or"
  | "not"
  | "lparen"
  | "rparen"
  | "end";

export interface Token {
  readonly kind: TokenKind;
  /** Byte-free character offset into the source expression, used for diagnostics. */
  readonly offset: number;
  /** Exact source text, except for strings, where it is the decoded value. */
  readonly text: string;
}

export interface LexError {
  readonly message: string;
  readonly offset: number;
}

export type LexResult =
  | { readonly ok: true; readonly tokens: readonly Token[] }
  | { readonly ok: false; readonly error: LexError };

/**
 * A hard ceiling on the source text, checked before any scanning. Conditions
 * are single-line predicates authored by hand; anything approaching this
 * length is a pasted payload, not a condition, and failing fast beats
 * scanning it.
 */
export const MAX_EXPRESSION_LENGTH = 1_000;

const COMPARISON_OPERATORS = new Set(["==", "!=", "<", "<=", ">", ">="]);

/** Characters that would be arithmetic in a fuller language and are refused by name here. */
const ARITHMETIC_CHARACTERS = new Set(["+", "-", "*", "/", "%"]);

/** Token kinds a value ends on — used to tell a negative literal from a subtraction. */
const VALUE_END_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "identifier",
  "number",
  "string",
  "true",
  "false",
  "null",
  "rparen",
]);

function endsValue(tokens: readonly Token[]): boolean {
  const last = tokens[tokens.length - 1];
  return last !== undefined && VALUE_END_KINDS.has(last.kind);
}

function isIdentifierStart(character: string): boolean {
  return /^[A-Za-z_]$/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /^[A-Za-z0-9_]$/.test(character);
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

/**
 * Scans `source` into tokens. Whitespace separates tokens and is otherwise
 * insignificant, which is what lets two spellings of the same condition
 * (`a>0` and `a > 0`) compile to identical graph bytes.
 */
export function lexExpression(source: string): LexResult {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    return {
      ok: false,
      error: {
        message: `Condition expression exceeds the maximum supported length of ${MAX_EXPRESSION_LENGTH} characters.`,
        offset: MAX_EXPRESSION_LENGTH,
      },
    };
  }

  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index] ?? "";

    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      index += 1;
      continue;
    }

    const start = index;

    if (character === "(") {
      tokens.push({ kind: "lparen", offset: start, text: "(" });
      index += 1;
      continue;
    }
    if (character === ")") {
      tokens.push({ kind: "rparen", offset: start, text: ")" });
      index += 1;
      continue;
    }
    if (character === ".") {
      tokens.push({ kind: "dot", offset: start, text: "." });
      index += 1;
      continue;
    }

    if (character === "&" || character === "|") {
      const pair = source.slice(index, index + 2);
      if (pair === "&&" || pair === "||") {
        tokens.push({ kind: pair === "&&" ? "and" : "or", offset: start, text: pair });
        index += 2;
        continue;
      }
      return {
        ok: false,
        error: {
          // Named explicitly rather than reported as a generic unexpected
          // character: `&` and `|` are what a reader who expects a C-like or
          // a shell-like language types first, and "did you mean `&&`" is a
          // more useful answer than "unexpected `&`".
          message: `Unsupported operator "${character}" — use "&&" and "||".`,
          offset: start,
        },
      };
    }

    if (character === "=" || character === "!" || character === "<" || character === ">") {
      const pair = source.slice(index, index + 2);
      if (COMPARISON_OPERATORS.has(pair)) {
        tokens.push({ kind: "operator", offset: start, text: pair });
        index += 2;
        continue;
      }
      if (character === "!") {
        tokens.push({ kind: "not", offset: start, text: "!" });
        index += 1;
        continue;
      }
      if (character === "=") {
        return {
          ok: false,
          error: {
            message: 'Unsupported operator "=" — use "==" to compare.',
            offset: start,
          },
        };
      }
      tokens.push({ kind: "operator", offset: start, text: character });
      index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        const inner = source[index] ?? "";
        if (inner === "\\") {
          const escaped = source[index + 1];
          if (escaped === undefined) {
            break;
          }
          // Only the two escapes a quoted scalar actually needs. A broader
          // escape table (\n, \u….) would make two spellings of the same
          // string literal compile to the same bytes while reading
          // differently in the source, and nothing in a condition needs a
          // newline inside a string.
          if (escaped !== quote && escaped !== "\\") {
            return {
              ok: false,
              error: {
                message: `Unsupported escape "\\${escaped}" — only \\\\ and \\${quote} are recognised inside a string.`,
                offset: index,
              },
            };
          }
          value += escaped;
          index += 2;
          continue;
        }
        if (inner === quote) {
          closed = true;
          index += 1;
          break;
        }
        if (inner === "\n" || inner === "\r") {
          break;
        }
        value += inner;
        index += 1;
      }
      if (!closed) {
        return {
          ok: false,
          error: { message: "Unterminated string literal.", offset: start },
        };
      }
      tokens.push({ kind: "string", offset: start, text: value });
      continue;
    }

    // Arithmetic is not part of the grammar, and a reader who typed `a - 1`
    // deserves to be told that rather than to see the `-1` swallowed as a
    // number literal and the parser complain about an unexpected number one
    // token later. A leading `-` is a sign only where a value may begin —
    // i.e. never straight after another value.
    if (ARITHMETIC_CHARACTERS.has(character)) {
      const signAllowed =
        character === "-" && isDigit(source[index + 1] ?? "") && !endsValue(tokens);
      if (!signAllowed) {
        return {
          ok: false,
          error: {
            message: `Unsupported operator "${character}" — condition expressions compare and combine values, they do not compute them.`,
            offset: start,
          },
        };
      }
    }

    if (isDigit(character) || character === "-") {
      index += character === "-" ? 1 : 0;
      while (isDigit(source[index] ?? "")) {
        index += 1;
      }
      if ((source[index] ?? "") === ".") {
        const afterDot = source[index + 1] ?? "";
        // A `.` is only part of the number when a digit follows. `1.foo` is a
        // malformed number, not a number followed by a path segment, and
        // saying so here beats letting the parser report a confusing
        // "unexpected identifier" one token later.
        if (isDigit(afterDot)) {
          index += 1;
          while (isDigit(source[index] ?? "")) {
            index += 1;
          }
        } else {
          return {
            ok: false,
            error: {
              message: "A number must have at least one digit after the decimal point.",
              offset: index,
            },
          };
        }
      }
      tokens.push({ kind: "number", offset: start, text: source.slice(start, index) });
      continue;
    }

    if (isIdentifierStart(character)) {
      while (isIdentifierPart(source[index] ?? "")) {
        index += 1;
      }
      const text = source.slice(start, index);
      const keyword: TokenKind | undefined =
        text === "true"
          ? "true"
          : text === "false"
            ? "false"
            : text === "null"
              ? "null"
              : undefined;
      tokens.push({ kind: keyword ?? "identifier", offset: start, text });
      continue;
    }

    return {
      ok: false,
      error: { message: `Unexpected character "${character}" in condition.`, offset: start },
    };
  }

  tokens.push({ kind: "end", offset: source.length, text: "" });
  return { ok: true, tokens };
}
