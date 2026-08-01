/**
 * Shared diagnostic record used across `@heniek/config`'s home resolution,
 * restricted-YAML parsing, schema validation, and configuration-layer
 * resolution (design §2-4). One shape means every consumer of diagnostics —
 * a CLI renderer, a test assertion, a snapshot — only has to understand one
 * record.
 */

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly sourcePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly pointer?: string;
}

/** Optional fields a caller may want to attach to a diagnostic, all omittable. */
export interface DiagnosticLocation {
  readonly sourcePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly pointer?: string;
}

/**
 * Builds a `Diagnostic`, attaching only the location fields that were
 * actually supplied. `exactOptionalPropertyTypes` treats `{ x: undefined }`
 * as distinct from `x` being absent, so the optional fields are added via
 * conditional spread rather than being assigned `undefined` directly —
 * assigning `undefined` would make e.g. `"sourcePath" in diagnostic` true
 * for every diagnostic, including ones with no known source.
 */
export function createDiagnostic(
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  location: DiagnosticLocation = {},
): Diagnostic {
  return {
    code,
    severity,
    message,
    ...(location.sourcePath !== undefined ? { sourcePath: location.sourcePath } : {}),
    ...(location.line !== undefined ? { line: location.line } : {}),
    ...(location.column !== undefined ? { column: location.column } : {}),
    ...(location.pointer !== undefined ? { pointer: location.pointer } : {}),
  };
}

const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Codepoint comparison (`<`/`>`), matching `json.ts`'s key sort
 * (`Object.keys(value).sort()`, which is also codepoint order). `localeCompare`
 * is locale- and ICU-version-dependent — the same two strings can compare
 * differently across Node builds or `Intl` data versions — which is exactly
 * the nondeterminism a "deterministic ordering" helper must not have.
 */
function compareCodepoints(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Deterministic ordering for a diagnostic list: severity first (errors
 * surface before warnings before info), then `code`, then `pointer`
 * (falling back to the empty string so pointer-less diagnostics sort
 * before pointer-bearing ones with the same code), then `line`, then
 * `column`, then `message` as explicit tiebreaks — never insertion/AST-visit
 * order, which would make two equivalent diagnostic sets compare unequal
 * only because they were produced by iterating a `Map`/`Set` in a different
 * runtime, or by a parser visiting nodes in a different order. `line`/`column`
 * fall back to `0` (rather than `-1`) so a position-less diagnostic sorts
 * before one carrying an explicit `line`/`column` of `0`, which YAML's
 * 1-indexed positions never produce.
 */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }
  const codeDelta = compareCodepoints(a.code, b.code);
  if (codeDelta !== 0) {
    return codeDelta;
  }
  const pointerDelta = compareCodepoints(a.pointer ?? "", b.pointer ?? "");
  if (pointerDelta !== 0) {
    return pointerDelta;
  }
  const lineDelta = (a.line ?? 0) - (b.line ?? 0);
  if (lineDelta !== 0) {
    return lineDelta;
  }
  const columnDelta = (a.column ?? 0) - (b.column ?? 0);
  if (columnDelta !== 0) {
    return columnDelta;
  }
  return compareCodepoints(a.message, b.message);
}

/** Returns a new array with `diagnostics` sorted by `compareDiagnostics`. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...diagnostics].sort(compareDiagnostics);
}
