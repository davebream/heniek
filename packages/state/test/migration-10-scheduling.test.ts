import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assignBackendExecution,
  commitStateChange,
  createStageExecution,
  openStateDatabase,
  readExecutionAttempts,
  readExecutionSchedule,
  runMigrations,
  type StateDatabase,
  updateStageExecutionStatus,
} from "../src/index.js";
import { MIGRATIONS } from "../src/migrations/list.js";
import { currentSchemaVersion, runMigrationList } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const HASH = "c".repeat(64);
let directory: string;
let db: StateDatabase;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  db = openStateDatabase({
    path: temp.path,
    clock: createFakeClock(Date.parse("2026-08-08T12:00:00.000Z")),
    ids: createDeterministicIds(10),
  });
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("Q021 migration 10", () => {
  it("backfills an active V9 execution as a conservative legacy attempt and replays safely", () => {
    runMigrationList(db, MIGRATIONS, 9);
    commitStateChange(db, {
      type: "codebase.registration_committed",
      payload: {
        registration: {
          codebaseId: "codebase-m10",
          configurationSha256: HASH,
          instructionSnapshot: {},
          name: "migration-10",
          repositories: [
            {
              defaultBranch: "main",
              defaultRemote: "origin",
              gitCommonDirectory: "/tmp/m10/.git",
              name: "migration-10",
              path: "/tmp/m10",
              remotes: [],
              repositoryId: "repository-m10",
            },
          ],
          rootPath: "/tmp/m10",
          topologySha256: HASH,
        },
      },
    });
    commitStateChange(db, {
      type: "workspace.registered",
      payload: { workspaceId: "workspace-m10", codebaseId: "codebase-m10" },
    });
    commitStateChange(db, {
      runId: "run-m10",
      type: "run.created",
      payload: { runId: "run-m10", codebaseId: "codebase-m10" },
    });
    createStageExecution(db, {
      runId: "run-m10",
      stageId: "stage-m10",
      codebaseId: "codebase-m10",
      repositoryId: "repository-m10",
      workspaceId: "workspace-m10",
      backendKind: "claudexor-v2",
      prompt: "Continue after migration.",
      artifactPath: "artifacts/result.md",
      limits: {},
    });
    assignBackendExecution(db, "run-m10", "backend-m10");
    updateStageExecutionStatus(db, "run-m10", "running");

    expect(runMigrations(db)).toMatchObject({
      fromVersion: 9,
      toVersion: currentSchemaVersion(),
    });
    expect(readExecutionSchedule(db, "run-m10")).toMatchObject({
      state: "running",
      capacityPolicy: "queue",
      currentAttemptId: "legacy-attempt:run-m10",
    });
    expect(readExecutionAttempts(db, "run-m10")).toMatchObject([
      {
        attemptId: "legacy-attempt:run-m10",
        profileId: "legacy",
        accountId: "legacy-claudexor-v2",
        backendExecutionId: "backend-m10",
        status: "running",
      },
    ]);
    expect(runMigrations(db).applied).toEqual([]);
  });
});
