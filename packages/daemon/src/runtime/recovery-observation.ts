/**
 * Build classified failure + signature observation fields for attempt_failed.
 */

import {
  buildFailureSignature,
  classifyFailure,
  type PipelineFailurePlain,
  type PipelineFailureSignaturePlain,
} from "@heniek/pipeline";
import type { StageRunnerFailure, StageRunnerValidationReport } from "@heniek/runner";

export interface ClassifiedFailureObservation {
  readonly failure: PipelineFailurePlain;
  readonly signature: PipelineFailureSignaturePlain;
  /** Post-policy retryable flag for the observation root. */
  readonly retryable: boolean;
}

function validationFailureCodes(
  validation: StageRunnerValidationReport | undefined,
): readonly string[] | undefined {
  if (validation === undefined || validation.valid) {
    return undefined;
  }
  const codes: string[] = [];
  for (const write of validation.missingWrites) {
    codes.push(`missing_write:${write}`);
  }
  for (const evidence of validation.missingEvidence) {
    codes.push(`missing_evidence:${evidence}`);
  }
  if (!validation.envelopeValid) {
    codes.push("envelope_invalid");
  }
  if (validation.exitCodeAlone) {
    codes.push("exit_code_alone");
  }
  if (codes.length === 0) {
    return undefined;
  }
  return [...codes].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Classify a runner failure for scheduler recovery. Prefers storing the runner
 * retryable flag on `failure.runnerRetryable` and the post-policy flag on
 * `failure.retryable` (also mirrored at the observation root).
 */
export function buildClassifiedFailureObservation(input: {
  readonly runnerFailure: StageRunnerFailure;
  readonly validation?: StageRunnerValidationReport;
}): ClassifiedFailureObservation {
  const backendClassification =
    "backendFailure" in input.runnerFailure &&
    input.runnerFailure.backendFailure !== undefined &&
    typeof input.runnerFailure.backendFailure === "object" &&
    input.runnerFailure.backendFailure !== null &&
    "classification" in input.runnerFailure.backendFailure &&
    typeof (input.runnerFailure.backendFailure as { classification?: unknown }).classification ===
      "string"
      ? (input.runnerFailure.backendFailure as { classification: string }).classification
      : undefined;

  const validationFailures = validationFailureCodes(input.validation);
  const failure = classifyFailure({
    classification: input.runnerFailure.classification,
    phase: input.runnerFailure.phase,
    code: input.runnerFailure.code,
    retryable: input.runnerFailure.retryable,
    ...(backendClassification === undefined ? {} : { backendClassification }),
    ...(validationFailures === undefined ? {} : { validationFailures }),
  });
  const signature = buildFailureSignature(failure);
  return {
    failure,
    signature,
    retryable: failure.retryable,
  };
}
