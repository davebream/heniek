import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  ArtifactRefV1,
  CheckFailureV1,
  CheckStatusV1,
  CreatePullRequestInputV1,
  ExecutionRequestV1,
  ExecutionResultV1,
  InteractionAnswerV1,
  InteractionV1,
  PendingInteractionV1,
  PullRequestV1,
  RunV1,
  TaskContextV1,
} from "../src/index.js";

// See scripts/generate.ts for why ajv-formats is loaded via createRequire
// rather than a static import (a TS 7 / NodeNext interop gap for CJS
// packages with no "exports" map).
const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

const NOW = "2026-07-31T12:00:00.000Z";

const cases: { name: string; schema: object; valid: Record<string, unknown> }[] = [
  {
    name: "ExecutionRequestV1",
    schema: ExecutionRequestV1,
    valid: {
      schemaVersion: 1,
      stageId: "stage-1",
      profileId: "profile-1",
      workspaceId: "workspace-1",
      workingDirectory: "/work/dir",
      inputArtifactRefs: ["artifact-1", "artifact-2"],
      outputContract: "stage-output-v1",
      limits: { maxDurationMs: 60_000, maxTurns: 10 },
    },
  },
  {
    name: "PendingInteractionV1",
    schema: PendingInteractionV1,
    valid: {
      schemaVersion: 1,
      id: "interaction-1",
      kind: "single_choice",
      prompt: "Proceed?",
      options: ["yes", "no"],
    },
  },
  {
    name: "ExecutionResultV1",
    schema: ExecutionResultV1,
    valid: {
      schemaVersion: 1,
      status: "succeeded",
      summary: "Completed the stage.",
      providerSessionId: "session-1",
      changedRepositories: ["repository-1"],
      artifacts: { report: "artifact-1" },
      usage: { turns: 3 },
    },
  },
  {
    name: "TaskContextV1",
    schema: TaskContextV1,
    valid: {
      schemaVersion: 1,
      sourceWorkItemId: "issue-2",
      sourceKind: "github_issue",
      objective: "Establish domain contracts.",
      constraints: ["Use TypeBox and Ajv."],
      decisions: ["One package, six families."],
      openQuestions: [],
      repositoryReferences: ["davebream/heniek"],
      rawContentRef: "artifact-1",
      revision: 1,
    },
  },
  {
    name: "CreatePullRequestInputV1",
    schema: CreatePullRequestInputV1,
    valid: {
      schemaVersion: 1,
      repositoryId: "repository-1",
      sourceBranch: "q001-domain-contracts",
      targetBranch: "main",
      title: "Q001 — domain contracts",
      body: "Closes #2",
      draft: false,
    },
  },
  {
    name: "PullRequestV1",
    schema: PullRequestV1,
    valid: {
      schemaVersion: 1,
      pullRequestId: "pr-1",
      repositoryId: "repository-1",
      number: 2,
      url: "https://forge.example/owner/repo/pull/2",
      state: "open",
      draft: false,
      headSha: "a".repeat(40),
    },
  },
  {
    name: "CheckStatusV1",
    schema: CheckStatusV1,
    valid: {
      schemaVersion: 1,
      name: "pnpm check",
      state: "succeeded",
      required: true,
      detailsUrl: "https://forge.example/owner/repo/checks/1",
    },
  },
  {
    name: "CheckFailureV1",
    schema: CheckFailureV1,
    valid: {
      schemaVersion: 1,
      name: "pnpm check",
      summary: "typecheck failed",
      logExcerpt: "error TS2322: ...",
    },
  },
  {
    name: "RunV1",
    schema: RunV1,
    valid: {
      schemaVersion: 1,
      runId: "run-1",
      sourceWorkItemId: "issue-2",
      codebaseId: "codebase-1",
      repositoryIds: ["repository-1"],
      workspaceId: "workspace-1",
      status: "running",
      createdAt: NOW,
      updatedAt: NOW,
    },
  },
  {
    name: "InteractionV1",
    schema: InteractionV1,
    valid: {
      schemaVersion: 1,
      interactionId: "interaction-1",
      status: "pending",
      kind: "free_text",
      prompt: "What is the target branch?",
      createdAt: NOW,
    },
  },
  {
    name: "InteractionAnswerV1",
    schema: InteractionAnswerV1,
    valid: {
      schemaVersion: 1,
      interactionId: "interaction-1",
      answer: "main",
      answeredAt: NOW,
    },
  },
  {
    name: "ArtifactRefV1",
    schema: ArtifactRefV1,
    valid: {
      schemaVersion: 1,
      artifactId: "artifact-1",
      path: "artifacts/report.md",
      contentHash: "a".repeat(64),
      createdAt: NOW,
    },
  },
];

describe("contract schema round-trip", () => {
  for (const { name, schema, valid } of cases) {
    describe(name, () => {
      it("compiles under strict Ajv", () => {
        expect(() => ajv.compile(schema)).not.toThrow();
      });

      it("accepts its valid sample payload", () => {
        const validate = ajv.compile(schema);
        const ok = validate(valid);
        expect(ok, JSON.stringify(validate.errors)).toBe(true);
      });

      it("rejects the payload with an unknown property (closed shape)", () => {
        const validate = ajv.compile(schema);
        const ok = validate({ ...valid, unexpectedField: "nope" });
        expect(ok).toBe(false);
      });

      it("rejects the payload missing each required field", () => {
        const validate = ajv.compile(schema);
        const optionalFields = new Set([
          "options",
          "detailsUrl",
          "logExcerpt",
          "providerSessionId",
          "usage",
        ]);
        for (const key of Object.keys(valid)) {
          if (optionalFields.has(key)) {
            // Optional fields — omitting them is valid, not a rejection case.
            continue;
          }
          const { [key]: _removed, ...rest } = valid;
          const ok = validate(rest);
          expect(ok, `expected rejection when "${key}" is missing`).toBe(false);
        }
      });
    });
  }
});
