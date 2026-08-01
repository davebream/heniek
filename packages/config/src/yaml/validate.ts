import { createRequire } from "node:module";
import type { Schema as AjvSchema, ErrorObject, ValidateFunction } from "ajv";
import { Ajv } from "ajv";
import type { Document, LineCounter } from "yaml";
import type { Diagnostic } from "../diagnostics.js";
import { createDiagnostic, sortDiagnostics } from "../diagnostics.js";
import type { RestrictedYamlOptions } from "./restricted.js";
import { parseRestrictedYaml, parseYamlDocumentForPointerResolution } from "./restricted.js";

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

/**
 * Compiles `schema`, tolerating both hazards a naive `ajv.compile` call
 * carries (C4):
 *
 *  - a schema carrying an explicit `$id` throws `schema with key or id ...
 *    already exists` on a *second* Ajv-level compile of an equal-but-not-
 *    identical `$id` — which the identity-keyed `WeakMap` above cannot
 *    prevent by itself, since two distinct object literals sharing the same
 *    `$id` are two distinct `WeakMap` keys. `ajv.getSchema($id)` is checked
 *    first so a schema Ajv already knows about (by `$id`, not by object
 *    identity) is reused instead of recompiled;
 *  - any other Ajv compile-time error (an unknown keyword under
 *    `strict: true`, a malformed schema) is caught and converted into a
 *    `configuration.schema-violation` diagnostic via `AjvCompileError`,
 *    rather than propagating out of `loadRestrictedYamlDocument` — a
 *    Result-typed function must not throw for a caller mistake it can
 *    describe as a diagnostic instead.
 */
function compile(schema: AjvSchema): ValidateFunction {
  if (typeof schema !== "object" || schema === null) {
    return compileOrThrowDiagnosable(schema);
  }
  const cached = compiledValidators.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const id = "$id" in schema && typeof schema.$id === "string" ? schema.$id : undefined;
  const known = id !== undefined ? ajv.getSchema(id) : undefined;
  const validateFn = known ?? compileOrThrowDiagnosable(schema);
  compiledValidators.set(schema, validateFn);
  return validateFn;
}

/** Thrown by `compile` to signal "this schema itself is invalid" — caught by `loadRestrictedYamlDocument` and turned into a diagnostic rather than left to propagate. */
class AjvCompileError extends Error {}

function compileOrThrowDiagnosable(schema: AjvSchema): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch (error) {
    throw new AjvCompileError(error instanceof Error ? error.message : String(error));
  }
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

  let validateFn: ValidateFunction;
  try {
    validateFn = compile(schema);
  } catch (error) {
    if (error instanceof AjvCompileError) {
      return {
        ok: false,
        diagnostics: sortDiagnostics([
          ...parsed.diagnostics,
          createDiagnostic(
            "configuration.schema-violation",
            "error",
            `Invalid schema: ${error.message}`,
            {
              ...(options.sourcePath !== undefined ? { sourcePath: options.sourcePath } : {}),
            },
          ),
        ]),
      };
    }
    throw error;
  }

  const valid = validateFn(parsed.value);
  if (!valid) {
    // Only re-parsed (retaining the composed `Document` + `LineCounter`) on
    // this — comparatively rare — failure path, so the common "document
    // validates" case pays no second-parse cost (D2).
    const pointerSource = parseYamlDocumentForPointerResolution(source);
    const schemaDiagnostics = (validateFn.errors ?? []).map((error) =>
      diagnosticFromAjvError(error, options.sourcePath, pointerSource),
    );
    return {
      ok: false,
      diagnostics: sortDiagnostics([...parsed.diagnostics, ...schemaDiagnostics]),
    };
  }

  return { ok: true, value: parsed.value as T, diagnostics: parsed.diagnostics };
}

/** RFC 6901 JSON Pointer → the segment array `Document#getIn` expects, unescaping `~1`/`~0` in that order (`~` must be restored last, matching `escapePointerSegment`'s encode-`~`-first rule in `json.ts`). */
function pointerToPath(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }
  return pointer.slice(1).split("/").map(unescapePointerSegment);
}

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function hasRange(node: unknown): node is { range?: readonly [number, number, number] | null } {
  return typeof node === "object" && node !== null && "range" in node;
}

/**
 * Resolves an Ajv `instancePath` back to a `{ line, column }` via the
 * retained `Document` and `LineCounter` (D2). Returns `undefined` — never a
 * fabricated position — whenever the pointer cannot be resolved to an actual
 * node: `pointerSource` itself may be absent (the source didn't compose into
 * exactly one document, e.g. the empty-document case), or the pointer may
 * name a path the document never materialised (Ajv can report an
 * `instancePath` for a keyword like `if`/`propertyNames` that does not
 * correspond 1:1 with a concrete YAML node).
 */
function resolvePointerPosition(
  pointer: string,
  pointerSource:
    | { readonly document: Document.Parsed; readonly lineCounter: LineCounter }
    | undefined,
): { readonly line: number; readonly column: number } | undefined {
  if (pointerSource === undefined) {
    return undefined;
  }
  const node: unknown = pointerSource.document.getIn(pointerToPath(pointer), true);
  const range = hasRange(node) ? node.range : undefined;
  if (range === null || range === undefined) {
    return undefined;
  }
  const position = pointerSource.lineCounter.linePos(range[0]);
  return { line: position.line, column: position.col };
}

function diagnosticFromAjvError(
  error: ErrorObject,
  sourcePath: string | undefined,
  pointerSource:
    | { readonly document: Document.Parsed; readonly lineCounter: LineCounter }
    | undefined,
): Diagnostic {
  const message =
    `${error.instancePath || "(root)"} ${error.message ?? "failed schema validation"}`.trim();
  const position = resolvePointerPosition(error.instancePath, pointerSource);
  return createDiagnostic("configuration.schema-violation", "error", message, {
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    pointer: error.instancePath,
    ...(position !== undefined ? { line: position.line, column: position.column } : {}),
  });
}
