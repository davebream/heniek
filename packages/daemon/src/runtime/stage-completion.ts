/**
 * The one place a stage becomes terminally successful.
 *
 * Q023's constraint is that "native results pass the same stage contract as
 * external execution". Before this file there was no single such path — and
 * worse, the two that existed did not agree. `ExecutionService.finalizeSuccess`
 * validated the backend's terminal result against `ExternalStageResult/v1`
 * before publishing; `SchedulingService.finishTerminal` checked the artifact's
 * length and digest but never validated the result at all, so a scheduled run
 * could complete on a summary the contract would have rejected.
 *
 * Making the native bridge a third caller would have made that two-out-of-three.
 * Extracting the sequence instead makes the constraint true by construction:
 * there is one implementation of "validate the declared result, verify the
 * bytes are what they claimed to be, publish, and complete", and all three
 * execution paths call it.
 *
 * The order of the checks is load-bearing and is not an accident of the
 * original code:
 *
 * 1. the *result* is validated before anything is written, so a malformed
 *    summary never reaches the artifact store;
 * 2. the byte length and digest are re-verified against what the producer
 *    declared, so a source that changed the file between describing it and
 *    handing it over is caught rather than trusted;
 * 3. only then is the blob published and the stage completed, in that order,
 *    because `completeStage` refuses to mint an artifact row for a blob no
 *    one published.
 *
 * The two hooks exist for the import-bookkeeping the external path keeps
 * around this sequence (`markArtifactImport` pending → completed) and for its
 * crash fault-injection point. They are deliberately narrow: a caller can
 * observe the publication, not alter it.
 */

import { createHash } from "node:crypto";
import { ExternalStageResultV1 } from "@heniek/contracts";
import {
  type ArtifactPublicationReceipt,
  type ArtifactStore,
  completeStage,
  publishArtifact,
  type StateDatabase,
} from "@heniek/state";
import { Value } from "@sinclair/typebox/value";

/** The contract id every stage artifact is recorded under, native or external. */
export const STAGE_RESULT_CONTENT_SCHEMA_ID = "heniek://contract/ExternalStageResult/v1";

export class StageResultContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageResultContractError";
  }
}

export interface StageCompletionInput {
  readonly runId: string;
  readonly stageId: string;
  /** The producer's terminal summary, validated before anything is written. */
  readonly summary: string;
  /** The declared, worktree-relative artifact path. */
  readonly artifactPath: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly contentSchemaId?: string;
  /** Which subsystem produced this — recorded on the artifact row. */
  readonly producer: string;
  readonly sourceLineage: readonly string[];
  /**
   * What the producer *said* the artifact was. Optional because not every
   * source describes its bytes before handing them over — the native bridge
   * reads the file itself, so there is no earlier description to disagree
   * with. When present, both are re-verified.
   */
  readonly declaredByteLength?: number;
  readonly declaredSha256?: string;
  readonly onPublished?: (receipt: ArtifactPublicationReceipt, contentHash: string) => void;
  readonly onCompleted?: (receipt: ArtifactPublicationReceipt, contentHash: string) => void;
}

export interface StageCompletionOutcome {
  readonly receipt: ArtifactPublicationReceipt;
  readonly contentHash: string;
  readonly byteLength: number;
}

/**
 * Pure contract check on a stage's declared result envelope. Attachment and
 * finalize share this so an unvalidated summary never becomes an alias target.
 */
export function validateStageResultContract(summary: string, artifactPath: string): void {
  if (
    !Value.Check(ExternalStageResultV1, {
      schemaVersion: 1,
      summary,
      artifactPath,
    })
  ) {
    throw new StageResultContractError("terminal result does not satisfy ExternalStageResult/v1");
  }
}

export function finalizeStageArtifact(
  db: StateDatabase,
  artifactStore: ArtifactStore,
  input: StageCompletionInput,
): StageCompletionOutcome {
  validateStageResultContract(input.summary, input.artifactPath);

  if (
    input.declaredByteLength !== undefined &&
    input.bytes.byteLength !== input.declaredByteLength
  ) {
    throw new StageResultContractError(
      "artifact byte length changed between description and retrieval",
    );
  }

  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  if (input.declaredSha256 !== undefined && input.declaredSha256 !== contentHash) {
    throw new StageResultContractError("artifact digest does not match its descriptor");
  }

  const receipt = publishArtifact(artifactStore, {
    bytes: input.bytes,
    expectedContentHash: contentHash,
  });
  input.onPublished?.(receipt, contentHash);

  completeStage(db, artifactStore, {
    runId: input.runId,
    stageId: input.stageId,
    terminalRunStatus: "succeeded",
    artifacts: [
      {
        receipt,
        name: input.artifactPath,
        mediaType: input.mediaType,
        contentSchemaId: input.contentSchemaId ?? STAGE_RESULT_CONTENT_SCHEMA_ID,
        producer: input.producer,
        sourceLineage: [...input.sourceLineage],
      },
    ],
  });
  input.onCompleted?.(receipt, contentHash);

  return { receipt, contentHash, byteLength: input.bytes.byteLength };
}
