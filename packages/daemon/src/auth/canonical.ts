/**
 * Byte-level excision of the `params.auth` member from a raw request line
 * (design C6).
 *
 * The MAC is computed over **the exact bytes that arrived**, with the
 * `params.auth` span removed — deliberately *not* over a re-serialisation of
 * the parsed object. Re-serialising would open a serialisation-ambiguity gap:
 * key order, whitespace, number formatting (`1e2` vs `100`), and string escape
 * choices (`A` vs `A`) all survive a parse but need not survive a
 * round-trip, so the verifier could authenticate a byte sequence different
 * from the one the client signed. Working on the original bytes closes that
 * gap by construction.
 *
 * `params.auth` itself must be excised because it carries the MAC, which
 * cannot cover itself. Everything inside that span is therefore
 * **unauthenticated by design** — which is only safe because the caller
 * validates the span against `DaemonRequestAuth/v1` (closed by
 * `additionalProperties: false`) *before* reaching this module, so it can hold
 * exactly `keyId`, `sequence`, and `mac` and nothing else.
 *
 * Pure string/index work: no I/O, no cryptography, no clock.
 */

/** A half-open `[start, end)` index range into the raw line. */
interface Span {
  readonly start: number;
  readonly end: number;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && WHITESPACE.has(text[i] as string)) {
    i += 1;
  }
  return i;
}

/** `index` sits on the opening quote; returns the index just past the closing quote. */
function endOfString(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\") {
      // Skip the escape and whatever it escapes, so an escaped quote does not
      // terminate the string early.
      i += 2;
      continue;
    }
    if (char === '"') {
      return i + 1;
    }
    i += 1;
  }
  throw new SyntaxError("unterminated string");
}

function endOfValue(text: string, index: number): number {
  const i = skipWhitespace(text, index);
  const char = text[i];
  if (char === '"') {
    return endOfString(text, i);
  }
  if (char === "{" || char === "[") {
    return endOfContainer(text, i);
  }
  // A literal: number, `true`, `false`, or `null`. It ends at the first
  // structural delimiter or whitespace.
  let end = i;
  while (end < text.length && !",}] \t\n\r".includes(text[end] as string)) {
    end += 1;
  }
  if (end === i) {
    throw new SyntaxError(`unexpected character at ${i}`);
  }
  return end;
}

function endOfContainer(text: string, index: number): number {
  const closing = text[index] === "{" ? "}" : "]";
  const isObject = closing === "}";
  let i = index + 1;

  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) {
      throw new SyntaxError("unterminated container");
    }
    if (text[i] === closing) {
      return i + 1;
    }
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (isObject) {
      i = endOfString(text, i);
      i = skipWhitespace(text, i);
      if (text[i] !== ":") {
        throw new SyntaxError(`expected ':' at ${i}`);
      }
      i += 1;
    }
    i = endOfValue(text, i);
  }
}

/**
 * Finds the `key` member of the object beginning at `objectStart`, returning
 * the member's full span (opening quote of the key through the last byte of
 * its value) and where its value begins.
 *
 * Only the object's own members are considered — nested objects are skipped
 * wholesale, so a `"auth"` key buried inside some other member cannot be
 * mistaken for the real one.
 */
function findMember(
  text: string,
  objectStart: number,
  key: string,
): { readonly member: Span; readonly valueStart: number } | undefined {
  if (text[objectStart] !== "{") {
    return undefined;
  }
  let i = objectStart + 1;

  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length || text[i] === "}") {
      return undefined;
    }
    if (text[i] === ",") {
      i += 1;
      continue;
    }

    const memberStart = i;
    const keyEnd = endOfString(text, i);
    const name = JSON.parse(text.slice(memberStart, keyEnd)) as string;

    i = skipWhitespace(text, keyEnd);
    if (text[i] !== ":") {
      throw new SyntaxError(`expected ':' at ${i}`);
    }
    const valueStart = skipWhitespace(text, i + 1);
    const valueEnd = endOfValue(text, valueStart);

    if (name === key) {
      return { member: { start: memberStart, end: valueEnd }, valueStart };
    }
    i = valueEnd;
  }
}

/**
 * Removes `span` plus exactly one adjacent comma, so the result stays valid
 * JSON. The rule is fixed rather than context-sensitive — preceding comma if
 * there is one, otherwise following comma, otherwise neither — because client
 * and server must agree on the canonical bytes without negotiating.
 */
function removeMember(text: string, span: Span): string {
  let cutStart = span.start;
  let cutEnd = span.end;

  let before = span.start - 1;
  while (before >= 0 && WHITESPACE.has(text[before] as string)) {
    before -= 1;
  }
  if (before >= 0 && text[before] === ",") {
    cutStart = before;
    return text.slice(0, cutStart) + text.slice(cutEnd);
  }

  const after = skipWhitespace(text, span.end);
  if (after < text.length && text[after] === ",") {
    cutEnd = after + 1;
  }
  return text.slice(0, cutStart) + text.slice(cutEnd);
}

/**
 * Locates the single `params.auth` member — a direct child of the object
 * bound to the top-level `params`, never a member found by searching the
 * whole document — shared by `canonicaliseRequest` and
 * `extractAuthValueText` so both agree on exactly the same span.
 */
function locateParamsAuth(
  line: string,
): { readonly member: Span; readonly valueStart: number } | undefined {
  const rootStart = skipWhitespace(line, 0);
  if (line[rootStart] !== "{") {
    return undefined;
  }

  const params = findMember(line, rootStart, "params");
  if (params === undefined) {
    return undefined;
  }
  if (line[params.valueStart] !== "{") {
    return undefined;
  }

  return findMember(line, params.valueStart, "auth");
}

/**
 * Returns `line` with its `params.auth` member removed, or `undefined` when
 * the line has no such member — which for an authenticated call is itself an
 * authentication failure, and the caller reports it as the uniform
 * `unauthorized`.
 *
 * Throws `SyntaxError` only on input that is not well-formed JSON. Callers
 * receive lines the codec has already parsed successfully, so that is a
 * programming error rather than an attacker-reachable path.
 */
export function canonicaliseRequest(line: string): string | undefined {
  const auth = locateParamsAuth(line);
  if (auth === undefined) {
    return undefined;
  }
  return removeMember(line, auth.member);
}

/**
 * Returns the raw text of the `params.auth` member's *value* only (not the
 * key, not the surrounding comma) — the substring `src/auth/verify.ts`
 * `JSON.parse`s and validates against `DaemonRequestAuth/v1` before any MAC
 * is computed (design C6, plan Task 3 Step 2(e)). `undefined` under exactly
 * the same conditions as `canonicaliseRequest`.
 */
export function extractAuthValueText(line: string): string | undefined {
  const auth = locateParamsAuth(line);
  if (auth === undefined) {
    return undefined;
  }
  return line.slice(auth.valueStart, auth.member.end);
}

/**
 * Returns `true` if any JSON object anywhere in `line` — top-level, nested
 * inside another object, or nested inside an array — repeats a member name
 * (design C6, plan Task 3 Step 2(a)). This is the defence the JWS/XML-
 * wrapping attack family needs: `JSON.parse` alone cannot detect a
 * duplicate key, since it silently keeps only the last occurrence, so a
 * duplicate `"auth"` (or a duplicate anywhere else in the frame) is
 * invisible to naive parsing and must be caught by walking every object's
 * own key set explicitly, before any excision or MAC computation happens.
 *
 * Throws `SyntaxError` only on input that is not well-formed JSON — see
 * `canonicaliseRequest`'s identical caveat.
 */
export function hasDuplicateKey(line: string): boolean {
  return valueHasDuplicateKey(line, skipWhitespace(line, 0));
}

function valueHasDuplicateKey(text: string, index: number): boolean {
  const i = skipWhitespace(text, index);
  const char = text[i];
  if (char === "{") {
    return objectHasDuplicateKey(text, i);
  }
  if (char === "[") {
    return arrayHasDuplicateKey(text, i);
  }
  // A string, number, or literal cannot itself contain a JSON object with
  // duplicate keys; `endOfValue` below is what skips past it.
  return false;
}

function objectHasDuplicateKey(text: string, objectStart: number): boolean {
  const seen = new Set<string>();
  let i = objectStart + 1;

  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) {
      throw new SyntaxError("unterminated object");
    }
    if (text[i] === "}") {
      return false;
    }
    if (text[i] === ",") {
      i += 1;
      continue;
    }

    const keyStart = i;
    const keyEnd = endOfString(text, i);
    const name = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    if (seen.has(name)) {
      return true;
    }
    seen.add(name);

    i = skipWhitespace(text, keyEnd);
    if (text[i] !== ":") {
      throw new SyntaxError(`expected ':' at ${i}`);
    }
    const valueStart = skipWhitespace(text, i + 1);
    if (valueHasDuplicateKey(text, valueStart)) {
      return true;
    }
    i = endOfValue(text, valueStart);
  }
}

function arrayHasDuplicateKey(text: string, arrayStart: number): boolean {
  let i = arrayStart + 1;

  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) {
      throw new SyntaxError("unterminated array");
    }
    if (text[i] === "]") {
      return false;
    }
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (valueHasDuplicateKey(text, i)) {
      return true;
    }
    i = endOfValue(text, i);
  }
}
