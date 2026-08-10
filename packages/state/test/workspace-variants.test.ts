import { rm } from "node:fs/promises";
import type { WorkspaceId, WorkspaceVariantId, WorkspaceVariantManifest } from "@heniek/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { commitStateChange } from "../src/command/commit.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createWorkspaceVariantStateStore } from "../src/workspace/variant-store.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

let directory = "";
let db: StateDatabase | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const temporary = await makeTempDbPath();
  directory = temporary.directory;
  db = openStateDatabase({
    path: temporary.path,
    clock: createFakeClock(),
    ids: createDeterministicIds(1),
  });
  runMigrations(db);
  commitStateChange(db, { type: "codebase.registered", payload: { codebaseId: "cb_test" } });
  commitStateChange(db, {
    type: "workspace.registered",
    payload: { workspaceId: "ws_test", codebaseId: "cb_test" },
  });
  return db;
}

function manifest(lifecycle: WorkspaceVariantManifest["lifecycle"]): WorkspaceVariantManifest {
  return {
    schemaVersion: 1,
    workspaceId: "ws_test" as WorkspaceId,
    variantId: "variant_test" as WorkspaceVariantId,
    strategy: "manual",
    lifecycle,
    variantRoot: "/tmp/workspaces/ws_test/variants/variant_test",
    repositories: [
      {
        repositoryId:
          "repo_test" as WorkspaceVariantManifest["repositories"][number]["repositoryId"],
        name: "repo",
        access: "write",
        materialization: "worktree",
        checkoutPath: "/tmp/variant/repo",
        sourceCheckoutPath: "/tmp/source/repo",
        targetRef: "refs/heads/main",
        expectedTargetSha: "a".repeat(40),
        observedHeadSha: "a".repeat(40),
        leaseId: "lease_1",
        readOnlyBaseline: null,
        phase: "ready",
        candidateSha: null,
        resultSha: null,
      },
    ],
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
  };
}

describe("Q036 workspace variant state", () => {
  it("persists revisioned manifests and append-only integration traces", async () => {
    const database = await fixture();
    const store = createWorkspaceVariantStateStore(database);
    await store.record(manifest("ready"));
    await store.record({ ...manifest("prepared"), updatedAt: "2026-08-10T12:01:00.000Z" });
    await store.append({
      schemaVersion: 1,
      workspaceId: "ws_test" as WorkspaceId,
      variantId: "variant_test" as WorkspaceVariantId,
      sequence: 1,
      repositoryId: null,
      phase: "intent-recorded",
      expectedSha: null,
      observedSha: null,
      candidateSha: null,
      classification: null,
      recordedAt: "2026-08-10T12:01:00.000Z",
    });
    expect(
      (await store.load("ws_test" as WorkspaceId, "variant_test" as WorkspaceVariantId))?.lifecycle,
    ).toBe("prepared");
    expect(store.list("ws_test" as WorkspaceId)).toHaveLength(1);
    expect(store.traces("variant_test" as WorkspaceVariantId)).toHaveLength(1);
    expect(() =>
      internalHandle(database).exec("DELETE FROM workspace_variant_integration_trace"),
    ).toThrow(/immutable/);
  });
});
