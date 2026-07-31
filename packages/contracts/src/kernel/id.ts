import { Type } from "@sinclair/typebox";
import type { Brand } from "./brand.js";

/**
 * Declares an opaque branded ID schema: a plain non-empty string on the
 * wire (clean JSON Schema output), nominally distinct per `name` at the
 * type level. v1 intentionally has no format constraint beyond
 * non-emptiness — no namespace-wide ULID/UUID pattern is imposed.
 */
export function defineIdNamespace<const Name extends string>(name: Name) {
  return Type.Unsafe<Brand<string, Name>>(
    Type.String({ minLength: 1, description: `Opaque ${name}.` }),
  );
}
