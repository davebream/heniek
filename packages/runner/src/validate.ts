/**
 * §19.5 completion validation for stage runners.
 *
 * Exit code alone never authorizes success. Verdict requirements only consume
 * already-recorded verdict evidence (Q026 does not invoke verify-stage).
 */

import {
  ExternalStageResultV1,
  type StageRunnerEvidenceV1,
  type StageRunnerOutputBindingV1,
  type StageRunnerValidationReportV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { asAttemptId } from "./brands.js";
import type { StageCompletionRequirement } from "./types.js";

export type StageRunnerEvidence = Static<typeof StageRunnerEvidenceV1>;
export type StageRunnerOutputBinding = Static<typeof StageRunnerOutputBindingV1>;
export type StageRunnerValidationReport = Static<typeof StageRunnerValidationReportV1>;

export interface ValidateStageCompletionInput {
  readonly attemptId: string;
  readonly writes: readonly string[];
  readonly requirements: readonly StageCompletionRequirement[];
  readonly outputs: readonly StageRunnerOutputBinding[];
  readonly evidence: readonly StageRunnerEvidence[];
  readonly resultEnvelope: unknown | undefined;
  readonly exitCode: number | undefined;
  readonly recordedAt: string;
}

function requirementKey(requirement: StageCompletionRequirement): string {
  switch (requirement.kind) {
    case "result_envelope":
      return "result_envelope";
    case "non_empty_diff":
      return "non_empty_diff";
    case "artifact":
      return `artifact:${requirement.name}`;
    case "schema_check":
      return `schema_check:${requirement.name}`;
    case "sections":
      return `sections:${requirement.names.join(",")}`;
    case "command":
      return `command:${requirement.argv.join("\0")}`;
    case "repository_state":
      return `repository_state:${requirement.state}`;
    case "verdict":
      return `verdict:${requirement.profile}`;
    default: {
      const _exhaustive: never = requirement;
      return String(_exhaustive);
    }
  }
}

function evidenceMatches(
  requirement: StageCompletionRequirement,
  evidence: StageRunnerEvidence,
): boolean {
  if (!evidence.satisfied) return false;
  switch (requirement.kind) {
    case "result_envelope":
      return evidence.kind === "result_envelope";
    case "non_empty_diff":
      return evidence.kind === "non_empty_diff";
    case "artifact":
      return (
        evidence.kind === "artifact" &&
        (evidence.requirement === requirement.name ||
          evidence.requirement === `artifact:${requirement.name}`)
      );
    case "schema_check":
      return (
        evidence.kind === "schema_check" &&
        (evidence.requirement === requirement.name ||
          evidence.requirement === `schema_check:${requirement.name}`)
      );
    case "sections":
      return evidence.kind === "sections";
    case "command":
      return evidence.kind === "command";
    case "repository_state":
      return evidence.kind === "repository_state";
    case "verdict":
      // Verdict evidence is consumed only when already recorded — never minted here.
      return (
        evidence.kind === "verdict" &&
        (evidence.requirement === requirement.profile ||
          evidence.requirement === `verdict:${requirement.profile}`)
      );
    default: {
      const _exhaustive: never = requirement;
      return Boolean(_exhaustive);
    }
  }
}

function isExternalStageResult(value: unknown): boolean {
  return Value.Check(ExternalStageResultV1, value);
}

/**
 * Validates collected outputs/evidence against declared writes and completion
 * requirements. Exit-code-only evidence can never produce `valid: true`.
 */
export function validateStageCompletion(
  input: ValidateStageCompletionInput,
): StageRunnerValidationReport {
  const outputRefs = new Set(input.outputs.map((binding) => binding.reference));
  const missingWrites = input.writes.filter((write) => !outputRefs.has(write));

  const requiresEnvelope = input.requirements.some((req) => req.kind === "result_envelope");
  let envelopeValid = true;
  if (requiresEnvelope) {
    envelopeValid = isExternalStageResult(input.resultEnvelope);
  } else if (input.resultEnvelope !== undefined) {
    envelopeValid = isExternalStageResult(input.resultEnvelope);
  }

  const missingEvidence: string[] = [];
  for (const requirement of input.requirements) {
    const matched = input.evidence.some((item) => evidenceMatches(requirement, item));
    if (!matched) {
      missingEvidence.push(requirementKey(requirement));
      continue;
    }
    if (requirement.kind === "result_envelope" && !envelopeValid) {
      const key = requirementKey(requirement);
      if (!missingEvidence.includes(key)) missingEvidence.push(key);
    }
  }

  const onlyExitEvidence =
    input.evidence.length > 0 && input.evidence.every((item) => item.kind === "exit_code");

  // Exit code alone can never produce success — even when exitCode === 0.
  const exitCodeAlone = onlyExitEvidence;
  const valid =
    !exitCodeAlone &&
    missingWrites.length === 0 &&
    missingEvidence.length === 0 &&
    envelopeValid &&
    (input.requirements.length > 0 || input.writes.length > 0
      ? input.evidence.some((item) => item.kind !== "exit_code" && item.satisfied)
      : input.evidence.some((item) => item.satisfied && item.kind !== "exit_code"));

  return {
    schemaVersion: 1,
    attemptId: asAttemptId(input.attemptId),
    valid,
    missingWrites: [...missingWrites],
    missingEvidence: [...missingEvidence],
    envelopeValid,
    exitCodeAlone,
    recordedAt: input.recordedAt,
    ...(valid
      ? {}
      : {
          detail: exitCodeAlone
            ? "exit code alone is not sufficient evidence for stage success"
            : "stage completion requirements were not satisfied",
        }),
  };
}
