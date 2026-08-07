import type { ConfigurationLayerDocument } from "@heniek/config";
import type { ExecutionBackendV3, ExecutionRequestV3 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  type CapabilityEntry,
  type CapabilityService,
  startProfileExecution,
} from "../src/index.js";

const observedAt = "2026-08-07T10:00:00.000Z";
const supported = {
  support: "supported" as const,
  evidence: [{ source: "harness-inventory" as const, observedAt }],
  reasons: [],
};

const claudeEntry: CapabilityEntry = {
  engine: "claude",
  accountId: "claude-main",
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
    { id: "sonnet", provenance: "manifest", efforts: ["high"], executionModes: ["external"] },
  ],
  features: {
    questions: supported,
    resume: supported,
    usage: supported,
    structuredOutput: supported,
    cancellation: supported,
    tools: [],
  },
  provenance: [{ source: "harness-inventory", observedAt }],
  reasons: [],
};

const documents: readonly ConfigurationLayerDocument[] = [
  {
    layer: "global-defaults",
    sourcePath: "/profiles.yaml",
    values: {
      accounts: { "claude-main": { engine: "claude", billing: "subscription" } },
      workers: {
        "claude-external": {
          engine: "claude",
          executor: "external",
          account: "claude-main",
          model: "sonnet",
          effort: "high",
        },
      },
      roles: { reporter: { instructions: "roles/reporter.md", artifact_contract: "report.v1" } },
      profiles: {
        report: { worker: "claude-external", role: "reporter", questions: "parent-mediated" },
      },
    },
  },
];

describe("profile execution integration", () => {
  it("resolves a named external account, model, and effort before starting V3", async () => {
    const service: CapabilityService = {
      catalogue: async () => ({
        schemaVersion: 1,
        generatedAt: observedAt,
        entries: [claudeEntry],
      }),
    };
    let received: Static<typeof ExecutionRequestV3> | undefined;
    const backend: ExecutionBackendV3 = {
      start: async (request) => {
        received = request;
        return { schemaVersion: 1, executionId: "thread-1" as never };
      },
      status: async () => "queued",
      interactions: async () => [],
      answer: async () => undefined,
      resume: async () => undefined,
      result: async () => ({
        schemaVersion: 2,
        status: "succeeded",
        summary: "done",
        artifacts: [],
      }),
      cancel: async () => undefined,
      artifacts: async () => [],
      readArtifact: async () => new Uint8Array(),
      async *events() {},
    };

    const result = await startProfileExecution(service, backend, {
      profileId: "report",
      documents,
      execution: {
        runId: "run-1",
        stageId: "stage-1" as never,
        workspaceId: "workspace-1" as never,
        workingDirectory: "/work/repository",
        prompt: "Create the report.",
        artifactPath: "artifacts/report.md",
        inputArtifactRefs: [],
        limits: {},
      },
    });

    expect(result).toMatchObject({ ok: true, handle: { executionId: "thread-1" } });
    expect(received?.profile).toMatchObject({
      accountId: "claude-main",
      model: "sonnet",
      effort: "high",
      executionMode: "external",
      billing: "subscription",
    });
  });
});
