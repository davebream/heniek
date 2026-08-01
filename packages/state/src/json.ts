/**
 * `JsonValue` and `canonicalize` — copied, not imported, from
 * `packages/conformance/src/kernel/json.ts:2-31`. Importing would give
 * `@heniek/state` a runtime edge on `@heniek/conformance` for ~30 lines of
 * pure, already-pinned logic (plan §0.6, design D14). Any future edit to
 * the conformance original must be mirrored here by hand.
 *
 * **Deliberate divergence from the conformance original:** the conformance
 * copy writes `out[key] = …` into a plain `{}`, which silently reassigns
 * `out`'s prototype (and drops the key entirely) when `key === "__proto__"`,
 * because `JSON.parse` creates `__proto__` as an own data property but a
 * plain assignment still invokes `Object.prototype`'s `__proto__` *setter*.
 * This copy fixes that with `Object.defineProperty` (issue #7, fix B4).
 * `packages/conformance/src/**` is fenced for this round — the fix is not
 * mirrored back there; that is out of scope for issue #7 and is a
 * conscious, recorded divergence rather than an oversight.
 *
 * **Second deliberate divergence:** the conformance original lets `NaN` and
 * `Infinity`/`-Infinity` pass through `canonicalize` unchanged, relying on
 * `JSON.stringify` silently converting them to `null` in
 * `stringifyCanonical`. That is accepted upstream but not here:
 * `canonicalize` rejects a non-finite number outright with `StateStoreError`
 * (issue #7, fix N3), because a payload that silently changes shape on the
 * way into the journal — a `NaN` a caller thought it was storing, coming
 * back out as `null` — is exactly the kind of unreproducible-replay bug
 * this package exists to prevent. `-0` is finite and therefore not
 * rejected, but JSON has no concept of a negative zero distinct from zero,
 * so it is explicitly normalised to `0` rather than left to depend on
 * `JSON.stringify`'s own (correct, but easy to forget) string conversion.
 */

import { StateStoreError } from "./errors.js";

/**
 * Recursion depth bound for `canonicalize`/`assertJsonValue` (issue #7, fix
 * N4). Guards against a cyclic in-memory structure passed to
 * `canonicalize(value: JsonValue)` (Phase 4's entry point) recursing
 * forever, and — the more realistic case — against a deeply nested but
 * non-cyclic structure blowing the call stack as an uncaught `RangeError`
 * rather than a `StateStoreError`: `JSON.parse` is iterative in V8, so tens
 * of thousands of nested arrays parse without error and only fail once
 * `assertJsonValue`/`canonicalize` walks them recursively — well before the
 * 64 KiB payload-size cap (D7) would ever reject the same text on size
 * alone. 64 is generous for any payload this package's own event
 * vocabulary produces, while being far below where V8's default stack
 * would actually overflow.
 */
const MAX_DEPTH = 64;

/** A JSON-serializable value — the shape every journal payload must hold to. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Recursively sorts object keys so structurally identical values serialize
 * identically regardless of insertion order — required for byte-reproducible
 * canonical payloads.
 */
export function canonicalize(value: JsonValue, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) {
    throw new StateStoreError(`canonicalize: recursion depth exceeded ${MAX_DEPTH}`);
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    // `.sort()` with no comparator orders by UTF-16 code unit, not locale
    // and not numerically — that is the exact ordering byte-reproducibility
    // requires here (a locale-aware or numeric sort would make the same key
    // set serialize differently on a different host), so it deserves saying
    // so rather than reading as an accidental omission.
    const sortedKeys = Object.keys(value).sort();
    const out: Record<string, JsonValue> = {};
    for (const key of sortedKeys) {
      const entryValue = (value as { readonly [key: string]: JsonValue })[key];
      if (entryValue !== undefined) {
        // A non-invoking define: a plain `out[key] = …` assignment walks the
        // prototype chain and, for `key === "__proto__"`, invokes
        // `Object.prototype`'s `__proto__` setter instead of creating an own
        // property — silently reassigning `out`'s prototype and dropping the
        // key (issue #7, fix B4).
        Object.defineProperty(out, key, {
          value: canonicalize(entryValue, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return out;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      // Reject NaN/±Infinity on this write path rather than let them
      // silently become `null` through `JSON.stringify` in
      // `stringifyCanonical` — a payload containing a non-finite number
      // would otherwise be stored as `null` and then fail to compare equal
      // to the value the reducer folds, a divergence report blaming the
      // store for the caller's input (issue #7, fix N3). Safe to skip on
      // the read path: `JSON.parse` can never produce a non-finite number.
      throw new StateStoreError(`canonicalize: value is not a finite number (${value})`);
    }
    if (value === 0) {
      // `-0 === 0` is `true` in JS, so this also matches ordinary `0` (a
      // harmless no-op there). JSON has no concept of a negative zero
      // distinct from zero — normalise explicitly here (issue #7, fix N3)
      // rather than relying on `JSON.stringify`'s own (correct, but easy to
      // forget) string conversion to do it later in `stringifyCanonical`.
      return 0;
    }
  }
  return value;
}

/**
 * Parses `text` as JSON and asserts the result is a `JsonValue`. `JSON.parse`
 * cannot actually produce anything outside that shape (no `undefined`, no
 * functions, no cyclic structures survive a round trip through text), but
 * this guard is what lets every downstream consumer avoid an `as` cast on
 * parsed input.
 */
export function parseJsonValue(text: string, what: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Neither Node's `JSON.parse` message (it embeds a ~10-character excerpt
    // of the offending input) nor its `cause` (printed verbatim by Node's
    // default formatter) may cross this boundary — this function's entire
    // input is a payload, and the package's rule is that no message may
    // contain payload bytes. `what` and the input's byte length are kept as
    // structural, non-payload diagnostics.
    throw new StateStoreError(`${what} is not valid JSON (${utf8ByteLength(text)} bytes)`);
  }
  return assertJsonValue(parsed, what);
}

function assertJsonValue(value: unknown, what: string, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) {
    throw new StateStoreError(`${what}: recursion depth exceeded ${MAX_DEPTH}`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => assertJsonValue(item, what, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      // Same non-invoking define as `canonicalize` above — a plain
      // `out[key] = …` assignment would invoke the `__proto__` setter
      // instead of creating an own property (issue #7, fix B4).
      Object.defineProperty(out, key, {
        value: assertJsonValue(entryValue, what, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  throw new StateStoreError(
    `${what} contains a value that is not JSON-representable (${typeof value})`,
  );
}

/** `JSON.stringify(canonicalize(value))` — the package's one canonical serialisation. */
export function stringifyCanonical(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

/** The UTF-8 byte length of `text`, used to enforce D7's payload cap. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
