/**
 * The three textual forms of a parse result: the canonical graph JSON, the
 * `PipelineValidationResult/v1` snapshot, and the human-readable diagnostic
 * listing.
 *
 * All three run their input through `redactJson` first, for the same reason
 * `@heniek/config`'s renderer does: these are precisely the artefacts that
 * get pasted into an issue, checked into an evidence directory, or printed to
 * a terminal someone is screen-sharing. Redacting at the one boundary where
 * values become text is the only version of this that cannot be forgotten by
 * a future caller.
 */

import type { JsonObject, JsonValue } from "@heniek/config";
import { canonicalJsonStringify } from "@heniek/config";
import { redactJson } from "@heniek/secrets";
import type { PipelineDiagnostic } from "./diagnostics.js";
import type { PipelineGraph } from "./document.js";
import type { ParsePipelineResult } from "./parse.js";

function redact(value: unknown): JsonValue {
  return redactJson(value as never) as JsonValue;
}

/**
 * The graph as canonical, key-sorted JSON text with a trailing newline. Two
 * documents that mean the same thing produce the same bytes here — that is
 * the whole point of the normalizer, and this is where it becomes checkable.
 */
export function renderPipelineGraph(graph: PipelineGraph): string {
  return canonicalJsonStringify(redact(graph));
}

function diagnosticToJson(diagnostic: PipelineDiagnostic): JsonObject {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.sourcePath !== undefined ? { sourcePath: diagnostic.sourcePath } : {}),
    ...(diagnostic.line !== undefined ? { line: diagnostic.line } : {}),
    ...(diagnostic.column !== undefined ? { column: diagnostic.column } : {}),
    ...(diagnostic.pointer !== undefined ? { pointer: diagnostic.pointer } : {}),
    ...(diagnostic.suggestion !== undefined ? { suggestion: diagnostic.suggestion } : {}),
  };
}

/**
 * Projects a parse result onto the `PipelineValidationResult/v1` contract
 * shape. `graph` is present exactly when the parse succeeded, so a consumer
 * never has to decide whether a partially-built graph is safe to use.
 */
export function toPipelineValidationResult(
  result: ParsePipelineResult,
  sourcePath?: string,
): JsonObject {
  return {
    schemaVersion: 1,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(result.ok ? { graph: redact(result.graph) as JsonObject } : {}),
    diagnostics: result.diagnostics.map(diagnosticToJson),
  };
}

/** The validation result as canonical JSON text — the checked-in diagnostic corpus format. */
export function renderPipelineValidationResult(
  result: ParsePipelineResult,
  sourcePath?: string,
): string {
  return canonicalJsonStringify(toPipelineValidationResult(result, sourcePath));
}

/**
 * The listing a person reads: one `file:line:column severity code` header per
 * diagnostic, the message, and the correction indented beneath it.
 *
 * Plain text rather than a box-drawn table, matching the configuration
 * renderer's reasoning: it has to read well in a terminal *and* paste cleanly
 * into an issue, and a suggestion is often a full sentence or a caret excerpt
 * that no fixed column width survives.
 */
export function renderPipelineDiagnostics(diagnostics: readonly PipelineDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No diagnostics.\n";
  }

  const lines: string[] = [];
  for (const diagnostic of diagnostics) {
    lines.push(`${formatLocation(diagnostic)}  ${diagnostic.severity}  ${diagnostic.code}`);
    lines.push(`  ${diagnostic.message}`);
    if (diagnostic.pointer !== undefined && diagnostic.pointer !== "") {
      lines.push(`  at ${diagnostic.pointer}`);
    }
    if (diagnostic.suggestion !== undefined) {
      for (const line of diagnostic.suggestion.split("\n")) {
        lines.push(`  → ${line}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatLocation(diagnostic: PipelineDiagnostic): string {
  const path = diagnostic.sourcePath ?? "<pipeline>";
  if (diagnostic.line === undefined) {
    return path;
  }
  return diagnostic.column === undefined
    ? `${path}:${diagnostic.line}`
    : `${path}:${diagnostic.line}:${diagnostic.column}`;
}
