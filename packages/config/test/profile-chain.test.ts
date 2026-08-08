import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import type { ConfigurationLayerDocument } from "../src/layers/index.js";
import { type ProfileCapabilityRow, resolveProfileChain } from "../src/profiles/index.js";

const CAPABILITIES: readonly ProfileCapabilityRow[] = [
  {
    engine: "claude",
    accountId: "primary-account",
    model: "opus",
    efforts: ["high"],
    executionModes: ["external"],
  },
  {
    engine: "claude",
    accountId: "fallback-account",
    model: "sonnet",
    efforts: ["high"],
    executionModes: ["external"],
  },
  {
    engine: "claude",
    accountId: "second-account",
    model: "haiku",
    efforts: ["high"],
    executionModes: ["external"],
  },
];

function catalog(primary: JsonObject = {}): JsonObject {
  return {
    accounts: {
      "primary-account": { engine: "claude", billing: "subscription" },
      "fallback-account": {
        engine: "claude",
        billing: "subscription",
        max_concurrent_runs: 3,
        queue: { strategy: "priority-fifo" },
      },
      "second-account": { engine: "claude", billing: "subscription" },
    },
    workers: {
      primary: {
        engine: "claude",
        executor: "external",
        account: "primary-account",
        model: "opus",
        effort: "high",
      },
      fallback: {
        engine: "claude",
        executor: "external",
        account: "fallback-account",
        model: "sonnet",
        effort: "high",
      },
      second: {
        engine: "claude",
        executor: "external",
        account: "second-account",
        model: "haiku",
        effort: "high",
      },
    },
    roles: { implementer: { instructions: "roles/implementer.md", artifact_contract: "code.v1" } },
    profiles: {
      primary: {
        worker: "primary",
        role: "implementer",
        questions: "parent-mediated",
        overridable: ["model"],
        fallbacks: ["fallback", "second"],
        ...primary,
      },
      fallback: {
        worker: "fallback",
        role: "implementer",
        questions: "parent-mediated",
        fallbacks: ["second"],
        permissions: { workspace: "read-only", identifiers: ["shared"] },
      },
      second: { worker: "second", role: "implementer", questions: "parent-mediated" },
    },
  };
}

function document(values: JsonObject): ConfigurationLayerDocument {
  return { layer: "global-defaults", sourcePath: "/profiles.yaml", values };
}

function resolve(values = catalog()) {
  return resolveProfileChain({
    profileId: "primary",
    documents: [document(values)],
    capabilities: CAPABILITIES,
  });
}

describe("Q021 profile-chain resolution", () => {
  it("normalizes V1-compatible entries to conservative account/profile defaults", () => {
    const result = resolve();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chain.primary).toMatchObject({
      schemaVersion: 2,
      accountMaxConcurrentRuns: 1,
      accountQueueStrategy: "priority-fifo",
      onCapacity: "queue",
      permissions: { workspace: "read-write", identifiers: [] },
    });
    expect(result.chain.fallbacks[0]).toMatchObject({
      profileId: "fallback",
      accountMaxConcurrentRuns: 3,
      permissions: { workspace: "read-only", identifiers: ["shared"] },
    });
  });

  it("preserves the direct fallback order without recursively expanding fallback chains", () => {
    const result = resolve();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chain.fallbacks.map((profile) => profile.profileId)).toEqual([
      "fallback",
      "second",
    ]);
  });

  it("applies invocation overrides only to the primary profile", () => {
    const result = resolveProfileChain({
      profileId: "primary",
      documents: [document(catalog())],
      capabilities: [
        ...CAPABILITIES,
        {
          engine: "claude",
          accountId: "primary-account",
          model: "sonnet",
          efforts: ["high"],
          executionModes: ["external"],
        },
      ],
      invocationOverrides: { model: "sonnet" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chain.primary.model).toBe("sonnet");
    expect(result.chain.fallbacks[0]?.model).toBe("sonnet");
    expect(result.chain.fallbacks[1]?.model).toBe("haiku");
  });

  it("rejects self references and duplicate fallback identifiers", () => {
    const self = resolve(catalog({ fallbacks: ["primary"] }));
    expect(self.ok).toBe(false);
    expect(self.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "profile.fallback-self-reference",
    );

    const duplicate = resolve(catalog({ fallbacks: ["fallback", "fallback"] }));
    expect(duplicate.ok).toBe(false);
    expect(duplicate.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
  });

  it("fails the whole chain when any candidate is capability-incompatible", () => {
    const result = resolveProfileChain({
      profileId: "primary",
      documents: [document(catalog())],
      capabilities: CAPABILITIES.filter((row) => row.accountId !== "fallback-account"),
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "profile.capability-not-found",
    );
  });
});
