import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  CreateOrAdoptBranchInputV1,
  CreateOrAdoptIssueInputV1,
  CreatePullRequestInputV1,
  CreatePullRequestInputV2,
  ForgeIssueV1,
  ForgeRefV1,
  PullRequestStatusV1,
  PullRequestV1,
  PullRequestV2,
  SCHEMA_REGISTRY,
  UpdateBranchInputV1,
  UpdateIssueInputV1,
  UpdatePullRequestInputV1,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
for (const schema of SCHEMA_REGISTRY.values()) ajv.addSchema(schema);

function validate(schema: { readonly $id?: string }, value: unknown): boolean {
  const validator = schema.$id === undefined ? undefined : ajv.getSchema(schema.$id);
  if (validator === undefined)
    throw new Error(`schema ${schema.$id ?? "unknown"} was not registered`);
  return validator(value) as boolean;
}

const repositoryId = "repository-1";
const observedVersion = `sha256:${"a".repeat(64)}`;

describe("Q047 forge contracts", () => {
  it("keeps V1 pull-request contracts valid and introduces V2 additively", () => {
    const v1Input = {
      schemaVersion: 1,
      repositoryId,
      sourceBranch: "feature",
      targetBranch: "main",
      title: "Title",
      body: "Body",
      draft: false,
    };
    const v1PullRequest = {
      schemaVersion: 1,
      pullRequestId: "pull-request-1",
      repositoryId,
      number: 1,
      url: "https://forge.example/pull/1",
      state: "open",
      draft: false,
      headSha: "head-sha",
    };
    expect(validate(CreatePullRequestInputV1, v1Input)).toBe(true);
    expect(validate(PullRequestV1, v1PullRequest)).toBe(true);
    expect(
      validate(CreatePullRequestInputV2, {
        ...v1Input,
        schemaVersion: 2,
        draft: undefined,
        expectedHeadSha: "head-sha",
        idempotencyKey: "delivery-1",
      }),
    ).toBe(true);
  });

  it("validates provider-neutral issue, ref, PR, and status observations", () => {
    expect(
      validate(ForgeIssueV1, {
        schemaVersion: 1,
        issueId: "issue-node-1",
        repositoryId,
        number: 63,
        url: "https://forge.example/issues/63",
        title: "Q047",
        body: "Forge primitives",
        state: "open",
        labels: ["capability"],
        linkageDigest: "b".repeat(64),
        observedVersion,
      }),
    ).toBe(true);
    expect(
      validate(ForgeRefV1, {
        schemaVersion: 1,
        forgeRefId: "ref-node-1",
        repositoryId,
        qualifiedRef: "refs/heads/q047",
        url: "https://forge.example/tree/q047",
        headSha: "head-sha",
        observedVersion,
      }),
    ).toBe(true);
    const pullRequest = {
      schemaVersion: 2,
      pullRequestId: "pull-request-1",
      repositoryId,
      number: 1,
      url: "https://forge.example/pull/1",
      state: "open",
      draft: true,
      sourceBranch: "q047",
      targetBranch: "main",
      baseSha: "base-sha",
      headSha: "head-sha",
      autoMergeEnabled: false,
      observedVersion,
    };
    expect(validate(PullRequestV2, pullRequest)).toBe(true);
    expect(
      validate(PullRequestStatusV1, {
        schemaVersion: 1,
        pullRequestId: "pull-request-1",
        mergeability: "unknown",
        mergeState: "blocked",
        checks: [],
        totalCount: 0,
        requiredCount: 0,
        succeededCount: 0,
        failedCount: 0,
        pendingCount: 0,
        observedVersion: `sha256:${"c".repeat(64)}`,
      }),
    ).toBe(true);
  });

  it("requires explicit fencing on every update primitive", () => {
    expect(
      validate(UpdateIssueInputV1, {
        schemaVersion: 1,
        repositoryId,
        number: 63,
        expectedObservedVersion: observedVersion,
        patch: { state: "closed" },
      }),
    ).toBe(true);
    expect(
      validate(UpdateBranchInputV1, {
        schemaVersion: 1,
        repositoryId,
        branchName: "q047",
        expectedHeadSha: "before",
        targetHeadSha: "after",
      }),
    ).toBe(true);
    expect(
      validate(UpdatePullRequestInputV1, {
        schemaVersion: 1,
        pullRequestId: "pull-request-1",
        expectedObservedVersion: observedVersion,
        expectedHeadSha: "head-sha",
        draft: false,
      }),
    ).toBe(true);
    expect(
      validate(UpdateBranchInputV1, {
        schemaVersion: 1,
        repositoryId,
        branchName: "q047",
        targetHeadSha: "after",
      }),
    ).toBe(false);
  });

  it("rejects GitHub-shaped fields at the provider-neutral boundary", () => {
    const schemasAndValues: readonly [object, Record<string, unknown>][] = [
      [
        CreateOrAdoptIssueInputV1,
        {
          schemaVersion: 1,
          repositoryId,
          title: "Title",
          body: "Body",
          idempotencyKey: "issue-1",
        },
      ],
      [
        CreateOrAdoptBranchInputV1,
        { schemaVersion: 1, repositoryId, branchName: "q047", targetSha: "head-sha" },
      ],
      [
        CreatePullRequestInputV2,
        {
          schemaVersion: 2,
          repositoryId,
          sourceBranch: "q047",
          targetBranch: "main",
          title: "Title",
          body: "Body",
          expectedHeadSha: "head-sha",
          idempotencyKey: "pull-request-1",
        },
      ],
    ];
    for (const [schema, value] of schemasAndValues) {
      expect(validate(schema, value)).toBe(true);
      expect(validate(schema, { ...value, githubNodeId: "github-specific" })).toBe(false);
      expect(validate(schema, { ...value, mergeable_state: "clean" })).toBe(false);
    }
  });
});
