import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  CodebaseConfigurationV1,
  RepositoryBasePinV1,
  RepositoryProvisioningConfigurationV1,
  ResolvedCodebaseSnapshotV1,
  SCHEMA_REGISTRY,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
for (const schema of SCHEMA_REGISTRY.values()) ajv.addSchema(schema);

function validate(schema: { readonly $id?: string }, value: unknown): boolean {
  const validator = schema.$id === undefined ? undefined : ajv.getSchema(schema.$id);
  if (validator === undefined) throw new Error("schema was not registered");
  return validator(value) as boolean;
}

describe("Q034 Codebase configuration contracts", () => {
  it.each([
    {
      strategy: "managed-worktree",
      remote: "origin",
      requestedRef: "auto",
      synchronization: "notify",
    },
    { strategy: "current-checkout" },
    { strategy: "existing-checkout", checkoutPath: "/workspace/existing" },
    { strategy: "custom", command: "bin/provision" },
  ])("accepts $strategy provisioning", (configuration) => {
    expect(
      validate(RepositoryProvisioningConfigurationV1, {
        schemaVersion: 1,
        configuration,
      }),
    ).toBe(true);
  });

  it("rejects strategy-specific fields that are missing or cross-contaminated", () => {
    expect(
      validate(RepositoryProvisioningConfigurationV1, {
        schemaVersion: 1,
        configuration: { strategy: "managed-worktree", remote: "origin" },
      }),
    ).toBe(false);
    expect(
      validate(RepositoryProvisioningConfigurationV1, {
        schemaVersion: 1,
        configuration: { strategy: "current-checkout", checkoutPath: "/tmp/repo" },
      }),
    ).toBe(false);
    expect(
      validate(RepositoryProvisioningConfigurationV1, {
        schemaVersion: 1,
        configuration: { strategy: "existing-checkout", checkoutPath: "relative/path" },
      }),
    ).toBe(false);
  });

  it("validates keyed multi-root configuration, base pins, and resolved snapshots", () => {
    const configuration = {
      schemaVersion: 1,
      codebaseId: "cb-1",
      repositories: {
        "repo-1": {
          expectedPath: "/workspace/api",
          provisioning: {
            strategy: "managed-worktree",
            remote: "origin",
            requestedRef: "main",
            synchronization: "pinned",
          },
          setup: "pnpm install",
        },
      },
    };
    const pin = {
      schemaVersion: 1,
      repositoryId: "repo-1",
      requestedRef: "main",
      resolvedRef: "refs/heads/main",
      remote: "origin",
      fetchedRemoteIdentity: "ssh://git@example.test/acme/api",
      commitSha: "a".repeat(40),
      resolvedAt: "2026-08-10T12:00:00.000Z",
      synchronization: "pinned",
    };
    expect(validate(CodebaseConfigurationV1, configuration)).toBe(true);
    expect(validate(RepositoryBasePinV1, pin)).toBe(true);
    expect(
      validate(ResolvedCodebaseSnapshotV1, {
        schemaVersion: 1,
        codebaseId: "cb-1",
        registrationSha256: "b".repeat(64),
        configurationSha256: "c".repeat(64),
        resolvedAt: "2026-08-10T12:00:01.000Z",
        repositories: [
          {
            repositoryId: "repo-1",
            name: "api",
            path: "/workspace/api",
            provisioning: configuration.repositories["repo-1"].provisioning,
            setup: "pnpm install",
            provenance: [
              {
                layer: "codebase",
                sourcePath: "/config/workspace.yaml",
                pointer: "/repositories/repo-1/setup",
              },
            ],
          },
        ],
        basePins: [pin],
      }),
    ).toBe(true);
  });
});
