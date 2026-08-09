/**
 * The one public entry point: YAML text in, graph plus diagnostics out.
 *
 * Four layers run in order, and each only runs when the previous one found
 * nothing fatal:
 *
 * 1. `@heniek/config`'s restricted YAML subset (§8.1) — no anchors, no custom
 *    tags, no duplicate keys, no credential-shaped values;
 * 2. Ajv against `PipelineDefinition/v1` — shapes, enums, patterns;
 * 3. normalization — the collapse that makes equivalent documents identical;
 * 4. the semantic rules a schema cannot express.
 *
 * Layers 1 and 2 are one call, because `loadRestrictedYamlDocument` already
 * pairs them and resolves schema-violation pointers back to source positions.
 * Layer 3 runs even when it finds a broken condition, and layer 4 runs on its
 * output, so an author sees every problem in one pass instead of one per run.
 *
 * The function is total and pure: no filesystem, no clock, no network, no
 * ambient configuration. The same text and options always produce the same
 * result, which is what makes the graph a diff target and the diagnostics a
 * checked-in corpus.
 */

import { loadRestrictedYamlDocument, parseYamlDocumentForPointerResolution } from "@heniek/config";
import { PipelineDefinitionV1 } from "@heniek/contracts";
import type { PipelineDiagnostic } from "./diagnostics.js";
import { hasErrorDiagnostic, sortPipelineDiagnostics } from "./diagnostics.js";
import type { PipelineDocument, PipelineGraph } from "./document.js";
import { normalizePipelineDocument } from "./graph/normalize.js";
import type { ValidatePipelineOptions } from "./graph/validate.js";
import { validatePipelineGraph } from "./graph/validate.js";
import type { PositionResolver, SourcePosition } from "./reporter.js";
import { createDiagnosticReporter } from "./reporter.js";
import { collapseSchemaViolations, withSuggestion } from "./suggestions.js";

export interface ParsePipelineOptions extends ValidatePipelineOptions {
  /** Attached to every diagnostic, so a reader knows which file to open. */
  readonly sourcePath?: string;
}

export type ParsePipelineResult =
  | {
      readonly ok: true;
      readonly graph: PipelineGraph;
      readonly diagnostics: readonly PipelineDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly PipelineDiagnostic[] };

export function parsePipelineDocument(
  source: string,
  options: ParsePipelineOptions = {},
): ParsePipelineResult {
  const { sourcePath } = options;

  const loaded = loadRestrictedYamlDocument<PipelineDocument>(
    source,
    PipelineDefinitionV1,
    sourcePath !== undefined ? { sourcePath } : {},
  );

  // Collapse first, then attach suggestions: the collapse recognises Ajv's
  // union wording, which `withSuggestion` rewrites into something a person
  // can read.
  const inherited = collapseSchemaViolations(loaded.diagnostics).map(withSuggestion);
  if (!loaded.ok) {
    return { ok: false, diagnostics: sortPipelineDiagnostics(inherited) };
  }

  const reporter = createDiagnosticReporter({
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    resolvePosition: createPositionResolver(source),
  });
  for (const diagnostic of inherited) {
    reporter.add(diagnostic);
  }

  const normalized = normalizePipelineDocument(loaded.value, reporter);
  validatePipelineGraph(normalized, reporter, options);

  const diagnostics = reporter.collect();
  if (hasErrorDiagnostic(diagnostics)) {
    return { ok: false, diagnostics };
  }
  return { ok: true, graph: normalized.graph, diagnostics };
}

/**
 * Resolves a JSON Pointer back to a line and column through the composed YAML
 * document.
 *
 * The document is parsed a second time here — `parseRestrictedYaml` does not
 * hand its AST back, and `@heniek/config` already exposes exactly this
 * re-parse for exactly this purpose. The cost is one extra parse per
 * *document*, not per diagnostic, and it buys the "file, path, line, column"
 * half of every semantic diagnostic. When the source does not compose into a
 * single document the resolver returns `undefined` everywhere rather than
 * fabricating a position — but that case cannot reach here, since a source
 * that failed to compose never produced a value to normalize.
 */
function createPositionResolver(source: string): PositionResolver {
  const composed = parseYamlDocumentForPointerResolution(source);
  if (composed === undefined) {
    return () => undefined;
  }
  return (pointer) => resolvePointer(composed, pointer);
}

/**
 * The composed-document handle, named through the helper's own return type
 * rather than by importing `yaml`'s `Document`/`LineCounter`. `yaml` is
 * `@heniek/config`'s dependency, not this package's, and adding it here to
 * spell two type annotations would make a transitive detail into a declared
 * one.
 */
type ComposedDocument = NonNullable<ReturnType<typeof parseYamlDocumentForPointerResolution>>;

function resolvePointer(composed: ComposedDocument, pointer: string): SourcePosition | undefined {
  // Walks up to the nearest ancestor that exists in the document. A pointer
  // may name a key the author never wrote — `profile` on a stage that is
  // missing one, `delegate_to` on a policy that omitted it — and pointing at
  // the enclosing stage is materially more useful than reporting no position
  // at all for precisely the diagnostics that say "this is missing".
  let current = pointer;
  for (;;) {
    const node: unknown = composed.document.getIn(pointerToPath(current), true);
    const range = hasRange(node) ? node.range : undefined;
    if (range !== null && range !== undefined) {
      const position = composed.lineCounter.linePos(range[0]);
      return { line: position.line, column: position.col };
    }
    const lastSlash = current.lastIndexOf("/");
    if (lastSlash < 0) {
      return undefined;
    }
    current = current.slice(0, lastSlash);
  }
}

function pointerToPath(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function hasRange(node: unknown): node is { range?: readonly [number, number, number] | null } {
  return typeof node === "object" && node !== null && "range" in node;
}
