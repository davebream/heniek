import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { CreatePullRequestInputV1, ExecutionResultV1, RunV1 } from "../src/index.js";

// See scripts/generate.ts for why ajv-formats is loaded via createRequire
// rather than a static import (a TS 7 / NodeNext interop gap for CJS
// packages with no "exports" map).
const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

const VALID_RUN = {
  schemaVersion: 1,
  runId: "run-1",
  sourceWorkItemId: "issue-2",
  codebaseId: "codebase-1",
  repositoryIds: ["repository-1"],
  workspaceId: "workspace-1",
  status: "running",
  createdAt: "2026-07-31T12:00:00.000Z",
  updatedAt: "2026-07-31T12:00:00.000Z",
};

describe("unknown schemaVersion rejection", () => {
  it("rejects a schemaVersion the schema does not declare", () => {
    const validate = ajv.compile(RunV1);
    expect(validate({ ...VALID_RUN, schemaVersion: 1 })).toBe(true);
    expect(validate({ ...VALID_RUN, schemaVersion: 2 })).toBe(false);
    expect(validate({ ...VALID_RUN, schemaVersion: 0 })).toBe(false);
    expect(validate({ ...VALID_RUN, schemaVersion: "1" })).toBe(false);
  });

  it("rejects a payload with schemaVersion omitted entirely", () => {
    const validate = ajv.compile(RunV1);
    const { schemaVersion: _omitted, ...withoutVersion } = VALID_RUN;
    expect(validate(withoutVersion)).toBe(false);
  });
});

describe("provider-specific field leakage", () => {
  const providerShapedFields: Record<string, unknown> = {
    claudeSessionId: "sess_abc123",
    codexRunId: "run_abc123",
    cursorSessionId: "cur_abc123",
    githubNodeId: "MDEwOlJlcG9zaXRvcnk=",
  };

  it("ExecutionResultV1 rejects a payload carrying a provider-shaped field", () => {
    const validate = ajv.compile(ExecutionResultV1);
    const base = {
      schemaVersion: 1,
      status: "succeeded",
      summary: "done",
      changedRepositories: ["repository-1"],
      artifacts: {},
    };
    expect(validate(base)).toBe(true);
    for (const [field, value] of Object.entries(providerShapedFields)) {
      expect(validate({ ...base, [field]: value }), `expected rejection of "${field}"`).toBe(false);
    }
  });

  it("CreatePullRequestInputV1 (v1 implements GitHubForgeBackend) still rejects GitHub-shaped fields", () => {
    const validate = ajv.compile(CreatePullRequestInputV1);
    const base = {
      schemaVersion: 1,
      repositoryId: "repository-1",
      sourceBranch: "feature",
      targetBranch: "main",
      title: "Title",
      body: "Body",
      draft: false,
    };
    expect(validate(base)).toBe(true);
    expect(validate({ ...base, node_id: "MDEwOlJlcG9zaXRvcnk=" })).toBe(false);
    expect(validate({ ...base, mergeable_state: "clean" })).toBe(false);
  });
});
