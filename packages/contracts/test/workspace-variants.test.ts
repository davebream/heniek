import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  VariantIntegrationRequestV1,
  VariantIntegrationResultV1,
  VariantIntegrationTraceV1,
  WorkspaceVariantManifestV1,
} from "../src/index.js";

const now = "2026-08-10T12:00:00.000Z";
const sha = "a".repeat(40);

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)));
}

describe("Q036 workspace variant contracts", () => {
  it("registers additive v1 contract ids and validates a complete inventory", () => {
    expect(WorkspaceVariantManifestV1.$id).toBe("heniek://contract/WorkspaceVariantManifest/v1");
    expect(VariantIntegrationRequestV1.$id).toBe("heniek://contract/VariantIntegrationRequest/v1");
    expect(VariantIntegrationResultV1.$id).toBe("heniek://contract/VariantIntegrationResult/v1");
    expect(VariantIntegrationTraceV1.$id).toBe("heniek://contract/VariantIntegrationTrace/v1");
    expect(
      Value.Check(WorkspaceVariantManifestV1, {
        schemaVersion: 1,
        workspaceId: "ws_test",
        variantId: "variant_test",
        strategy: "select-best",
        lifecycle: "ready",
        variantRoot: "/tmp/variants/variant_test",
        repositories: [
          {
            repositoryId: "repo_test",
            name: "repo",
            access: "write",
            materialization: "worktree",
            checkoutPath: "/tmp/variants/variant_test/repo",
            sourceCheckoutPath: "/tmp/source/repo",
            targetRef: "refs/heads/main",
            expectedTargetSha: sha,
            observedHeadSha: sha,
            leaseId: "lease_test",
            readOnlyBaseline: null,
            phase: "ready",
            candidateSha: null,
            resultSha: null,
          },
        ],
        createdAt: now,
        updatedAt: now,
      }),
    ).toBe(true);
  });

  it("rejects unversioned requests and unknown integration strategies", () => {
    expect(
      Value.Check(VariantIntegrationRequestV1, {
        workspaceId: "ws_test",
        variantId: "variant_test",
        strategy: "automatic",
        requestedAt: now,
      }),
    ).toBe(false);
  });
});
