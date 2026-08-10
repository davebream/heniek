/**
 * Pipeline admission door tests (Q032) — named/one-off parity, closed overrides,
 * and byte-stable run snapshots.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonStringify, type JsonValue } from "@heniek/config";
import type { PipelineInvocationOverrideRequestV1 } from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import { admitPipeline, buildRunSnapshot, loadBundledPipeline } from "../src/index.js";
import { listCorpus } from "./helpers/corpus.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-08-10T12:00:00.000Z";

function modeOverride(
  stageId: string,
  mode: "autonomous" | "hitl",
): PipelineInvocationOverrideRequestV1 {
  return {
    schemaVersion: 1,
    target: { kind: "stage", stageId: stageId as never },
    field: "mode",
    value: mode,
  };
}

const ONE_OFF_WITH_MODE = `schemaVersion: 1
id: override-mode
mode: autonomous
stages:
  - id: only
    type: approval
    overridable:
      - mode
`;

const ONE_OFF_WITH_PROFILE = `schemaVersion: 1
id: override-profile
mode: autonomous
stages:
  - id: build
    type: agent
    profile: builder
    overridable:
      - effort
      - mode
    reads:
      - task.current
    writes:
      - artifacts.out
`;

describe("pipeline admission", () => {
  it("named bundled fast admits with the same digest as loadBundledPipeline", () => {
    const bundled = loadBundledPipeline("fast", 1);
    expect(bundled.ok).toBe(true);
    const admitted = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "named", pipelineId: "fast" as never },
        knownProfileIds: ["task-owner", "reviewer"],
      },
    });
    expect(admitted.accepted).toBe(true);
    expect(admitted.source?.kind).toBe("bundled");
    expect(admitted.source?.digest).toBe(bundled.entry.sourceSha256);
    expect(admitted.baseGraphDigest).toBe(bundled.normalizedGraphSha256);
    expect(admitted.effectiveGraphDigest).toBe(admitted.baseGraphDigest);
  });

  it("one-off YAML admits with deterministic oneoff.<digest> id", () => {
    const yaml = readFileSync(join(packageRoot, "test/corpus/valid/minimal.yaml"), "utf8");
    const admitted = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "one-off", definitionText: yaml, format: "yaml" },
      },
    });
    expect(admitted.accepted).toBe(true);
    expect(admitted.pipelineId).toMatch(/^oneoff\.[0-9a-f]{64}$/);
    expect(admitted.source?.kind).toBe("one-off");
    expect(admitted.source?.identity).toBe(admitted.pipelineId);
  });

  it("one-off and equivalent named graph pass the same schema checks", () => {
    const yaml = readFileSync(join(packageRoot, "test/corpus/valid/minimal.yaml"), "utf8");
    const oneOff = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "one-off", definitionText: yaml, format: "yaml" },
      },
    });
    expect(oneOff.accepted).toBe(true);
    expect(oneOff.diagnostics.every((d) => d.severity !== "error")).toBe(true);

    // Same document shape with a different authored id still admits cleanly.
    const renamed = yaml.replace("id: minimal", "id: minimal-twin");
    const twin = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "one-off", definitionText: renamed, format: "yaml" },
      },
    });
    expect(twin.accepted).toBe(true);
    expect(twin.effectiveGraph?.stages).toEqual(oneOff.effectiveGraph?.stages);
    expect(twin.effectiveGraph?.edges).toEqual(oneOff.effectiveGraph?.edges);
  });

  it("invalid graph corpus rejects", () => {
    for (const entry of listCorpus("invalid")) {
      const admitted = admitPipeline({
        request: {
          schemaVersion: 1,
          source: { kind: "one-off", definitionText: entry.source, format: "yaml" },
        },
      });
      expect(admitted.accepted, entry.name).toBe(false);
      expect(
        admitted.diagnostics.some((d) => d.severity === "error"),
        entry.name,
      ).toBe(true);
    }
  });

  it("override: mode on stage with overridable including mode succeeds", () => {
    const admitted = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "one-off", definitionText: ONE_OFF_WITH_MODE, format: "yaml" },
        overrides: [modeOverride("only", "hitl")],
      },
    });
    expect(admitted.accepted).toBe(true);
    expect(admitted.effectiveGraph?.stages[0]?.mode).toBe("hitl");
    expect(admitted.appliedOverrides).toHaveLength(1);
    expect(admitted.appliedOverrides[0]?.field).toBe("mode");
  });

  it("override: unknown field rejects", () => {
    const admitted = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "one-off", definitionText: ONE_OFF_WITH_MODE, format: "yaml" },
        overrides: [
          {
            schemaVersion: 1,
            target: { kind: "stage", stageId: "only" as never },
            field: "prompt",
            value: "nope",
          },
        ],
      },
    });
    expect(admitted.accepted).toBe(false);
    expect(admitted.diagnostics.some((d) => d.code === "pipeline.override.unknown-field")).toBe(
      true,
    );
  });

  it("override: sensitive value rejects", () => {
    const admitted = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "one-off", definitionText: ONE_OFF_WITH_PROFILE, format: "yaml" },
        overrides: [
          {
            schemaVersion: 1,
            target: { kind: "stage", stageId: "build" as never },
            field: "effort",
            value: { api_key: "sk-secret" },
          },
        ],
        knownProfileIds: ["builder"],
      },
      profileOverridable: new Map([["builder", ["effort"]]]),
    });
    expect(admitted.accepted).toBe(false);
    expect(admitted.diagnostics.some((d) => d.code === "pipeline.override.sensitive-value")).toBe(
      true,
    );
  });

  it("override: profile field without profile allowlist rejects", () => {
    const admitted = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "one-off", definitionText: ONE_OFF_WITH_PROFILE, format: "yaml" },
        overrides: [
          {
            schemaVersion: 1,
            target: { kind: "stage", stageId: "build" as never },
            field: "effort",
            value: "high",
          },
        ],
        knownProfileIds: ["builder"],
      },
      // No profileOverridable map → profile allowlist empty.
    });
    expect(admitted.accepted).toBe(false);
    expect(
      admitted.diagnostics.some((d) => d.code === "pipeline.override.profile-not-permitted"),
    ).toBe(true);
  });

  it("override: hard limit strictest-wins", () => {
    const yaml = `schemaVersion: 1
id: limits
mode: autonomous
limits:
  max_repair_attempts: 5
stages:
  - id: only
    type: approval
`;
    const admitted = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "one-off", definitionText: yaml, format: "yaml" },
        overrides: [
          {
            schemaVersion: 1,
            target: { kind: "pipeline" },
            field: "max_repair_attempts",
            value: 2,
          },
        ],
      },
    });
    expect(admitted.accepted).toBe(true);
    expect(admitted.effectiveGraph?.limits?.maxRepairAttempts).toBe(2);
    expect(admitted.appliedOverrides[0]?.source).toBe("configuration-policy");
  });

  it("override: forbidden field / stage-not-permitted rejects", () => {
    const admitted = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "one-off", definitionText: ONE_OFF_WITH_MODE, format: "yaml" },
        overrides: [
          {
            schemaVersion: 1,
            target: { kind: "stage", stageId: "only" as never },
            field: "effort",
            value: "high",
          },
        ],
      },
    });
    expect(admitted.accepted).toBe(false);
    expect(
      admitted.diagnostics.some((d) => d.code === "pipeline.override.stage-not-permitted"),
    ).toBe(true);
  });

  it("buildRunSnapshot is byte-stable for the same inputs", () => {
    const admitted = admitPipeline({
      request: {
        schemaVersion: 1,
        source: { kind: "named", pipelineId: "fast" as never },
      },
    });
    expect(admitted.accepted).toBe(true);
    const first = buildRunSnapshot({
      runId: "run-stable",
      admission: admitted,
      requestedOverrides: [],
      recordedAt: NOW,
    });
    const second = buildRunSnapshot({
      runId: "run-stable",
      admission: admitted,
      requestedOverrides: [],
      recordedAt: NOW,
    });
    expect(first).toBeDefined();
    expect(canonicalJsonStringify(first as unknown as JsonValue)).toBe(
      canonicalJsonStringify(second as unknown as JsonValue),
    );
  });
});
