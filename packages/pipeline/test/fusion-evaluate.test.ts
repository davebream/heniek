/**
 * Fusion eligibility matrix (Q029).
 */

import { describe, expect, it } from "vitest";
import { evaluateFusion, requiresFreshReview } from "../src/fusion/evaluate.js";

const NOW = "2026-08-09T23:30:00.000Z";

function baseInput(
  overrides: Partial<Parameters<typeof evaluateFusion>[0]> = {},
): Parameters<typeof evaluateFusion>[0] {
  return {
    runId: "run-1",
    from: {
      stageId: "understand",
      stageType: "agent",
      profileId: "opus-planner",
      profileFingerprint: "fp-1",
      permissionsDigest: "perm-1",
    },
    to: {
      stageId: "design",
      stageType: "agent",
      profileId: "opus-planner",
      profileFingerprint: "fp-1",
      permissionsDigest: "perm-1",
    },
    fromWorkspace: { workspaceId: "ws-1", leaseId: "lease-1" },
    toWorkspace: { workspaceId: "ws-1", leaseId: "lease-1" },
    adjacent: true,
    successorCount: 1,
    backendSupportsContinuation: true,
    pressure: { state: "measured", ratio: 0.4, confidence: "exact" },
    now: NOW,
    ...overrides,
  };
}

describe("evaluateFusion matrix", () => {
  it("fuses compatible adjacent agent stages below soft threshold", () => {
    const result = evaluateFusion(baseInput());
    expect(result.outcome).toBe("fuse");
  });

  it("splits on profile mismatch", () => {
    const result = evaluateFusion(
      baseInput({ to: { ...baseInput().to, profileId: "grok-builder" } }),
    );
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("profile_mismatch");
  });

  it("splits on fingerprint mismatch", () => {
    const result = evaluateFusion(
      baseInput({ to: { ...baseInput().to, profileFingerprint: "fp-other" } }),
    );
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("fingerprint_mismatch");
  });

  it("splits on permissions mismatch", () => {
    const result = evaluateFusion(
      baseInput({ to: { ...baseInput().to, permissionsDigest: "perm-other" } }),
    );
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("permissions_mismatch");
  });

  it("splits on workspace mismatch", () => {
    const result = evaluateFusion(
      baseInput({ toWorkspace: { workspaceId: "ws-2", leaseId: "lease-1" } }),
    );
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("workspace_mismatch");
  });

  it("splits on lease mismatch", () => {
    const result = evaluateFusion(
      baseInput({ toWorkspace: { workspaceId: "ws-1", leaseId: "lease-2" } }),
    );
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("lease_mismatch");
  });

  it("splits on explicit fresh session policy", () => {
    const result = evaluateFusion(baseInput({ to: { ...baseInput().to, sessionPolicy: "fresh" } }));
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("explicit_fresh");
  });

  it("splits when successor is a critic/review role", () => {
    const result = evaluateFusion(
      baseInput({
        to: {
          ...baseInput().to,
          profileId: "sol-critic",
          roleId: "critic",
        },
      }),
    );
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("fresh_review_required");
  });

  it("splits when backend cannot continue", () => {
    const result = evaluateFusion(baseInput({ backendSupportsContinuation: false }));
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("backend_no_continuation");
  });

  it("splits on delegated recovery", () => {
    const result = evaluateFusion(baseInput({ retryMode: "delegate" }));
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("delegated_recovery");
  });

  it("splits on fresh retry mode", () => {
    const result = evaluateFusion(baseInput({ retryMode: "fresh" }));
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("retry_requires_fresh");
  });

  it("splits on branching ambiguity", () => {
    const result = evaluateFusion(baseInput({ successorCount: 2 }));
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("branching_ambiguity");
  });

  it("splits when stages are not adjacent", () => {
    const result = evaluateFusion(baseInput({ adjacent: false }));
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("not_adjacent");
  });

  it("splits for non-agent stages", () => {
    const result = evaluateFusion(baseInput({ to: { ...baseInput().to, stageType: "command" } }));
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("non_agent_stage");
  });

  it("splits when pressure is unavailable", () => {
    const result = evaluateFusion(
      baseInput({ pressure: { state: "unavailable", confidence: "unavailable" } }),
    );
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("pressure_unavailable");
  });

  it("splits at soft threshold", () => {
    const result = evaluateFusion(
      baseInput({ pressure: { state: "measured", ratio: 0.65, confidence: "exact" } }),
    );
    expect(result.outcome).toBe("split");
    if (result.outcome === "split") expect(result.splitReason).toBe("pressure_soft_threshold");
  });

  it("requiresFreshReview detects critic roles and explicit fresh", () => {
    expect(requiresFreshReview({ stageId: "a", stageType: "agent", roleId: "code-reviewer" })).toBe(
      true,
    );
    expect(requiresFreshReview({ stageId: "a", stageType: "agent", sessionPolicy: "fresh" })).toBe(
      true,
    );
    expect(requiresFreshReview({ stageId: "a", stageType: "agent", roleId: "builder" })).toBe(
      false,
    );
  });
});
