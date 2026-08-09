/**
 * Continuation capsule build, digest, truncation, and tamper (Q029).
 */

import { describe, expect, it } from "vitest";
import {
  buildContinuationCapsule,
  CONTINUATION_NARRATIVE_MAX_BYTES,
  CONTINUATION_REFERENCE_COLLECTION_MAX,
  digestCapsulePayload,
  truncateNarrative,
  verifyCapsuleDigest,
} from "../src/fusion/capsule.js";

const HASH = "a".repeat(64);

function baseInput(overrides: Partial<Parameters<typeof buildContinuationCapsule>[0]> = {}) {
  return {
    runId: "run-1",
    stageId: "build",
    attemptId: "pa:1",
    segmentId: "seg:1",
    segmentOrdinal: 0,
    completedPlanItems: ["P1", "P2"],
    activePlanItem: "P3",
    remainingPlanItems: ["P4"],
    nextAction: "Implement retry classification",
    repositoryHeads: [{ repositoryId: "repo-api", head: "8f31c2a" }],
    dirtyFiles: ["src/a.ts"],
    artifactRefs: [{ artifactId: "art-1", contentHash: HASH, name: "result" }],
    contextFileRefs: [{ path: "docs/brief.md", contentHash: HASH }],
    decisionIds: ["D7"],
    unresolvedQuestionIds: ["Q4"],
    riskRefs: ["R1"],
    outgoingSessionId: "session-123",
    narrativeMarkdown: "## Discoveries\n- one\n",
    createdAt: "2026-08-09T23:30:00.000Z",
    ...overrides,
  };
}

describe("buildContinuationCapsule", () => {
  it("builds a digest-stable capsule without transcripts or credentials", () => {
    const result = buildContinuationCapsule(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capsule.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyCapsuleDigest(result.capsule)).toBe(true);
    expect(result.capsule.outgoingSessionId).toBe("session-123");
    expect(JSON.stringify(result.capsule)).not.toMatch(/password|api[_-]?key|credential/i);
    expect(result.narrative).toContain("Discoveries");
  });

  it("is deterministic for identical inputs", () => {
    const a = buildContinuationCapsule(baseInput());
    const b = buildContinuationCapsule(baseInput());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.capsule.digest).toBe(b.capsule.digest);
    expect(a.capsule.capsuleId).toBe(b.capsule.capsuleId);
  });

  it("truncates narrative with omitted byte counts", () => {
    const huge = "x".repeat(CONTINUATION_NARRATIVE_MAX_BYTES + 500);
    const truncated = truncateNarrative(huge);
    expect(truncated.omittedBytes).toBeGreaterThan(0);
    expect(Buffer.byteLength(truncated.text, "utf8")).toBeLessThanOrEqual(
      CONTINUATION_NARRATIVE_MAX_BYTES,
    );

    const result = buildContinuationCapsule(baseInput({ narrativeMarkdown: huge }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capsule.omittedNarrativeBytes).toBeGreaterThan(0);
  });

  it("blocks required artifact reference overflow", () => {
    const refs = Array.from({ length: CONTINUATION_REFERENCE_COLLECTION_MAX + 1 }, (_, i) => ({
      artifactId: `art-${i}`,
      contentHash: HASH,
    }));
    const result = buildContinuationCapsule(baseInput({ artifactRefs: refs }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blocker).toBe("artifact_refs_overflow");
  });

  it("detects tampering via digest mismatch", () => {
    const result = buildContinuationCapsule(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tampered = {
      ...result.capsule,
      nextAction: "tampered next action",
    };
    expect(verifyCapsuleDigest(tampered)).toBe(false);
    expect(digestCapsulePayload(tampered)).not.toBe(result.capsule.digest);
  });

  it("rejects empty nextAction", () => {
    const result = buildContinuationCapsule(baseInput({ nextAction: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blocker).toBe("empty_next_action");
  });
});
