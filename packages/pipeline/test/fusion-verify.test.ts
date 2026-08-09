/**
 * Incoming verification (§15.5 / Q029).
 */

import { describe, expect, it } from "vitest";
import { buildContinuationCapsule } from "../src/fusion/capsule.js";
import { verifyIncomingContinuation } from "../src/fusion/verify.js";

const HASH = "b".repeat(64);
const OTHER = "c".repeat(64);

function capsule() {
  const built = buildContinuationCapsule({
    runId: "run-1",
    stageId: "build",
    attemptId: "pa:1",
    segmentId: "seg:1",
    segmentOrdinal: 0,
    completedPlanItems: ["P1"],
    activePlanItem: "P2",
    nextAction: "Continue implementation",
    repositoryHeads: [{ repositoryId: "repo-api", head: "abc123" }],
    dirtyFiles: ["src/a.ts", "src/b.ts"],
    artifactRefs: [{ artifactId: "art-1", contentHash: HASH }],
    contextFileRefs: [{ path: "brief.md", contentHash: HASH }],
    decisionIds: ["D1"],
    unresolvedQuestionIds: [],
    riskRefs: [],
    outgoingSessionId: "session-1",
    createdAt: "2026-08-09T23:30:00.000Z",
  });
  if (!built.ok) throw new Error("capsule build failed");
  return built.capsule;
}

describe("verifyIncomingContinuation", () => {
  it("passes when observed state matches the capsule", () => {
    const c = capsule();
    const verdict = verifyIncomingContinuation({
      capsule: c,
      observedHeads: [{ repositoryId: "repo-api", head: "abc123" }],
      observedDirtyFiles: ["src/b.ts", "src/a.ts"],
      observedArtifacts: [{ artifactId: "art-1", contentHash: HASH, exists: true }],
      observedContextFiles: [{ path: "brief.md", contentHash: HASH, exists: true }],
      cheapChecksPassed: true,
      recordedAt: "2026-08-09T23:31:00.000Z",
    });
    expect(verdict.verdict).toBe("pass");
    expect(verdict.blockers).toEqual([]);
  });

  it("blocks on stale HEAD", () => {
    const c = capsule();
    const verdict = verifyIncomingContinuation({
      capsule: c,
      observedHeads: [{ repositoryId: "repo-api", head: "deadbeef" }],
      observedDirtyFiles: ["src/a.ts", "src/b.ts"],
      observedArtifacts: [{ artifactId: "art-1", contentHash: HASH, exists: true }],
      observedContextFiles: [{ path: "brief.md", contentHash: HASH, exists: true }],
      recordedAt: "2026-08-09T23:31:00.000Z",
    });
    expect(verdict.verdict).toBe("block");
    expect(verdict.blockers).toContain("stale_head");
  });

  it("blocks on dirty-set mismatch", () => {
    const c = capsule();
    const verdict = verifyIncomingContinuation({
      capsule: c,
      observedHeads: [{ repositoryId: "repo-api", head: "abc123" }],
      observedDirtyFiles: ["src/a.ts"],
      observedArtifacts: [{ artifactId: "art-1", contentHash: HASH, exists: true }],
      observedContextFiles: [{ path: "brief.md", contentHash: HASH, exists: true }],
      recordedAt: "2026-08-09T23:31:00.000Z",
    });
    expect(verdict.blockers).toContain("dirty_set_mismatch");
  });

  it("blocks on missing or altered artifacts", () => {
    const c = capsule();
    const missing = verifyIncomingContinuation({
      capsule: c,
      observedHeads: [{ repositoryId: "repo-api", head: "abc123" }],
      observedDirtyFiles: ["src/a.ts", "src/b.ts"],
      observedArtifacts: [{ artifactId: "art-1", contentHash: HASH, exists: false }],
      observedContextFiles: [{ path: "brief.md", contentHash: HASH, exists: true }],
      recordedAt: "2026-08-09T23:31:00.000Z",
    });
    expect(missing.blockers).toContain("missing_artifact");

    const altered = verifyIncomingContinuation({
      capsule: c,
      observedHeads: [{ repositoryId: "repo-api", head: "abc123" }],
      observedDirtyFiles: ["src/a.ts", "src/b.ts"],
      observedArtifacts: [{ artifactId: "art-1", contentHash: OTHER, exists: true }],
      observedContextFiles: [{ path: "brief.md", contentHash: HASH, exists: true }],
      recordedAt: "2026-08-09T23:31:00.000Z",
    });
    expect(altered.blockers).toContain("artifact_hash_mismatch");
  });

  it("blocks on missing context files", () => {
    const c = capsule();
    const verdict = verifyIncomingContinuation({
      capsule: c,
      observedHeads: [{ repositoryId: "repo-api", head: "abc123" }],
      observedDirtyFiles: ["src/a.ts", "src/b.ts"],
      observedArtifacts: [{ artifactId: "art-1", contentHash: HASH, exists: true }],
      observedContextFiles: [{ path: "brief.md", exists: false }],
      recordedAt: "2026-08-09T23:31:00.000Z",
    });
    expect(verdict.blockers).toContain("missing_context_file");
  });

  it("blocks on contradictory completion claims and failed cheap checks", () => {
    const c = capsule();
    const verdict = verifyIncomingContinuation({
      capsule: c,
      observedHeads: [{ repositoryId: "repo-api", head: "abc123" }],
      observedDirtyFiles: ["src/a.ts", "src/b.ts"],
      observedArtifacts: [{ artifactId: "art-1", contentHash: HASH, exists: true }],
      observedContextFiles: [{ path: "brief.md", contentHash: HASH, exists: true }],
      contradictoryCompletion: true,
      cheapChecksPassed: false,
      recordedAt: "2026-08-09T23:31:00.000Z",
    });
    expect(verdict.blockers).toContain("contradictory_completion");
    expect(verdict.blockers).toContain("cheap_check_failed");
  });

  it("blocks tampered capsules", () => {
    const c = capsule();
    const tampered = { ...c, nextAction: "rewritten" };
    const verdict = verifyIncomingContinuation({
      capsule: tampered,
      observedHeads: [{ repositoryId: "repo-api", head: "abc123" }],
      observedDirtyFiles: ["src/a.ts", "src/b.ts"],
      observedArtifacts: [{ artifactId: "art-1", contentHash: HASH, exists: true }],
      observedContextFiles: [{ path: "brief.md", contentHash: HASH, exists: true }],
      recordedAt: "2026-08-09T23:31:00.000Z",
    });
    expect(verdict.blockers).toContain("digest_mismatch");
    expect(verdict.blockers).toContain("tampered_capsule");
  });
});
