import { createRequire } from "node:module";
import type { TSchema } from "@sinclair/typebox";
import { Ajv, type ValidateFunction } from "ajv";

// See packages/contracts/scripts/generate.ts for why ajv-formats is loaded
// via createRequire rather than a static import (a TS 7 / NodeNext interop
// gap for CJS packages with no "exports" map).
const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

const compiledCache = new Map<string, ValidateFunction>();

function compile(schema: TSchema): ValidateFunction {
  const schemaId = typeof schema.$id === "string" ? schema.$id : undefined;
  if (schemaId !== undefined) {
    const cached = compiledCache.get(schemaId);
    if (cached !== undefined) {
      return cached;
    }
  }
  const validate = ajv.compile(schema);
  if (schemaId !== undefined) {
    compiledCache.set(schemaId, validate);
  }
  return validate;
}

/**
 * Validates `value` against `schema`, throwing a labelled `Error` on
 * failure. Every conformance case that checks contract shape goes through
 * this single shared validator so a case proves *contract* conformance, not
 * fake-specific behaviour (design §4).
 *
 * `references` must include every `$ref` target the schema reaches that is
 * not already inlined — TypeBox `Type.Ref(...)` contracts need their
 * targets registered with Ajv before compile.
 */
export function assertValid(
  schema: TSchema,
  value: unknown,
  label: string,
  references: readonly TSchema[] = [],
): void {
  for (const reference of references) {
    const referenceId = typeof reference.$id === "string" ? reference.$id : undefined;
    if (referenceId !== undefined && ajv.getSchema(referenceId) === undefined) {
      ajv.addSchema(reference);
    }
  }
  const validate = compile(schema);
  const ok = validate(value);
  if (!ok) {
    const errorsText = ajv.errorsText(validate.errors, { separator: "; " });
    throw new Error(`${label}: contract validation failed — ${errorsText}`);
  }
}
