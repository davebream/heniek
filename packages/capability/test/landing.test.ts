import { describe, expect, it } from "vitest";
import type { CapabilityEntry } from "../src/index.js";
import {
  buildPinnedCapabilityBlocker,
  candidateSnapshotFromProfile,
  evaluateCapabilityCandidate,
  pinnedAxesFrom,
  requestSnapshotFromProfile,
} from "../src/landing.js";

function profile(overrides: {
  profileId?: string;
  engine?: "claude" | "codex" | "cursor";
  accountId?: string;
  billing?: "subscription";
  model?: string;
  effort?: string;
  executionMode?: "native" | "external";
}) {
  return {
    schemaVersion: 2 as const,
    profileId: overrides.profileId ?? "primary",
    workerId: "worker",
    roleId: "role",
    engine: overrides.engine ?? ("claude" as const),
    ...(overrides.accountId === undefined ? {} : { accountId: overrides.accountId }),
    ...(overrides.billing === undefined ? {} : { billing: overrides.billing }),
    model: overrides.model ?? "opus",
    effort: overrides.effort ?? "high",
    executionMode: overrides.executionMode ?? ("external" as const),
    questions: "direct" as const,
    instructionsPath: "instructions.md",
    artifactContract: "artifact",
    provenance: [],
    fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fallbackProfileIds: [],
    onCapacity: "fallback" as const,
    permissions: { schemaVersion: 1 as const, workspace: "read-write" as const, identifiers: [] },
  };
}

function entry(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  const observedAt = "2026-08-07T10:00:00.000Z";
  const supported = {
    support: "supported" as const,
    evidence: [{ source: "harness-inventory" as const, observedAt }],
    reasons: [],
  };
  const unsupported = {
    support: "unsupported" as const,
    evidence: [{ source: "harness-inventory" as const, observedAt }],
    reasons: ["missing"],
  };
  return {
    engine: "claude",
    accountId: "acct",
    engineVersion: "1.0.0",
    claudexorVersion: "3.1.2",
    observedAt,
    expiresAt: "2026-08-07T10:02:00.000Z",
    freshness: "fresh",
    discovery: "complete",
    configured: true,
    installation: "installed",
    authentication: "authenticated",
    compatibility: "compatible",
    capacity: "available",
    ready: true,
    models: [
      {
        id: "opus",
        provenance: "manifest",
        efforts: ["high"],
        executionModes: ["external"],
      },
      {
        id: "sonnet",
        provenance: "manifest",
        efforts: ["high", "medium"],
        executionModes: ["external"],
      },
    ],
    features: {
      questions: supported,
      resume: supported,
      usage: supported,
      structuredOutput: unsupported,
      cancellation: supported,
      tools: [
        { name: "web", state: supported },
        { name: "browser", state: unsupported },
      ],
    },
    provenance: [{ source: "harness-inventory", observedAt }],
    reasons: [],
    ...overrides,
  };
}

describe("capability landing comparison", () => {
  it("orders scalar differences deterministically and returns degraded without severity", () => {
    const requested = requestSnapshotFromProfile(profile({ model: "opus", effort: "high" }));
    const candidate = candidateSnapshotFromProfile(
      profile({ profileId: "fallback", model: "sonnet", effort: "medium" }),
    );
    const result = evaluateCapabilityCandidate({
      requested,
      candidate,
      pinnedAxes: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.landing.status).toBe("degraded");
    expect(result.delta?.differences.map((difference) => difference.axis)).toEqual([
      "model",
      "effort",
    ]);
    expect(result.delta).not.toHaveProperty("severity");
  });

  it("returns satisfied when every compared axis is equal", () => {
    const primary = profile({ accountId: "acct" });
    const result = evaluateCapabilityCandidate({
      requested: requestSnapshotFromProfile(primary),
      candidate: candidateSnapshotFromProfile(primary),
      pinnedAxes: [],
    });
    expect(result).toEqual({
      ok: true,
      landing: { schemaVersion: 1, status: "satisfied" },
      delta: undefined,
    });
  });

  it("records preferred feature and tool absences as degradation", () => {
    const catalogue = {
      schemaVersion: 1 as const,
      generatedAt: "2026-08-07T10:00:00.000Z",
      entries: [
        entry(),
        entry({ engine: "codex", accountId: null }),
        entry({ engine: "cursor", accountId: null }),
      ],
    };
    const primary = profile({ accountId: "acct" });
    const result = evaluateCapabilityCandidate({
      requested: requestSnapshotFromProfile(primary, {
        preferredFeatures: ["structuredOutput", "resume"],
        preferredTools: ["browser", "web"],
      }),
      candidate: candidateSnapshotFromProfile(primary),
      pinnedAxes: [],
      catalogue,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.landing.status).toBe("degraded");
    expect(result.delta?.differences).toEqual([
      {
        axis: "preferredFeatures",
        requested: ["resume", "structuredOutput"],
        resolved: ["resume"],
      },
      {
        axis: "preferredTools",
        requested: ["browser", "web"],
        resolved: ["web"],
      },
    ]);
  });

  it("rejects candidates that violate invocation-override pins", () => {
    const requested = requestSnapshotFromProfile(profile({ model: "opus", accountId: "acct" }));
    const candidate = candidateSnapshotFromProfile(
      profile({ profileId: "fallback", model: "sonnet", accountId: "acct" }),
    );
    const pins = pinnedAxesFrom({ appliedOverrideFields: ["model"] });
    const result = evaluateCapabilityCandidate({
      requested,
      candidate,
      pinnedAxes: pins,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.pinViolations).toEqual(["model"]);
    expect(
      buildPinnedCapabilityBlocker({
        pinnedAxes: pins,
        rejections: [{ profileId: "fallback", differences: result.differences }],
      }).reason,
    ).toBe("pinned_capability_unavailable");
  });

  it("rejects missing required features and tools as hard pins", () => {
    const catalogue = {
      schemaVersion: 1 as const,
      generatedAt: "2026-08-07T10:00:00.000Z",
      entries: [
        entry(),
        entry({ engine: "codex", accountId: null }),
        entry({ engine: "cursor", accountId: null }),
      ],
    };
    const primary = profile({ accountId: "acct" });
    const result = evaluateCapabilityCandidate({
      requested: requestSnapshotFromProfile(primary, {
        requiredFeatures: ["structuredOutput"],
        requiredTools: ["browser"],
      }),
      candidate: candidateSnapshotFromProfile(primary),
      pinnedAxes: pinnedAxesFrom({
        requiredFeatures: ["structuredOutput"],
        requiredTools: ["browser"],
      }),
      catalogue,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.pinViolations).toEqual(["requiredFeatures", "requiredTools"]);
  });

  it("keeps unpinned equivalent fallbacks eligible", () => {
    const requested = requestSnapshotFromProfile(profile({ model: "opus", accountId: "a" }));
    const candidate = candidateSnapshotFromProfile(
      profile({ profileId: "fallback", model: "sonnet", accountId: "b" }),
    );
    const result = evaluateCapabilityCandidate({
      requested,
      candidate,
      pinnedAxes: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.landing.status).toBe("degraded");
    expect(result.delta?.resolvedProfileId).toBe("fallback");
  });
});
