/**
 * Incoming verification before a capsule-backed fresh segment starts (§15.5).
 *
 * Checks schema/digest, required artifacts, named context files, HEAD and
 * sorted dirty-file set, durable completion claims, and optional cheap checks.
 * Failures record typed blockers and never mutate the repository.
 */

import {
  type CapsuleArtifactRef,
  type CapsuleContextFileRef,
  type CapsuleRepositoryHead,
  type PipelineContinuationCapsulePlain,
  verifyCapsuleDigest,
} from "./capsule.js";
import { deriveVerificationId } from "./ids.js";

export type IncomingVerificationBlocker =
  | "schema_invalid"
  | "digest_mismatch"
  | "missing_artifact"
  | "artifact_hash_mismatch"
  | "missing_context_file"
  | "context_file_hash_mismatch"
  | "stale_head"
  | "dirty_set_mismatch"
  | "contradictory_completion"
  | "cheap_check_failed"
  | "tampered_capsule";

export interface ObservedArtifact {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly exists: boolean;
}

export interface ObservedContextFile {
  readonly path: string;
  readonly exists: boolean;
  readonly contentHash?: string;
}

export interface VerifyIncomingInput {
  readonly capsule: PipelineContinuationCapsulePlain;
  readonly observedHeads: readonly CapsuleRepositoryHead[];
  readonly observedDirtyFiles: readonly string[];
  readonly observedArtifacts: readonly ObservedArtifact[];
  readonly observedContextFiles: readonly ObservedContextFile[];
  /** When true, durable stage completion claims contradict the capsule. */
  readonly contradictoryCompletion?: boolean;
  /** Result of `git diff --check` (or equivalent); false blocks. */
  readonly cheapChecksPassed?: boolean;
  readonly segmentId?: string;
  readonly recordedAt: string;
}

export interface PipelineIncomingVerificationPlain {
  readonly schemaVersion: 1;
  readonly verificationId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly segmentId?: string;
  readonly verdict: "pass" | "block";
  readonly blockers: readonly IncomingVerificationBlocker[];
  readonly observedHeads: readonly CapsuleRepositoryHead[];
  readonly observedDirtyFiles: readonly string[];
  readonly detail?: string;
  readonly recordedAt: string;
}

function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sameSorted(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function headMap(heads: readonly CapsuleRepositoryHead[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const head of heads) {
    map.set(head.repositoryId, head.head);
  }
  return map;
}

function checkArtifacts(
  required: readonly CapsuleArtifactRef[],
  observed: readonly ObservedArtifact[],
): IncomingVerificationBlocker[] {
  const blockers: IncomingVerificationBlocker[] = [];
  const byId = new Map(observed.map((entry) => [entry.artifactId, entry]));
  for (const ref of required) {
    const found = byId.get(ref.artifactId);
    if (found === undefined || !found.exists) {
      blockers.push("missing_artifact");
      continue;
    }
    if (found.contentHash !== ref.contentHash) {
      blockers.push("artifact_hash_mismatch");
    }
  }
  return blockers;
}

function checkContextFiles(
  required: readonly CapsuleContextFileRef[],
  observed: readonly ObservedContextFile[],
): IncomingVerificationBlocker[] {
  const blockers: IncomingVerificationBlocker[] = [];
  const byPath = new Map(observed.map((entry) => [entry.path, entry]));
  for (const ref of required) {
    const found = byPath.get(ref.path);
    if (found === undefined || !found.exists) {
      blockers.push("missing_context_file");
      continue;
    }
    if (ref.contentHash !== undefined && found.contentHash !== ref.contentHash) {
      blockers.push("context_file_hash_mismatch");
    }
  }
  return blockers;
}

/**
 * Verify that the live workspace and artifact store match the capsule before
 * starting a fresh continuation segment.
 */
export function verifyIncomingContinuation(
  input: VerifyIncomingInput,
): PipelineIncomingVerificationPlain {
  const blockers: IncomingVerificationBlocker[] = [];
  const capsule = input.capsule;

  if (capsule.schemaVersion !== 1) {
    blockers.push("schema_invalid");
  }
  if (!verifyCapsuleDigest(capsule)) {
    blockers.push("digest_mismatch");
    blockers.push("tampered_capsule");
  }

  const expectedHeads = headMap(capsule.repositoryHeads);
  const observedHeads = headMap(input.observedHeads);
  for (const [repositoryId, head] of expectedHeads) {
    if (observedHeads.get(repositoryId) !== head) {
      blockers.push("stale_head");
      break;
    }
  }

  const expectedDirty = sortPaths(capsule.dirtyFiles);
  const observedDirty = sortPaths(input.observedDirtyFiles);
  if (!sameSorted(expectedDirty, observedDirty)) {
    blockers.push("dirty_set_mismatch");
  }

  blockers.push(...checkArtifacts(capsule.artifactRefs, input.observedArtifacts));
  blockers.push(...checkContextFiles(capsule.contextFileRefs, input.observedContextFiles));

  if (input.contradictoryCompletion === true) {
    blockers.push("contradictory_completion");
  }
  if (input.cheapChecksPassed === false) {
    blockers.push("cheap_check_failed");
  }

  const uniqueBlockers = [...new Set(blockers)];
  const verification: PipelineIncomingVerificationPlain = {
    schemaVersion: 1,
    verificationId: deriveVerificationId({
      capsuleId: capsule.capsuleId,
      recordedAt: input.recordedAt,
    }),
    capsuleId: capsule.capsuleId,
    runId: capsule.runId,
    verdict: uniqueBlockers.length === 0 ? "pass" : "block",
    blockers: uniqueBlockers,
    observedHeads: input.observedHeads,
    observedDirtyFiles: observedDirty,
    recordedAt: input.recordedAt,
  };
  if (input.segmentId !== undefined) {
    (verification as { segmentId?: string }).segmentId = input.segmentId;
  }
  if (uniqueBlockers.length > 0) {
    (verification as { detail?: string }).detail = `blocked:${uniqueBlockers.join(",")}`;
  }
  return verification;
}
