import { createRequire } from "node:module";
import { Ajv, type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import {
  CreatePullRequestInputV1,
  ExecutionResultV1,
  NativeStageDispatchV1,
  NativeStageSubmitRequestV1,
  ParentSessionAttachmentV1,
  RunV1,
  SCHEMA_REGISTRY,
} from "../src/index.js";

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

  /**
   * The native bridge is the one surface where a provider name would be most
   * tempting — it exists to carry work to a Claude parent session. These
   * assertions pin that the contracts stayed provider-neutral anyway.
   */
  it("the native bridge contracts reject provider-shaped fields", () => {
    const validate = validatorFor(ParentSessionAttachmentV1);
    expect(validate(VALID_ATTACHMENT)).toBe(true);
    for (const [field, value] of Object.entries(providerShapedFields)) {
      expect(
        validate({ ...VALID_ATTACHMENT, [field]: value }),
        `expected rejection of "${field}"`,
      ).toBe(false);
    }
  });
});

/**
 * A second Ajv instance carrying the whole registry, because the native
 * bridge contracts embed shared schemas by `$ref` (`ExecutionPermissionEnvelope`,
 * `ExternalStageResult`, `PendingInteraction`, ...) rather than inlining
 * copies of them, and a bare `ajv.compile()` cannot resolve those.
 */
const refAjv = new Ajv({ strict: true, allErrors: true });
addFormats(refAjv);
for (const schema of SCHEMA_REGISTRY.values()) {
  refAjv.addSchema(schema);
}

/**
 * Resolves a registered contract through the ref-aware instance. TypeBox
 * types `$id` as optional, so this also asserts the thing `versioned()`
 * guarantees: every registered contract has one.
 */
function validatorFor(schema: { readonly $id?: string }): ValidateFunction {
  const schemaId = schema.$id;
  if (schemaId === undefined) {
    throw new Error("a registered contract schema is missing its $id");
  }
  const validate = refAjv.getSchema(schemaId);
  if (validate === undefined) {
    throw new Error(`${schemaId} is in the registry but did not resolve`);
  }
  return validate;
}

const VALID_ATTACHMENT = {
  schemaVersion: 1,
  sessionId: "session-1",
  sessionRevision: 1,
  codebaseId: "codebase-1",
  attachedAt: "2026-08-08T12:00:00.000Z",
  expiresAt: "2026-08-08T12:01:30.000Z",
  leaseTtlMs: 90_000,
  maxDispatches: 4,
  pollAfterMs: 1_000,
  resumedDispatchIds: [],
};

const VALID_DISPATCH = {
  schemaVersion: 1,
  dispatchId: "dispatch-1",
  dispatchRevision: 1,
  runId: "run-1",
  stageId: "stage-1",
  attemptId: "attempt-1",
  attemptOrdinal: 1,
  workspaceId: "workspace-1",
  workingDirectory: "/managed/checkout",
  instructionsPath: "docs/instructions.md",
  prompt: "Do the thing.",
  artifactPath: "out/result.json",
  artifactContract: "heniek://contract/ExternalStageResult/v1",
  model: "opus",
  effort: "high",
  questions: "parent-mediated",
  permissions: { schemaVersion: 1, workspace: "read-only", identifiers: [] },
  limits: { maxDurationMs: 600_000 },
  issuedAt: "2026-08-08T12:00:00.000Z",
  expiresAt: "2026-08-08T12:01:30.000Z",
};

describe("native bridge dispatch path safety", () => {
  /**
   * The daemon resolves the submitted artifact *relative to the worktree it
   * assigned*, so a dispatch that could name an absolute or escaping path
   * would be a write primitive pointed anywhere on the host. The constraint
   * belongs on the contract, not only in the service that reads it.
   */
  it("rejects absolute, escaping and NUL-bearing declared paths", () => {
    const validate = validatorFor(NativeStageDispatchV1);
    expect(validate(VALID_DISPATCH)).toBe(true);

    for (const field of ["artifactPath", "instructionsPath"] as const) {
      for (const value of [
        "/etc/passwd",
        "../outside.json",
        "nested/../../outside.json",
        "trailing/..",
        "with\u0000nul.json",
      ]) {
        expect(
          validate({ ...VALID_DISPATCH, [field]: value }),
          `expected rejection of ${field}=${JSON.stringify(value)}`,
        ).toBe(false);
      }
    }
  });
});

describe("native bridge submission fencing", () => {
  /**
   * Every field of the fencing tuple is required. Making any one of them
   * optional would let a caller omit it and have the daemon fall back to
   * "whatever is current", which is precisely the acceptance criterion this
   * contract exists to make unreachable.
   */
  it("requires the full session/dispatch/run/stage/attempt tuple", () => {
    const validate = validatorFor(NativeStageSubmitRequestV1);
    const base = {
      schemaVersion: 1,
      sessionId: "session-1",
      sessionRevision: 1,
      dispatchId: "dispatch-1",
      expectedDispatchRevision: 1,
      runId: "run-1",
      stageId: "stage-1",
      attemptId: "attempt-1",
      submissionId: "submission-1",
      outcome: "succeeded",
      result: { schemaVersion: 1, summary: "done", artifactPath: "out/result.json" },
    };
    expect(validate(base)).toBe(true);

    for (const field of [
      "sessionId",
      "sessionRevision",
      "dispatchId",
      "expectedDispatchRevision",
      "runId",
      "stageId",
      "attemptId",
      "submissionId",
    ] as const) {
      const { [field]: _omitted, ...withoutField } = base;
      expect(validate(withoutField), `expected "${field}" to be required`).toBe(false);
    }
  });

  it("rejects a result whose declared artifact path escapes the worktree", () => {
    const validate = validatorFor(NativeStageSubmitRequestV1);
    const base = {
      schemaVersion: 1,
      sessionId: "session-1",
      sessionRevision: 1,
      dispatchId: "dispatch-1",
      expectedDispatchRevision: 1,
      runId: "run-1",
      stageId: "stage-1",
      attemptId: "attempt-1",
      submissionId: "submission-1",
      outcome: "succeeded",
    };
    expect(
      validate({
        ...base,
        result: { schemaVersion: 1, summary: "done", artifactPath: "../escape.json" },
      }),
    ).toBe(false);
  });
});
