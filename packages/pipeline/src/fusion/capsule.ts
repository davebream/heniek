/**
 * Continuation capsule builder (§15.4).
 *
 * Capsules contain exact coordinates, plan state, Git witnesses, artifact/
 * context references with hashes, decision/question/risk refs, telemetry
 * cursor, and outgoing session identity. Narrative text is bounded; required
 * artifact references and exact continuation state never drop — overflow
 * there is a typed blocker.
 */

import { createHash } from "node:crypto";
import { canonicalStringify, type JsonValue } from "./canonical.js";
import { deriveCapsuleId } from "./ids.js";

export const CONTINUATION_NARRATIVE_MAX_BYTES = 32 * 1024;
export const CONTINUATION_DESCRIPTION_MAX_BYTES = 1024;
export const CONTINUATION_REFERENCE_COLLECTION_MAX = 64;
export const CONTINUATION_PLAN_ITEMS_MAX = 256;

export interface CapsuleArtifactRef {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly name?: string;
}

export interface CapsuleContextFileRef {
  readonly path: string;
  readonly contentHash?: string;
}

export interface CapsuleRepositoryHead {
  readonly repositoryId: string;
  readonly head: string;
}

export interface BuildCapsuleInput {
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly segmentId: string;
  readonly segmentOrdinal: number;
  readonly completedPlanItems: readonly string[];
  readonly activePlanItem?: string;
  readonly remainingPlanItems?: readonly string[];
  readonly nextAction: string;
  readonly repositoryHeads: readonly CapsuleRepositoryHead[];
  readonly dirtyFiles: readonly string[];
  readonly artifactRefs: readonly CapsuleArtifactRef[];
  readonly contextFileRefs: readonly CapsuleContextFileRef[];
  readonly decisionIds: readonly string[];
  readonly unresolvedQuestionIds: readonly string[];
  readonly riskRefs: readonly string[];
  readonly telemetryCursor?: string;
  readonly outgoingSessionId: string;
  readonly narrativeMarkdown?: string;
  readonly createdAt: string;
}

export interface PipelineContinuationCapsulePlain {
  readonly schemaVersion: 1;
  readonly capsuleId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly segmentId: string;
  readonly segmentOrdinal: number;
  readonly completedPlanItems: readonly string[];
  readonly activePlanItem?: string;
  readonly remainingPlanItems?: readonly string[];
  readonly nextAction: string;
  readonly repositoryHeads: readonly CapsuleRepositoryHead[];
  readonly dirtyFiles: readonly string[];
  readonly artifactRefs: readonly CapsuleArtifactRef[];
  readonly contextFileRefs: readonly CapsuleContextFileRef[];
  readonly decisionIds: readonly string[];
  readonly unresolvedQuestionIds: readonly string[];
  readonly riskRefs: readonly string[];
  readonly telemetryCursor?: string;
  readonly outgoingSessionId: string;
  readonly narrativeDigest?: string;
  readonly omittedNarrativeBytes?: number;
  readonly omittedDescriptionCount?: number;
  readonly digest: string;
  readonly createdAt: string;
}

export type BuildCapsuleResult =
  | {
      readonly ok: true;
      readonly capsule: PipelineContinuationCapsulePlain;
      readonly narrative: string;
    }
  | {
      readonly ok: false;
      readonly blocker:
        | "artifact_refs_overflow"
        | "plan_items_overflow"
        | "required_state_overflow"
        | "empty_next_action"
        | "empty_outgoing_session";
      readonly detail: string;
    };

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Truncate narrative deterministically to maxBytes, appending an omission
 * marker when bytes were dropped. Returns the truncated text and omitted count.
 */
export function truncateNarrative(
  narrative: string,
  maxBytes: number = CONTINUATION_NARRATIVE_MAX_BYTES,
): { readonly text: string; readonly omittedBytes: number } {
  const total = utf8ByteLength(narrative);
  if (total <= maxBytes) {
    return { text: narrative, omittedBytes: 0 };
  }
  const marker = `\n\n[…omitted ${total - maxBytes} bytes]\n`;
  const markerBytes = utf8ByteLength(marker);
  const budget = Math.max(0, maxBytes - markerBytes);
  // Walk code units carefully so we never split a multi-byte UTF-8 sequence.
  let end = 0;
  let used = 0;
  for (const char of narrative) {
    const size = utf8ByteLength(char);
    if (used + size > budget) {
      break;
    }
    used += size;
    end += char.length;
  }
  return {
    text: `${narrative.slice(0, end)}${marker}`,
    omittedBytes: total - used,
  };
}

/**
 * Bound a description string; returns truncated text and whether truncation
 * occurred. Empty after trim is rejected by the caller.
 */
export function truncateDescription(
  value: string,
  maxBytes: number = CONTINUATION_DESCRIPTION_MAX_BYTES,
): { readonly text: string; readonly truncated: boolean } {
  if (utf8ByteLength(value) <= maxBytes) {
    return { text: value, truncated: false };
  }
  let end = 0;
  let used = 0;
  for (const char of value) {
    const size = utf8ByteLength(char);
    if (used + size > maxBytes) {
      break;
    }
    used += size;
    end += char.length;
  }
  return { text: value.slice(0, end), truncated: true };
}

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function boundCollection<T>(
  values: readonly T[],
  max: number,
): { readonly items: readonly T[]; readonly overflow: boolean } {
  if (values.length <= max) {
    return { items: values, overflow: false };
  }
  return { items: values.slice(0, max), overflow: true };
}

function capsulePayloadForDigest(
  capsule: Omit<PipelineContinuationCapsulePlain, "digest">,
): JsonValue {
  const payload: { [key: string]: JsonValue } = {
    schemaVersion: capsule.schemaVersion,
    capsuleId: capsule.capsuleId,
    runId: capsule.runId,
    stageId: capsule.stageId,
    attemptId: capsule.attemptId,
    segmentId: capsule.segmentId,
    segmentOrdinal: capsule.segmentOrdinal,
    completedPlanItems: [...capsule.completedPlanItems],
    nextAction: capsule.nextAction,
    repositoryHeads: capsule.repositoryHeads.map((head) => ({
      repositoryId: head.repositoryId,
      head: head.head,
    })),
    dirtyFiles: [...capsule.dirtyFiles],
    artifactRefs: capsule.artifactRefs.map((ref) => {
      const entry: { [key: string]: JsonValue } = {
        artifactId: ref.artifactId,
        contentHash: ref.contentHash,
      };
      if (ref.name !== undefined) {
        entry.name = ref.name;
      }
      return entry;
    }),
    contextFileRefs: capsule.contextFileRefs.map((ref) => {
      const entry: { [key: string]: JsonValue } = { path: ref.path };
      if (ref.contentHash !== undefined) {
        entry.contentHash = ref.contentHash;
      }
      return entry;
    }),
    decisionIds: [...capsule.decisionIds],
    unresolvedQuestionIds: [...capsule.unresolvedQuestionIds],
    riskRefs: [...capsule.riskRefs],
    outgoingSessionId: capsule.outgoingSessionId,
    createdAt: capsule.createdAt,
  };
  if (capsule.activePlanItem !== undefined) {
    payload.activePlanItem = capsule.activePlanItem;
  }
  if (capsule.remainingPlanItems !== undefined) {
    payload.remainingPlanItems = [...capsule.remainingPlanItems];
  }
  if (capsule.telemetryCursor !== undefined) {
    payload.telemetryCursor = capsule.telemetryCursor;
  }
  if (capsule.narrativeDigest !== undefined) {
    payload.narrativeDigest = capsule.narrativeDigest;
  }
  if (capsule.omittedNarrativeBytes !== undefined) {
    payload.omittedNarrativeBytes = capsule.omittedNarrativeBytes;
  }
  if (capsule.omittedDescriptionCount !== undefined) {
    payload.omittedDescriptionCount = capsule.omittedDescriptionCount;
  }
  return payload;
}

export function digestCapsulePayload(
  capsule: Omit<PipelineContinuationCapsulePlain, "digest">,
): string {
  return createHash("sha256")
    .update(canonicalStringify(capsulePayloadForDigest(capsule)), "utf8")
    .digest("hex");
}

/**
 * Build a validated capsule. Required artifact refs and plan coordinates must
 * fit bounds; narrative may truncate with an omitted-byte count.
 */
export function buildContinuationCapsule(input: BuildCapsuleInput): BuildCapsuleResult {
  const nextActionRaw = input.nextAction.trim();
  if (nextActionRaw.length === 0) {
    return { ok: false, blocker: "empty_next_action", detail: "nextAction is required" };
  }
  if (input.outgoingSessionId.trim().length === 0) {
    return {
      ok: false,
      blocker: "empty_outgoing_session",
      detail: "outgoingSessionId is required",
    };
  }

  const completed = boundCollection(input.completedPlanItems, CONTINUATION_PLAN_ITEMS_MAX);
  const remaining =
    input.remainingPlanItems === undefined
      ? undefined
      : boundCollection(input.remainingPlanItems, CONTINUATION_PLAN_ITEMS_MAX);
  if (completed.overflow || remaining?.overflow) {
    return {
      ok: false,
      blocker: "plan_items_overflow",
      detail: `plan items exceed ${CONTINUATION_PLAN_ITEMS_MAX}`,
    };
  }

  const artifacts = boundCollection(input.artifactRefs, CONTINUATION_REFERENCE_COLLECTION_MAX);
  if (artifacts.overflow) {
    return {
      ok: false,
      blocker: "artifact_refs_overflow",
      detail: `artifactRefs exceed ${CONTINUATION_REFERENCE_COLLECTION_MAX}`,
    };
  }

  const heads = boundCollection(input.repositoryHeads, CONTINUATION_REFERENCE_COLLECTION_MAX);
  const dirty = boundCollection(
    sortUnique(input.dirtyFiles),
    CONTINUATION_REFERENCE_COLLECTION_MAX,
  );
  const contextFiles = boundCollection(
    input.contextFileRefs,
    CONTINUATION_REFERENCE_COLLECTION_MAX,
  );
  const decisions = boundCollection(
    sortUnique(input.decisionIds),
    CONTINUATION_REFERENCE_COLLECTION_MAX,
  );
  const questions = boundCollection(
    sortUnique(input.unresolvedQuestionIds),
    CONTINUATION_REFERENCE_COLLECTION_MAX,
  );
  const risks = boundCollection(sortUnique(input.riskRefs), CONTINUATION_REFERENCE_COLLECTION_MAX);

  // Dirty / heads / decision / question / risk overflows are reference
  // collections — truncate with omission is allowed only for narrative and
  // descriptions. Exact continuation state (active plan + next action +
  // artifacts) already gated above. For heads/dirty we still require fit:
  // a truncated dirty set would lie about workspace reality.
  if (
    heads.overflow ||
    dirty.overflow ||
    contextFiles.overflow ||
    decisions.overflow ||
    questions.overflow ||
    risks.overflow
  ) {
    return {
      ok: false,
      blocker: "required_state_overflow",
      detail: "a required witness or reference collection exceeded its bound",
    };
  }

  let omittedDescriptionCount = 0;
  const nextAction = truncateDescription(nextActionRaw);
  if (nextAction.truncated) {
    omittedDescriptionCount += 1;
  }

  const narrativeSource = input.narrativeMarkdown ?? "";
  const narrative = truncateNarrative(narrativeSource);
  const narrativeDigest =
    narrative.text.length === 0
      ? undefined
      : createHash("sha256").update(narrative.text, "utf8").digest("hex");

  const capsuleId = deriveCapsuleId({
    runId: input.runId,
    stageId: input.stageId,
    attemptId: input.attemptId,
    segmentId: input.segmentId,
    segmentOrdinal: input.segmentOrdinal,
  });

  const withoutDigest: Omit<PipelineContinuationCapsulePlain, "digest"> = {
    schemaVersion: 1,
    capsuleId,
    runId: input.runId,
    stageId: input.stageId,
    attemptId: input.attemptId,
    segmentId: input.segmentId,
    segmentOrdinal: input.segmentOrdinal,
    completedPlanItems: completed.items,
    nextAction: nextAction.text,
    repositoryHeads: heads.items,
    dirtyFiles: dirty.items,
    artifactRefs: artifacts.items,
    contextFileRefs: contextFiles.items,
    decisionIds: decisions.items,
    unresolvedQuestionIds: questions.items,
    riskRefs: risks.items,
    outgoingSessionId: input.outgoingSessionId,
    createdAt: input.createdAt,
  };
  if (input.activePlanItem !== undefined) {
    (withoutDigest as { activePlanItem?: string }).activePlanItem = input.activePlanItem;
  }
  if (remaining !== undefined) {
    (withoutDigest as { remainingPlanItems?: readonly string[] }).remainingPlanItems =
      remaining.items;
  }
  if (input.telemetryCursor !== undefined) {
    (withoutDigest as { telemetryCursor?: string }).telemetryCursor = input.telemetryCursor;
  }
  if (narrativeDigest !== undefined) {
    (withoutDigest as { narrativeDigest?: string }).narrativeDigest = narrativeDigest;
  }
  if (narrative.omittedBytes > 0) {
    (withoutDigest as { omittedNarrativeBytes?: number }).omittedNarrativeBytes =
      narrative.omittedBytes;
  }
  if (omittedDescriptionCount > 0) {
    (withoutDigest as { omittedDescriptionCount?: number }).omittedDescriptionCount =
      omittedDescriptionCount;
  }

  const digest = digestCapsulePayload(withoutDigest);
  return {
    ok: true,
    capsule: { ...withoutDigest, digest },
    narrative: narrative.text,
  };
}

/** Recompute digest and compare — used by incoming verification / tamper tests. */
export function verifyCapsuleDigest(capsule: PipelineContinuationCapsulePlain): boolean {
  const { digest: _ignored, ...rest } = capsule;
  return digestCapsulePayload(rest) === capsule.digest;
}
