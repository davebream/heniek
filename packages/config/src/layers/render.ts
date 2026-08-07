/**
 * The two outputs a human or a diff looks at: the `ResolvedConfigurationV1`
 * snapshot (design §4, "Freezing") and the human-readable provenance table
 * (design §4, "renderConfigurationDiagnostics").
 *
 * Both run every value through `redactJson` first. A resolved configuration is
 * the single richest collection of user-supplied values in the process, and a
 * snapshot or a diagnostic table is precisely the artefact that gets pasted
 * into a bug report — so redaction happens here, at the boundary where values
 * turn into text, rather than being left to each caller to remember.
 */

import { redactJson } from "@heniek/secrets";
import type { Diagnostic } from "../diagnostics.js";
import { canonicalJsonStringify, type JsonObject, type JsonValue } from "../json.js";
import type { ConfigurationProvenanceEntry, ResolvedConfiguration } from "./merge.js";

/**
 * `redactJson` is typed against `@heniek/secrets`' own structural JSON type.
 * It is the same shape as this package's `JsonValue` — both are the closed
 * plain-JSON family — but they are nominally separate declarations in separate
 * packages, so the result is re-typed once here instead of at every call site.
 */
function redactValue(value: JsonValue): JsonValue {
  return redactJson(value) as JsonValue;
}

function diagnosticToJson(diagnostic: Diagnostic): JsonObject {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.sourcePath !== undefined ? { sourcePath: diagnostic.sourcePath } : {}),
    ...(diagnostic.line !== undefined ? { line: diagnostic.line } : {}),
    ...(diagnostic.column !== undefined ? { column: diagnostic.column } : {}),
    ...(diagnostic.pointer !== undefined ? { pointer: diagnostic.pointer } : {}),
  };
}

function overriddenToJson(entry: ConfigurationProvenanceEntry): JsonObject {
  return {
    layer: entry.layer,
    ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}),
    value: redactValue(entry.value),
  };
}

/**
 * Projects a `ResolvedConfiguration` onto the `ResolvedConfigurationV1`
 * contract shape. Key order is irrelevant to the result's identity, because
 * `canonicalJsonStringify` sorts keys at every level — two resolutions that
 * differ only in the order their documents happened to introduce keys
 * serialise byte-identically, which is what makes the snapshot usable as a
 * diff target and as the issue's "resolved-config diagnostic snapshot"
 * evidence.
 */
export function toResolvedConfigurationSnapshot(resolved: ResolvedConfiguration): JsonObject {
  return {
    layers: [...resolved.layers],
    values: redactValue(resolved.values) as JsonObject,
    provenance: resolved.provenance.map((record) => ({
      pointer: record.pointer,
      layer: record.layer,
      ...(record.sourcePath !== undefined ? { sourcePath: record.sourcePath } : {}),
      value: redactValue(record.value),
      overridden: record.overridden.map(overriddenToJson),
    })),
    diagnostics: resolved.diagnostics.map(diagnosticToJson),
  };
}

/** The snapshot as canonical, key-sorted JSON text with a trailing newline. */
export function renderResolvedConfigurationSnapshot(resolved: ResolvedConfiguration): string {
  return canonicalJsonStringify(toResolvedConfigurationSnapshot(resolved));
}

function renderValue(value: JsonValue): string {
  return JSON.stringify(redactValue(value)) ?? "undefined";
}

function renderSource(layer: string, sourcePath: string | undefined): string {
  return sourcePath === undefined ? layer : `${layer} (${sourcePath})`;
}

/**
 * Renders the provenance table AC2 asks for: for every leaf, the winning
 * value, the layer that supplied it, and the layers it overrode — followed by
 * the diagnostics, which is where a material conflict, a clamped hard limit,
 * a blocked privacy weakening, and a rejected override are each named.
 *
 * Plain aligned text rather than a box-drawing table: the output's job is to
 * be readable in a terminal *and* to paste cleanly into an issue, and the
 * column widths are derived from the content so a long pointer does not
 * silently truncate.
 */
export function renderConfigurationDiagnostics(resolved: ResolvedConfiguration): string {
  const lines: string[] = [];

  if (resolved.provenance.length === 0) {
    lines.push("(no configuration values)");
  } else {
    const pointerWidth = Math.max(...resolved.provenance.map((record) => record.pointer.length));
    lines.push("Resolved configuration:");
    for (const record of resolved.provenance) {
      const pointer = record.pointer.padEnd(pointerWidth);
      lines.push(
        `  ${pointer}  ${renderValue(record.value)}  [${renderSource(record.layer, record.sourcePath)}]`,
      );
      for (const entry of record.overridden) {
        lines.push(
          `  ${" ".repeat(pointerWidth)}    overrode ${renderValue(entry.value)} [${renderSource(entry.layer, entry.sourcePath)}]`,
        );
      }
    }
  }

  if (resolved.diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of resolved.diagnostics) {
      lines.push(`  ${diagnostic.severity}  ${diagnostic.code}  ${diagnostic.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
