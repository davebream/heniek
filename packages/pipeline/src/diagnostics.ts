/**
 * The diagnostic record every pipeline reader produces.
 *
 * Structurally `@heniek/config`'s `Diagnostic` plus one field, `suggestion`,
 * and deliberately declared here rather than added to the shared record:
 * `Diagnostic` is embedded verbatim in `ApplicationHome/v1`,
 * `ResolvedConfiguration/v1`, and both `ResolvedProfile` versions, all of
 * which close their shape with `additionalProperties: false`. Widening the
 * shared record would either move four published digests or let a
 * configuration diagnostic carrying a `suggestion` fail validation against
 * the very contract that is supposed to carry it.
 */

import type { Diagnostic, DiagnosticLocation, DiagnosticSeverity } from "@heniek/config";
import { compareDiagnostics, createDiagnostic } from "@heniek/config";

export interface PipelineDiagnostic extends Diagnostic {
  /**
   * What to write instead. Required for every `pipeline.*` code — a
   * diagnostic that names a broken rule without naming the fix makes the
   * reader guess, and the guess is where an authoring session stalls. Codes
   * inherited from the YAML and schema layers get theirs from
   * `suggestions.ts`, so the guarantee holds across the whole surface.
   */
  readonly suggestion?: string;
}

export function createPipelineDiagnostic(
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  location: DiagnosticLocation = {},
  suggestion?: string,
): PipelineDiagnostic {
  const base = createDiagnostic(code, severity, message, location);
  return suggestion !== undefined ? { ...base, suggestion } : base;
}

/**
 * `compareDiagnostics` with `suggestion` as a final tiebreak.
 *
 * The shared comparator does not know the field exists, so two diagnostics
 * differing *only* in their suggestion compare equal and keep whatever order
 * the traversal happened to produce. `Array.prototype.sort` is stable, so
 * that order is reproducible within one run — but "reproducible because the
 * inputs happened to be built in this order" is not the same guarantee as
 * "ordered by content", and the second is the one a byte-compared diagnostic
 * snapshot needs.
 */
export function comparePipelineDiagnostics(a: PipelineDiagnostic, b: PipelineDiagnostic): number {
  const shared = compareDiagnostics(a, b);
  if (shared !== 0) {
    return shared;
  }
  const left = a.suggestion ?? "";
  const right = b.suggestion ?? "";
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** Returns a new array sorted by `comparePipelineDiagnostics`, preserving the element type. */
export function sortPipelineDiagnostics(
  diagnostics: readonly PipelineDiagnostic[],
): readonly PipelineDiagnostic[] {
  return [...diagnostics].sort(comparePipelineDiagnostics);
}

export function hasErrorDiagnostic(diagnostics: readonly PipelineDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

/**
 * Every code this package raises itself. Exported as a closed record rather
 * than as free string literals so the suggestion table, the tests, and the
 * documentation all enumerate the same set — a code with no suggestion, or a
 * suggestion for a code nobody raises, is then a compile or test failure
 * rather than a discovery months later.
 */
export const PIPELINE_DIAGNOSTIC_CODES = {
  duplicateStageId: "pipeline.duplicate-stage-id",
  unknownStageReference: "pipeline.unknown-stage-reference",
  selfEdge: "pipeline.self-edge",
  duplicateEdge: "pipeline.duplicate-edge",
  cycle: "pipeline.cycle",
  noEntryStage: "pipeline.no-entry-stage",
  unreachableStage: "pipeline.unreachable-stage",
  profileRequired: "pipeline.profile-required",
  profileNotAllowed: "pipeline.profile-not-allowed",
  profileNotDeclared: "pipeline.profile-not-declared",
  commandRequired: "pipeline.command-required",
  commandNotAllowed: "pipeline.command-not-allowed",
  expressionInvalid: "pipeline.expression-invalid",
  unknownStateNamespace: "pipeline.unknown-state-namespace",
  writeNotAllowed: "pipeline.write-not-allowed",
  readNotProduced: "pipeline.read-not-produced",
  conflictingWrites: "pipeline.conflicting-writes",
  limitNotStricter: "pipeline.limit-not-stricter",
  repairAttemptsExceedLimit: "pipeline.repair-attempts-exceed-limit",
  delegateTargetRequired: "pipeline.delegate-target-required",
  delegateTargetNotAllowed: "pipeline.delegate-target-not-allowed",
  contextThresholdsInverted: "pipeline.context-thresholds-inverted",
} as const;

export type PipelineDiagnosticCode =
  (typeof PIPELINE_DIAGNOSTIC_CODES)[keyof typeof PIPELINE_DIAGNOSTIC_CODES];
