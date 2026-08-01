import { createRequire } from "node:module";
import type { Schema as AjvSchema, ErrorObject, ValidateFunction } from "ajv";
import { Ajv } from "ajv";
import type { Diagnostic } from "../diagnostics.js";
import { createDiagnostic, sortDiagnostics } from "../diagnostics.js";
import type { RestrictedYamlOptions } from "./restricted.js";
import { parseRestrictedYaml } from "./restricted.js";

// Same NodeNext + verbatimModuleSyntax interop gap `@heniek/contracts`'
// `scripts/generate.ts` documents: ajv-formats' .d.ts declares only a
// default export, and under this repo's module settings a static
// `import ... from "ajv-formats"` resolves to the raw module-namespace type
// instead of unwrapping the default. `createRequire` sidesteps the broken
// static resolution and uses Node's own CJS interop at runtime; the type is
// recovered separately via a type-only `typeof import(...)` query.
const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

/**
 * One shared Ajv instance, configured identically to
 * `packages/contracts/scripts/generate.ts` (`strict: true, allErrors: true`
 * plus `ajv-formats`) so a document that validates here validates the same
 * way a generated public contract would.
 */
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

// Compiled validators are cached per schema *object identity*, not
// deep-equality: callers are expected to hold one schema constant and reuse
// it across many `loadRestrictedYamlDocument` calls (once per parsed
// document), which is also what keeps this safe against Ajv's
// duplicate-`$id` error — the same schema object is only ever
// `ajv.compile`d once, however many times validation is requested.
const compiledValidators = new WeakMap<object, ValidateFunction>();

function compile(schema: AjvSchema): ValidateFunction {
  if (typeof schema !== "object" || schema === null) {
    return ajv.compile(schema);
  }
  const cached = compiledValidators.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const validateFn = ajv.compile(schema);
  compiledValidators.set(schema, validateFn);
  return validateFn;
}

export type RestrictedYamlDocumentResult<T> =
  | { readonly ok: true; readonly value: T; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Parses `source` with `parseRestrictedYaml`, then — only if that succeeds —
 * validates the resulting value against `schema` with Ajv (spec §8.1's
 * "every document is validated against JSON Schema"). Schema-violation
 * diagnostics carry the Ajv `instancePath` as `pointer` directly: Ajv's
 * `instancePath` is already an RFC 6901 JSON Pointer, so no translation is
 * needed.
 */
export function loadRestrictedYamlDocument<T>(
  source: string,
  schema: AjvSchema,
  options: RestrictedYamlOptions = {},
): RestrictedYamlDocumentResult<T> {
  const parsed = parseRestrictedYaml(source, options);
  if (!parsed.ok) {
    return parsed;
  }

  const validateFn = compile(schema);
  const valid = validateFn(parsed.value);
  if (!valid) {
    const schemaDiagnostics = (validateFn.errors ?? []).map((error) =>
      diagnosticFromAjvError(error, options.sourcePath),
    );
    return {
      ok: false,
      diagnostics: sortDiagnostics([...parsed.diagnostics, ...schemaDiagnostics]),
    };
  }

  return { ok: true, value: parsed.value as T, diagnostics: parsed.diagnostics };
}

function diagnosticFromAjvError(error: ErrorObject, sourcePath: string | undefined): Diagnostic {
  const message =
    `${error.instancePath || "(root)"} ${error.message ?? "failed schema validation"}`.trim();
  return createDiagnostic("configuration.schema-violation", "error", message, {
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    pointer: error.instancePath,
  });
}
