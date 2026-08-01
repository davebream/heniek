import { timingSafeEqual } from "node:crypto";

const PLACEHOLDER = "[redacted]";
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

/**
 * A non-serialisable carrier for a single credential value (§27.4/§6.3).
 *
 * The structural guarantee is: a `SensitiveValue` that reaches
 * `JSON.stringify`, a template literal, `console.log`, or `util.inspect`
 * always renders as `"[redacted]"`. `expose()` is the one, explicit,
 * greppable escape hatch — anyone reading a diff or a call site can see
 * exactly where a raw credential value leaves the wrapper. That is what
 * makes "secrets never leak into logs or snapshots" a property of the type
 * rather than something every call site has to remember to do.
 */
export class SensitiveValue {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  /** Wraps `value`. Rejects an empty string — there is no such thing as an empty credential. */
  static from(value: string): SensitiveValue {
    if (value.length === 0) {
      throw new Error("SensitiveValue.from requires a non-empty value.");
    }
    return new SensitiveValue(value);
  }

  /** The one explicit, greppable way to read the wrapped value back out. */
  expose(): string {
    return this.#value;
  }

  toString(): string {
    return PLACEHOLDER;
  }

  toJSON(): string {
    return PLACEHOLDER;
  }

  [INSPECT_CUSTOM](): string {
    return PLACEHOLDER;
  }

  /**
   * Constant-time equality over the UTF-8 encoding of both values.
   *
   * `crypto.timingSafeEqual` throws on a buffer-length mismatch rather than
   * comparing, so a length difference is checked up front and short-circuits
   * to `false` before any byte comparison happens. That length check is
   * itself a (small, unavoidable) timing side channel: comparing a 4-byte
   * value against a 4000-byte value returns faster than comparing two
   * 4000-byte values. What `timingSafeEqual` protects against is the more
   * dangerous channel — leaking *which byte* first differs between two
   * same-length values, which is what makes byte-by-byte credential
   * guessing practical. The residual length signal is accepted as
   * out-of-scope here, consistent with `timingSafeEqual`'s own contract.
   */
  equals(other: SensitiveValue): boolean {
    const a = Buffer.from(this.#value, "utf8");
    const b = Buffer.from(other.#value, "utf8");
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}
