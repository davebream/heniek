import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  ExecutionRequestV1,
  ExecutionRequestV2,
  ExecutionRequestV3,
  ProfileConfigurationV1,
  ResolvedProfileV1,
} from "../src/index.js";

const ajv = new Ajv({ allErrors: true, strict: true });

const RESOLVED_PROFILE = {
  schemaVersion: 1,
  profileId: "opus-designer",
  workerId: "opus-xhigh",
  roleId: "designer",
  engine: "claude",
  accountId: "claude-main",
  billing: "subscription",
  model: "opus",
  effort: "xhigh",
  executionMode: "external",
  questions: "parent-mediated",
  instructionsPath: "roles/designer.md",
  artifactContract: "design.v1",
  provenance: [
    {
      field: "effort",
      pointer: "/workers/opus-xhigh/effort",
      layer: "profile-or-stage",
      sourcePath: "/profiles.yaml",
      value: "xhigh",
      overridden: [{ layer: "global-defaults", value: "high" }],
    },
  ],
  fingerprint: `sha256:${"a".repeat(64)}`,
} as const;

describe("profile contracts", () => {
  it("validates the named configuration vocabulary", () => {
    const validate = ajv.compile(ProfileConfigurationV1);
    expect(
      validate({
        schemaVersion: 1,
        accounts: {
          "claude-main": { engine: "claude", billing: "subscription" },
        },
        workers: {
          "opus-xhigh": {
            engine: "claude",
            executor: "external",
            account: "claude-main",
            model: "opus",
            effort: "xhigh",
          },
        },
        roles: {
          designer: {
            instructions: "roles/designer.md",
            artifact_contract: "design.v1",
          },
        },
        profiles: {
          "opus-designer": {
            worker: "opus-xhigh",
            role: "designer",
            questions: "parent-mediated",
            overridable: ["effort", "focus", "max_duration"],
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects unsafe paths, unsupported engines, non-subscription billing, and unknown fields", () => {
    const validate = ajv.compile(ProfileConfigurationV1);
    for (const instructions of ["../outside.md", "roles/..\\outside.md", "C:\\outside.md"]) {
      expect(
        validate({
          schemaVersion: 1,
          accounts: { main: { engine: "opencode", billing: "api_key" } },
          roles: {
            escaped: { instructions, artifact_contract: "design.v1", extra: true },
          },
        }),
      ).toBe(false);
    }
  });

  it("validates the standalone resolved profile and rejects provider-specific leakage", () => {
    const validate = ajv.compile(ResolvedProfileV1);
    expect(validate(RESOLVED_PROFILE)).toBe(true);
    expect(validate({ ...RESOLVED_PROFILE, claudeSessionId: "session-1" })).toBe(false);
  });

  it("embeds a sourced profile in ExecutionRequestV3", () => {
    const validate = ajv.compile(ExecutionRequestV3);
    expect(
      validate({
        schemaVersion: 3,
        runId: "run-1",
        stageId: "stage-1",
        workspaceId: "workspace-1",
        workingDirectory: "/workspace",
        prompt: "Implement the plan",
        artifactPath: "artifacts/result.json",
        inputArtifactRefs: [],
        limits: { maxDurationMs: 60_000 },
        profile: RESOLVED_PROFILE,
      }),
    ).toBe(true);
  });

  it("leaves ExecutionRequestV1 and V2 version discriminators unchanged", () => {
    expect(ExecutionRequestV1.properties.schemaVersion.const).toBe(1);
    expect(ExecutionRequestV2.properties.schemaVersion.const).toBe(2);
    expect(ExecutionRequestV3.properties.schemaVersion.const).toBe(3);
  });
});
